import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getAdminSupabase } from './server-admin';

type User = { id: string; email?: string | null };
export type AdminRole = 'owner' | 'verification' | 'content' | 'support' | 'billing';

const rolePermissions: Record<AdminRole, string[]> = {
  owner: ['*', 'identity'],
  verification: ['identity', 'verification.read', 'verification.write'],
  content: ['identity', 'content.read', 'content.write'],
  support: ['identity', 'creators.read', 'creators.write', 'stores.read', 'stores.write', 'orders.read', 'refunds.read', 'refunds.write', 'disputes.read', 'disputes.write', 'reports.read', 'reports.write'],
  billing: ['identity', 'subscriptions.read', 'access-grants.read', 'access-grants.write'],
};

const buckets = new Map<string, { count: number; resetAt: number }>();
let verifier: SupabaseClient | null | undefined;

function getAuthVerifier(): SupabaseClient {
  if (verifier) return verifier;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  if (!url || !key) throw new Error('Supabase authentication is not configured.');
  verifier = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return verifier;
}

export function getClientIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

export function rateLimit(request: Request, name: string, limit = 60, windowMs = 60_000) {
  const key = `${name}:${getClientIp(request)}`;
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: Math.max(0, limit - 1), retryAfter: Math.ceil(windowMs / 1000) };
  }
  current.count += 1;
  if (current.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: limit - current.count, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
}

export function withRateLimit(request: Request, name: string, limit = 60) {
  const result = rateLimit(request, name, limit);
  if (!result.ok) {
    return new Response(JSON.stringify({ ok: false, error: 'Too many requests. Try again later.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(result.retryAfter) },
    });
  }
  return null;
}

export async function getBearerUser(request: Request): Promise<User | null> {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const authClient = getAuthVerifier();
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email };
}

export async function requireAdmin(request: Request, permission = '*') {
  const user = await getBearerUser(request);
  if (!user) throw new Error('Unauthorized');
  const configuredEmails = (process.env.SELLORA_ADMIN_EMAILS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  const configuredUserIds = (process.env.SELLORA_ADMIN_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  const emailAllowed = typeof user.email === 'string' && configuredEmails.includes(user.email.toLowerCase());
  const idAllowed = configuredUserIds.includes(user.id);
  if (emailAllowed || idAllowed) return { ...user, role: 'owner' as AdminRole };

  const admin = getAdminSupabase();
  const email = user.email?.toLowerCase() || '';
  const { data: staff, error } = await admin.from('admin_staff')
    .select('role,active')
    .or(`user_id.eq.${user.id},email.ilike.${email}`)
    .eq('active', true)
    .maybeSingle();
  if (error || !staff) throw new Error('Forbidden');
  const role = staff.role as AdminRole;
  if (!rolePermissions[role] || (permission !== '*' && !rolePermissions[role].includes('*') && !rolePermissions[role].includes(permission))) throw new Error('Forbidden');
  return { ...user, role };
}

export function adminPermissionForSection(section: string) {
  if (section === 'verification' || section === 'badge-requests' || section === 'product-review-detail') return 'verification.read';
  if (section === 'content') return 'content.read';
  if (section === 'subscriptions') return 'subscriptions.read';
  if (section === 'access-grants') return 'access-grants.read';
  if (['creators', 'stores', 'orders', 'refunds', 'disputes', 'reports'].includes(section)) return `${section}.read`;
  return '*';
}

export function adminPermissionForAction(action: string) {
  if (['save_public_content', 'publish_public_content', 'unpublish_public_content'].includes(action)) return 'content.write';
  if (['set_verification', 'set_product_verification'].includes(action)) return 'verification.write';
  if (['set_creator_status', 'set_store_status'].includes(action)) return action.startsWith('set_creator') ? 'creators.write' : 'stores.write';
  if (['refund'].includes(action)) return 'refunds.write';
  if (['set_dispute', 'resolve_report'].includes(action)) return action.startsWith('set_dispute') ? 'disputes.write' : 'reports.write';
  if (['sync_subscription', 'admin_resume_subscription', 'admin_cancel_subscription'].includes(action)) return 'subscriptions.write';
  if (['invite_staff', 'update_staff', 'remove_staff'].includes(action)) return 'staff.write';
  if (['invite_or_grant_creator', 'revoke_creator_access'].includes(action)) return 'access-grants.write';
  return '*';
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) return;

  let appUrlObj: URL;
  let requestOrigin: URL;
  try {
    appUrlObj = new URL(appUrl);
    requestOrigin = new URL(origin);
  } catch {
    // Ignore malformed env/origin values so stale local-only config does not block legitimate requests.
    return;
  }

  const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(requestOrigin.hostname) || requestOrigin.hostname.endsWith('.local') || requestOrigin.hostname.endsWith('.localhost');
  const isLocalAppUrl = ['localhost', '127.0.0.1', '[::1]'].includes(appUrlObj.hostname) || appUrlObj.hostname.endsWith('.local') || appUrlObj.hostname.endsWith('.localhost');

  // Local development requests are allowed even if the configured public app URL points to production.
  if (isLocalHost || isLocalAppUrl) return;
  if (appUrlObj.origin !== requestOrigin.origin) throw new Error('Invalid request origin.');
}

export function safeDigest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function safeTokenEqual(a: string, b: string) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export async function writeAudit(input: {
  actorUserId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}) {
  const admin = getAdminSupabase();
  const { error } = await admin.from('audit_logs').insert({
    actor_user_id: input.actorUserId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId || null,
    before_data: input.before ?? null,
    after_data: input.after ?? null,
    metadata: input.metadata || {},
    ip_address: input.ip || null,
  });
  if (error) console.error('[audit]', error);
}
