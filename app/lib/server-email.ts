import { getCheckoutPath } from './public-paths';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getAdminSupabase } from './server-admin';
import { orderAccessUrl } from './server-access';
import { getAppBaseUrl } from './site';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} server environment variable.`);
  return value;
}

function marketingSecret() {
  const value = process.env.SELLORA_ACCESS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.RESEND_API_KEY;
  if (!value) throw new Error('SELLORA_ACCESS_SECRET is not configured.');
  return value;
}

function signPayload(payload: string) {
  return createHmac('sha256', marketingSecret()).update(payload).digest('base64url');
}

export function createSignedMarketingToken(payload: Record<string, string | number | null | undefined>) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = signPayload(encoded);
  return `${encoded}.${signature}`;
}

export function verifySignedMarketingToken(token: string | null, expectedKind?: string) {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = signPayload(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof data.kind === 'string' && expectedKind && data.kind !== expectedKind) return null;
    if (typeof data.exp === 'number' && data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function createTrackingClickUrl(recipientId: string, subscriberId: string, targetUrl: string) {
  const token = createSignedMarketingToken({ kind: 'click', recipientId, subscriberId, url: targetUrl, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
  return `${getAppBaseUrl()}/api/marketing/track/click?token=${encodeURIComponent(token)}&url=${encodeURIComponent(targetUrl)}`;
}

export function createTrackingOpenUrl(recipientId: string, subscriberId: string) {
  const token = createSignedMarketingToken({ kind: 'open', recipientId, subscriberId, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 });
  return `${getAppBaseUrl()}/api/marketing/track/open?token=${encodeURIComponent(token)}`;
}

export function createUnsubscribeUrl(subscriberId: string, storeId: string) {
  const token = createSignedMarketingToken({ kind: 'unsubscribe', subscriberId, storeId, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 });
  return `${getAppBaseUrl()}/api/marketing/unsubscribe?token=${encodeURIComponent(token)}`;
}

export async function sendMarketingEmail(to: string, subject: string, html: string, campaignId: string, recipientId: string) {
  return sendEmail(to, subject, html, { eventType: 'marketing.broadcast', templateKey: 'marketing_campaign', idempotencyKey: `campaign-recipient:${recipientId}`, entityType: 'email_campaign_recipient', entityId: recipientId, metadata: { campaignId, recipientId } });
}

function marketingMarkup(content: string, recipientId: string, subscriberId: string, storeId: string) {
  const tracked = content.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (_match, href) => `href="${createTrackingClickUrl(recipientId, subscriberId, href)}"`);
  return `${tracked}<p style="font-size:12px;color:#777;margin-top:28px"><a href="${createUnsubscribeUrl(subscriberId, storeId)}">Unsubscribe</a></p><img src="${createTrackingOpenUrl(recipientId, subscriberId)}" width="1" height="1" alt="" />`;
}

const SEGMENT_OPERATORS = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'after', 'before', 'exists', 'not_exists']);
const SEGMENT_FIELDS = new Set(['status', 'tags', 'source', 'product_purchased', 'has_purchased', 'purchase_count', 'total_spent', 'last_purchase_date', 'signup_date', 'email_engagement']);

type SegmentValidation =
  | { valid: true; normalized: { connector: 'AND' | 'OR'; conditions: Record<string, unknown>[] } }
  | { valid: false; message: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => normalizeValue(entry));
  if (value === null || value === undefined) return null;
  return String(value);
}

function compareScalar(left: string | number | boolean | string[] | null | undefined, operator: string, value: unknown): boolean {
  const right = normalizeValue(value);
  const leftValues = Array.isArray(left) ? left.map((entry) => normalizeValue(entry)) : [left];

  switch (operator) {
    case 'equals': return leftValues.some((entry) => entry === right);
    case 'not_equals': return leftValues.every((entry) => entry !== right);
    case 'contains': {
      if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase().includes(right.toLowerCase());
      if (Array.isArray(left)) return left.some((entry) => typeof entry === 'string' && typeof right === 'string' && entry.toLowerCase().includes(right.toLowerCase()));
      return false;
    }
    case 'not_contains': {
      if (typeof left === 'string' && typeof right === 'string') return !left.toLowerCase().includes(right.toLowerCase());
      return true;
    }
    case 'in': {
      if (Array.isArray(right)) return leftValues.some((entry) => right.some((candidate) => normalizeValue(candidate) === entry));
      return leftValues.some((entry) => entry === right);
    }
    case 'not_in': {
      if (Array.isArray(right)) return leftValues.every((entry) => !right.some((candidate) => normalizeValue(candidate) === entry));
      return leftValues.every((entry) => entry !== right);
    }
    case 'gt': return typeof left === 'number' && typeof right === 'number' ? left > right : false;
    case 'gte': return typeof left === 'number' && typeof right === 'number' ? left >= right : false;
    case 'lt': return typeof left === 'number' && typeof right === 'number' ? left < right : false;
    case 'lte': return typeof left === 'number' && typeof right === 'number' ? left <= right : false;
    case 'exists': return left != null && left !== '' && left !== false;
    case 'not_exists': return left == null || left === '' || left === false;
    case 'after': {
      if (left == null || right == null || typeof left !== 'string' || typeof right !== 'string') return false;
      return new Date(left).getTime() > new Date(right).getTime();
    }
    case 'before': {
      if (left == null || right == null || typeof left !== 'string' || typeof right !== 'string') return false;
      return new Date(left).getTime() < new Date(right).getTime();
    }
    default: return false;
  }
}

export function validateSegmentDefinition(definition: unknown): SegmentValidation {
  if (!isPlainObject(definition)) return { valid: false, message: 'Segment definition must be an object.' };
  const root = definition as Record<string, unknown>;
  const conditions = Array.isArray(root.conditions) ? (root.conditions as Record<string, unknown>[]) : [];
  const connector = root.connector === 'OR' ? 'OR' : 'AND';
  if (!conditions.length) return { valid: true, normalized: { connector, conditions: [] } };

  const walk = (value: unknown, path = 'root'): SegmentValidation => {
    if (!isPlainObject(value)) return { valid: false, message: `Invalid condition at ${path}.` };
    if (value.type === 'group') {
      const nested = Array.isArray(value.conditions) ? value.conditions : [];
      for (let index = 0; index < nested.length; index += 1) {
        const result = walk(nested[index], `${path}.conditions[${index}]`);
        if (!result.valid) return result;
      }
      if (value.connector && value.connector !== 'AND' && value.connector !== 'OR') return { valid: false, message: `Unsupported group connector at ${path}.` };
      return { valid: true, normalized: { connector: 'AND', conditions: [] } };
    }

    const operator = typeof value.operator === 'string' ? value.operator : '';
    const field = typeof value.field === 'string' ? value.field : '';
    if (!SEGMENT_FIELDS.has(field)) return { valid: false, message: `Unsupported field at ${path}: ${field || 'missing'}` };
    if (!SEGMENT_OPERATORS.has(operator)) return { valid: false, message: `Unsupported operator at ${path}: ${operator || 'missing'}` };
    return { valid: true, normalized: { connector: 'AND', conditions: [] } };
  };

  for (let index = 0; index < conditions.length; index += 1) {
    const result = walk(conditions[index], `conditions[${index}]`);
    if (!result.valid) return result;
  }

  return { valid: true, normalized: { connector, conditions } };
}

export async function evaluateSegment(storeId: string, definition: Record<string, unknown>, db: any) {
  const validation = validateSegmentDefinition(definition);
  if (!validation.valid) return { ok: false, error: validation.message || 'Segment definition is invalid.' };

  const normalizedDefinition = validation.normalized;
  const { data: subscribers, error: subscriberError } = await db.from('email_subscribers').select('id,email,status,source,created_at,last_seen_at').eq('store_id', storeId).order('created_at', { ascending: false });
  if (subscriberError) throw subscriberError;

  const tagsMap = new Map<string, Set<string>>();
  const tagMembers = await db.from('email_subscriber_tag_members').select('subscriber_id, tag_id');
  const relevantTagIds = tagMembers && tagMembers.data ? tagMembers.data.map((row: any) => row.tag_id) : [];
  const tagNameMap = new Map<string, string>();
  if (relevantTagIds.length) {
    const { data: tagMeta } = await db.from('email_subscriber_tags').select('id,name').in('id', relevantTagIds);
    (tagMeta || []).forEach((row: any) => tagNameMap.set(String(row.id), String(row.name)));
  }
  for (const row of tagMembers?.data || []) {
    const key = String(row.subscriber_id);
    const names = tagsMap.get(key) || new Set<string>();
    const tagName = tagNameMap.get(String(row.tag_id));
    if (tagName) names.add(tagName);
    tagsMap.set(key, names);
  }

  const orderRows = await db.from('orders').select('id,store_id,buyer_email,gross_amount,status,created_at,product_id').eq('store_id', storeId).eq('status', 'paid');
  const spentMap = new Map<string, number>();
  const purchaseCounts = new Map<string, number>();
  const lastPurchaseMap = new Map<string, string>();
  const purchasedProducts = new Map<string, Set<string>>();
  for (const row of orderRows.data || []) {
    const key = String((row.buyer_email || '').trim().toLowerCase());
    const amount = Number(row.gross_amount || 0);
    purchaseCounts.set(key, (purchaseCounts.get(key) || 0) + 1);
    spentMap.set(key, (spentMap.get(key) || 0) + amount);
    const existing = lastPurchaseMap.get(key) || String(row.created_at || '');
    if (!existing || new Date(String(row.created_at || '')).getTime() > new Date(existing).getTime()) lastPurchaseMap.set(key, String(row.created_at || ''));
    const productSet = purchasedProducts.get(key) || new Set<string>();
    const productName = row.product_id ? String(row.product_id) : 'product';
    productSet.add(productName);
    purchasedProducts.set(key, productSet);
  }

  const campaignRows = await db.from('email_campaign_recipients').select('campaign_id,subscriber_id,opened_at,clicked_at,status');
  const openedBySubscriber = new Map<string, number>();
  const clickedBySubscriber = new Map<string, number>();
  if (campaignRows.data && campaignRows.data.length) {
    for (const row of campaignRows.data) {
      const key = String(row.subscriber_id);
      if (row.opened_at) openedBySubscriber.set(key, (openedBySubscriber.get(key) || 0) + 1);
      if (row.clicked_at) clickedBySubscriber.set(key, (clickedBySubscriber.get(key) || 0) + 1);
    }
  }

  const eligible = (subscribers || []).filter((subscriber: any) => {
    const emailKey = String(subscriber.email || '').trim().toLowerCase();
    const names = tagsMap.get(String(subscriber.id)) || new Set<string>();
    const productSet = purchasedProducts.get(emailKey) || new Set<string>();
    const matches = (condition: Record<string, any>): boolean => {
      const type = String(condition.type || 'condition');
      if (type === 'group') {
        const connector = (condition.connector || 'AND').toUpperCase();
        const nested = Array.isArray(condition.conditions) ? condition.conditions : [];
        const result = nested.map((entry) => matches(entry));
        return connector === 'OR' ? result.some(Boolean) : result.every(Boolean);
      }
      const field = String(condition.field || '');
      const op = String(condition.operator || 'equals');
      const value = normalizeValue(condition.value);
      switch (field) {
        case 'status': return compareScalar(String(subscriber.status || 'active'), op, value);
        case 'tags': return compareScalar(Array.from(names), op, value);
        case 'source': return compareScalar(String(subscriber.source || ''), op, value);
        case 'product_purchased': return compareScalar(Array.from(productSet), op, value);
        case 'has_purchased': return compareScalar(Boolean((purchaseCounts.get(emailKey) || 0) > 0), op, value);
        case 'purchase_count': return compareScalar(Number(purchaseCounts.get(emailKey) || 0), op, Number(value));
        case 'total_spent': return compareScalar(Number(spentMap.get(emailKey) || 0), op, Number(value));
        case 'last_purchase_date': return compareScalar(lastPurchaseMap.get(emailKey) || null, op, value);
        case 'signup_date': return compareScalar(String(subscriber.created_at || ''), op, value);
        case 'email_engagement': {
          const engagement = String(value || '').toLowerCase();
          if (engagement === 'opened_campaign') return compareScalar(Boolean((openedBySubscriber.get(String(subscriber.id)) || 0) > 0), op, true);
          if (engagement === 'clicked_campaign') return compareScalar(Boolean((clickedBySubscriber.get(String(subscriber.id)) || 0) > 0), op, true);
          if (engagement === 'never_opened') return compareScalar(Boolean((openedBySubscriber.get(String(subscriber.id)) || 0) === 0), op, true);
          return false;
        }
        default: return false;
      }
    };

    const conditions = Array.isArray(normalizedDefinition.conditions) ? normalizedDefinition.conditions : [];
    if (!conditions.length) return false;
    const connector = String(normalizedDefinition.connector || 'AND').toUpperCase();
    const results = conditions.map((entry) => matches(entry as Record<string, any>));
    return connector === 'OR' ? results.some(Boolean) : results.every(Boolean);
  });

  return { ok: true, count: eligible.length, preview: eligible.slice(0, 10).map((subscriber: any) => ({ id: subscriber.id, email: subscriber.email, status: subscriber.status })) };
}

async function campaignSubscribers(admin: any, campaign: any) {
  const audience = campaign.audience && typeof campaign.audience === 'object' ? campaign.audience : { type: 'all' };
  let query = admin.from('email_subscribers').select('id,email,status').eq('store_id', campaign.store_id).eq('status', 'active').limit(10000);
  if (audience.type === 'tag' && audience.tagId) {
    const { data: members, error } = await admin.from('email_subscriber_tag_members').select('subscriber_id').eq('tag_id', String(audience.tagId));
    if (error) throw error;
    const ids = (members || []).map((row: any) => row.subscriber_id);
    if (!ids.length) return [];
    query = query.in('id', ids);
  }
  if (audience.type === 'source' && audience.source) query = query.eq('source', String(audience.source).slice(0, 80));
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function dispatchScheduledCampaigns(limit = 10) {
  const admin = getAdminSupabase();
  const now = new Date().toISOString();
  const { data: campaigns, error } = await admin.from('email_campaigns').select('*').eq('status', 'scheduled').lte('scheduled_at', now).order('scheduled_at', { ascending: true }).limit(limit);
  if (error) throw error;
  let sent = 0; let failed = 0;
  for (const campaign of campaigns || []) {
    const { data: claimed } = await admin.from('email_campaigns').update({ status: 'sending', updated_at: now }).eq('id', campaign.id).eq('status', 'scheduled').select('id').maybeSingle();
    if (!claimed) continue;
    const recipients = await campaignSubscribers(admin, campaign);
    for (const subscriber of recipients) {
      const { data: recipient } = await admin.from('email_campaign_recipients').upsert({ campaign_id: campaign.id, subscriber_id: subscriber.id, status: 'queued' }, { onConflict: 'campaign_id,subscriber_id' }).select('id').single();
      if (!recipient) { failed += 1; continue; }
      try {
        const result = await sendMarketingEmail(subscriber.email, campaign.subject, marketingMarkup(campaign.content_html, recipient.id, subscriber.id, campaign.store_id), campaign.id, recipient.id);
        if (result.sent) { await admin.from('email_campaign_recipients').update({ status: 'sent', sent_at: new Date().toISOString(), provider_message_id: result.providerMessageId }).eq('id', recipient.id); sent += 1; }
      } catch (sendError) { await admin.from('email_campaign_recipients').update({ status: 'failed', error_message: sendError instanceof Error ? sendError.message : 'Delivery failed.' }).eq('id', recipient.id); failed += 1; }
    }
    await admin.from('email_campaigns').update({ status: failed ? 'failed' : 'sent', sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', campaign.id);
  }
  return { campaigns: campaigns?.length || 0, sent, failed };
}

export async function sendWelcomeCampaign(storeId: string, subscriberId: string) {
  const admin = getAdminSupabase();
  const { data: automation } = await admin.from('email_automations').select('campaign_id').eq('store_id', storeId).eq('trigger_type', 'new_subscriber').eq('enabled', true).maybeSingle();
  if (!automation) return false;
  const [{ data: campaign }, { data: subscriber }] = await Promise.all([
    admin.from('email_campaigns').select('id,subject,content_html').eq('id', automation.campaign_id).eq('store_id', storeId).maybeSingle(),
    admin.from('email_subscribers').select('id,email,status,store_id').eq('id', subscriberId).eq('store_id', storeId).maybeSingle(),
  ]);
  if (!campaign || !subscriber || subscriber.status !== 'active') return false;
  const { data: recipient } = await admin.from('email_campaign_recipients').upsert({ campaign_id: campaign.id, subscriber_id: subscriber.id, status: 'queued' }, { onConflict: 'campaign_id,subscriber_id' }).select('id').single();
  if (!recipient) return false;
  try {
    const result = await sendMarketingEmail(subscriber.email, campaign.subject, marketingMarkup(campaign.content_html, recipient.id, subscriber.id, storeId), campaign.id, recipient.id);
    if (result.sent) await admin.from('email_campaign_recipients').update({ status: 'sent', sent_at: new Date().toISOString(), provider_message_id: result.providerMessageId }).eq('id', recipient.id);
    return result.sent;
  } catch { await admin.from('email_campaign_recipients').update({ status: 'failed' }).eq('id', recipient.id); return false; }
}

async function claimAutomationExecution(admin: any, automation: any, nowIso: string) {
  const lockValue = randomUUID();
  const currentUpdatedAt = automation.updated_at || new Date(0).toISOString();
  const metadata = { ...(automation.metadata || {}), execution_lock: lockValue, lock_started_at: nowIso };
  const { data, error } = await admin.from('email_automations')
    .update({ metadata, updated_at: nowIso })
    .eq('id', automation.id)
    .eq('enabled', true)
    .eq('updated_at', currentUpdatedAt)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function processDueAutomations(limit = 25) {
  const admin = getAdminSupabase();
  const now = new Date();
  const nowIso = now.toISOString();
  const { data: automations, error } = await admin.from('email_automations').select('*').eq('enabled', true).order('next_run_at', { ascending: true, nullsFirst: true }).limit(limit * 4);
  if (error) throw error;

  let processed = 0;
  for (const automation of automations || []) {
    const nextRunAt = automation.next_run_at ? new Date(automation.next_run_at).getTime() : null;
    if (nextRunAt !== null && nextRunAt > now.getTime()) continue;

    const claimed = await claimAutomationExecution(admin, automation, nowIso);
    if (!claimed) continue;

    try {
      const { data: campaign } = await admin.from('email_campaigns').select('id,store_id,subject,content_html').eq('id', automation.campaign_id).eq('store_id', automation.store_id).maybeSingle();
      if (!campaign) continue;

      const triggerType = String(automation.trigger_type || 'new_subscriber');
      if (triggerType === 'day_after_signup') {
        const threshold = new Date(now.getTime() - (Number(automation.delay_seconds || 86400) * 1000)).toISOString();
        const { data: subscribers } = await admin.from('email_subscribers').select('id,email,status,created_at').eq('store_id', automation.store_id).eq('status', 'active').lte('created_at', threshold);
        for (const subscriber of subscribers || []) {
          const { data: existing } = await admin.from('email_campaign_recipients').select('id').eq('campaign_id', campaign.id).eq('subscriber_id', subscriber.id).maybeSingle();
          if (existing) continue;
          const { data: recipient } = await admin.from('email_campaign_recipients').upsert({ campaign_id: campaign.id, subscriber_id: subscriber.id, status: 'queued' }, { onConflict: 'campaign_id,subscriber_id' }).select('id').single();
          if (!recipient) continue;
          await sendMarketingEmail(subscriber.email, campaign.subject, marketingMarkup(campaign.content_html, recipient.id, subscriber.id, automation.store_id), campaign.id, recipient.id).catch(() => undefined);
        }
      }

      if (triggerType === 'customer_purchase') {
        const { data: orders } = await admin.from('orders').select('id,buyer_email,status,paid_at').eq('store_id', automation.store_id).eq('status', 'paid').gte('paid_at', automation.last_triggered_at || '1970-01-01T00:00:00.000Z');
        const emails = Array.from(new Set((orders || []).map((order: any) => String(order.buyer_email || '').trim().toLowerCase()).filter(Boolean)));
        if (emails.length) {
          const { data: subscribers } = await admin.from('email_subscribers').select('id,email,status').eq('store_id', automation.store_id).in('email', emails);
          for (const subscriber of subscribers || []) {
            const { data: existing } = await admin.from('email_campaign_recipients').select('id').eq('campaign_id', campaign.id).eq('subscriber_id', subscriber.id).maybeSingle();
            if (existing) continue;
            const { data: recipient } = await admin.from('email_campaign_recipients').upsert({ campaign_id: campaign.id, subscriber_id: subscriber.id, status: 'queued' }, { onConflict: 'campaign_id,subscriber_id' }).select('id').single();
            if (!recipient) continue;
            await sendMarketingEmail(subscriber.email, campaign.subject, marketingMarkup(campaign.content_html, recipient.id, subscriber.id, automation.store_id), campaign.id, recipient.id).catch(() => undefined);
          }
        }
      }

      if (triggerType === 'segment_match') {
        if (!automation.segment_id) continue;
        const { data: segment } = await admin.from('email_segments').select('id,name,definition').eq('id', automation.segment_id).eq('store_id', automation.store_id).maybeSingle();
        if (!segment || !segment.definition) continue;
        const result = await evaluateSegment(automation.store_id, segment.definition, admin);
        if (!result.ok) continue;
        const ids = (result.preview || []).map((subscriber: any) => String(subscriber.id));
        if (!ids.length) continue;
        for (const subscriberId of ids) {
          const { data: matched } = await admin.from('email_subscribers').select('id,email,status').eq('id', subscriberId).eq('store_id', automation.store_id).maybeSingle();
          if (!matched || matched.status !== 'active') continue;
          const { data: existing } = await admin.from('email_campaign_recipients').select('id').eq('campaign_id', campaign.id).eq('subscriber_id', matched.id).maybeSingle();
          if (existing) continue;
          const { data: recipient } = await admin.from('email_campaign_recipients').upsert({ campaign_id: campaign.id, subscriber_id: matched.id, status: 'queued' }, { onConflict: 'campaign_id,subscriber_id' }).select('id').single();
          if (!recipient) continue;
          await sendMarketingEmail(matched.email, campaign.subject, marketingMarkup(campaign.content_html, recipient.id, matched.id, automation.store_id), campaign.id, recipient.id).catch(() => undefined);
        }
      }

      await admin.from('email_automations').update({
        last_triggered_at: nowIso,
        next_run_at: null,
        metadata: { ...((claimed.metadata || {})), execution_lock: null, lock_finished_at: nowIso },
        updated_at: nowIso,
      }).eq('id', automation.id).select('*');
      processed += 1;
    } catch (error) {
      await admin.from('email_automations').update({
        metadata: { ...((claimed.metadata || {})), execution_lock: null, lock_failed_at: nowIso },
        updated_at: nowIso,
      }).eq('id', automation.id);
      console.error('[processDueAutomations]', error);
    }
  }

  return { processed, checked: (automations || []).length };
}

function esc(value: unknown) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function money(amount: number, currency: string) {
  return currency.toUpperCase() === 'INR' ? `₹${Number(amount || 0).toLocaleString('en-IN')}` : `${currency.toUpperCase()} ${Number(amount || 0).toLocaleString('en-IN')}`;
}

async function sendEmail(to: string, subject: string, html: string, meta?: {
  eventType?: string;
  templateKey?: string;
  idempotencyKey?: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from || !to) return { sent: false, skipped: true, providerMessageId: null };

  const admin = getAdminSupabase();
  const eventType = meta?.eventType || 'transactional';
  const templateKey = meta?.templateKey || 'generic';
  const idempotencyKey = meta?.idempotencyKey || `${eventType}:${to}:${subject}`;
  const { data: existing } = await admin.from('sellora_email_events')
    .select('id,status,provider_message_id')
    .eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existing?.status === 'sent') return { sent: true, skipped: false, providerMessageId: existing.provider_message_id || null };

  const now = new Date().toISOString();
  const { data: event } = await admin.from('sellora_email_events').upsert({
    idempotency_key: idempotencyKey, event_type: eventType, recipient: to, subject, template_key: templateKey,
    rendered_html: html,
    entity_type: meta?.entityType || null, entity_id: meta?.entityId || null, status: 'processing',
    attempt_count: Number(existing?.status ? 0 : 0) + 1, last_attempt_at: now, metadata: meta?.metadata || {}, updated_at: now
  }, { onConflict: 'idempotency_key' }).select('id').maybeSingle();

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ from, to, reply_to: process.env.RESEND_REPLY_TO || undefined, subject, html }),
      cache: 'no-store',
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Resend error: ${body || response.statusText}`);
    let parsed: any = null; try { parsed = body ? JSON.parse(body) : null; } catch {}
    const providerMessageId = typeof parsed?.id === 'string' ? parsed.id : null;
    if (event?.id) await admin.from('sellora_email_events').update({ status: 'sent', provider_message_id: providerMessageId, sent_at: now, updated_at: now, error_message: null }).eq('id', event.id);
    return { sent: true, skipped: false, providerMessageId };
  } catch (error) {
    if (event?.id) await admin.from('sellora_email_events').update({ status: 'failed', failed_at: now, updated_at: now, error_message: error instanceof Error ? error.message : 'Email delivery failed.' }).eq('id', event.id);
    throw error;
  }
}


export async function retryFailedEmailEvents(limit = 20) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) throw new Error('Resend is not configured.');
  const admin = getAdminSupabase();
  const { data: events, error } = await admin.from('sellora_email_events')
    .select('id,recipient,subject,rendered_html,attempt_count')
    .in('status',['failed','retrying']).lt('attempt_count',3).order('created_at',{ascending:true}).limit(limit);
  if (error) throw error;
  let sent=0,failed=0;
  for (const event of events||[]) {
    if (!event.rendered_html) { failed++; continue; }
    const now=new Date().toISOString();
    await admin.from('sellora_email_events').update({status:'processing',attempt_count:Number(event.attempt_count||0)+1,last_attempt_at:now,updated_at:now}).eq('id',event.id);
    try {
      const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:event.recipient,reply_to:process.env.RESEND_REPLY_TO||undefined,subject:event.subject,html:event.rendered_html}),cache:'no-store'});
      const body=await response.text(); if(!response.ok) throw new Error(body||response.statusText);
      let parsed:any=null; try{parsed=body?JSON.parse(body):null;}catch{}
      await admin.from('sellora_email_events').update({status:'sent',provider_message_id:typeof parsed?.id==='string'?parsed.id:null,sent_at:now,updated_at:now,error_message:null}).eq('id',event.id);
      sent++;
    } catch (e) {
      const attempts=Number(event.attempt_count||0)+1;
      await admin.from('sellora_email_events').update({status:'failed',failed_at:attempts>=3?now:null,updated_at:now,error_message:e instanceof Error?e.message:'Retry failed.'}).eq('id',event.id);
      failed++;
    }
  }
  return {sent,failed,checked:(events||[]).length};
}

function shell(title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f6f5fb;font-family:Arial,sans-serif;color:#17151f"><div style="max-width:620px;margin:32px auto;padding:28px;background:#fff;border:1px solid #e9e6f0;border-radius:20px"><div style="font-size:13px;font-weight:800;color:#5b4be7;letter-spacing:.08em">SELLORA</div><h1 style="font-size:26px;margin:16px 0 10px">${title}</h1>${body}<p style="font-size:12px;color:#777;margin-top:28px">This is an automated TABLELY email.</p></div></body></html>`;
}

export async function sendPurchaseEmails(orderId: string, token: string) {
  const admin = getAdminSupabase();
  const { data: order, error } = await admin.from('orders').select('id,store_id,product_id,creator_id,buyer_email,gross_amount,currency,status,paid_at,buyer_email_sent_at,creator_email_sent_at,invoice_number,delivery_status,products(title)').eq('id', orderId).maybeSingle();
  if (error) throw error;
  if (!order || order.status !== 'paid') return { buyer: false, creator: false };
  const product = Array.isArray(order.products) ? order.products[0] : order.products;
  const { data: store } = await admin.from('stores').select('name,username').eq('id', order.store_id).maybeSingle();
  const creator = order.creator_id ? (await admin.auth.admin.getUserById(order.creator_id)).data.user : null;
  const base = getAppBaseUrl();
  const { data: items } = await admin.from('order_items').select('id,product_id,title').eq('order_id', order.id).order('created_at', { ascending: true });
  const downloadButtons = (items || []).map((item:any) => `<p><a href="${esc(`${base}/api/orders/${encodeURIComponent(order.id)}/download?token=${encodeURIComponent(token)}&productId=${encodeURIComponent(item.product_id || '')}`)}" style="display:inline-block;padding:12px 18px;background:#5b4be7;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Download ${esc(item.title || 'product')}</a></p>`).join('');
  const accessUrl = `${base}${orderAccessUrl(order.id, token)}`;
  const buyerHtml = shell('Your purchase is confirmed', `<p style="line-height:1.6">Your payment for <strong>${esc(product?.title || 'Digital product')}</strong> was verified successfully.</p><div style="padding:16px;background:#f8f7fc;border-radius:12px"><p><strong>Order:</strong> ${esc(order.id)}</p><p><strong>Amount:</strong> ${esc(money(order.gross_amount, order.currency))}</p><p><strong>Invoice:</strong> ${esc(order.invoice_number || '—')}</p></div><h3>Download your purchase</h3>${downloadButtons || `<p><a href="${esc(accessUrl)}" style="display:inline-block;padding:12px 18px;background:#5b4be7;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">View order & download</a></p>`}<p style="font-size:12px;color:#666">You can also sign in to TABLELY to view your complete order history and recover your purchases.</p>`);
  let buyer = false;
  if (!order.buyer_email_sent_at) { const r = await sendEmail(order.buyer_email, `Purchase confirmed — ${product?.title || 'TABLELY product'}`, buyerHtml, {eventType:'order.purchase',templateKey:'purchase_confirmation',idempotencyKey:`order:${order.id}:buyer_purchase`,entityType:'order',entityId:order.id}); buyer = r.sent; if (r.sent) await admin.from('orders').update({ buyer_email_sent_at: new Date().toISOString(), receipt_sent_at: new Date().toISOString() }).eq('id', order.id); }
  let creatorSent = false;
  const creatorEmail = creator?.email;
  if (creatorEmail && !order.creator_email_sent_at) { const creatorHtml = shell('New sale', `<p style="line-height:1.6"><strong>${esc(product?.title || 'Product')}</strong> was purchased from <strong>${esc(store?.name || 'your store')}</strong>.</p><div style="padding:16px;background:#f8f7fc;border-radius:12px"><p><strong>Amount:</strong> ${esc(money(order.gross_amount, order.currency))}</p><p><strong>Buyer:</strong> ${esc(order.buyer_email)}</p><p><strong>Order:</strong> ${esc(order.id)}</p></div>`); const r = await sendEmail(creatorEmail, `New sale — ${product?.title || 'Product'}`, creatorHtml, {eventType:'order.sale',templateKey:'creator_new_sale',idempotencyKey:`order:${order.id}:creator_sale`,entityType:'order',entityId:order.id}); creatorSent = r.sent; if (r.sent) await admin.from('orders').update({ creator_email_sent_at: new Date().toISOString() }).eq('id', order.id); }
  return { buyer, creator: creatorSent };
}

export async function sendPaymentFailedEmail(orderId: string) {
  const admin = getAdminSupabase();
  const { data: order, error } = await admin.from('orders').select('id,buyer_email,gross_amount,currency,failed_email_sent_at,product_id,products(title)').eq('id', orderId).maybeSingle();
  if (error) throw error;
  if (!order || order.failed_email_sent_at) return false;
  const product = Array.isArray(order.products) ? order.products[0] : order.products;
  const html = shell('Payment needs your attention', `<p>Your payment attempt for <strong>${esc(product?.title || 'a TABLELY product')}</strong> was not completed.</p><p>You can return to the product and try again. No download access has been granted.</p>`);
  const r = await sendEmail(order.buyer_email, `Payment failed — ${product?.title || 'TABLELY'}`, html, {eventType:'order.payment_failed',templateKey:'payment_failed',idempotencyKey:`order:${order.id}:payment_failed`,entityType:'order',entityId:order.id});
  if (r.sent) await admin.from('orders').update({ failed_email_sent_at: new Date().toISOString() }).eq('id', order.id);
  return r.sent;
}

export async function sendRefundEmail(orderId: string) {
  const admin = getAdminSupabase();
  const { data: order, error } = await admin.from('orders').select('id,buyer_email,gross_amount,currency,product_id,products(title)').eq('id', orderId).maybeSingle();
  if (error) throw error;
  if (!order) return false;
  const product = Array.isArray(order.products) ? order.products[0] : order.products;
  const html = shell('Refund processed', `<p>Your refund for <strong>${esc(product?.title || 'your purchase')}</strong> has been processed.</p><p><strong>Amount:</strong> ${esc(money(order.gross_amount, order.currency))}</p>`);
  const r = await sendEmail(order.buyer_email, `Refund processed — ${product?.title || 'TABLELY'}`, html, {eventType:'order.refund',templateKey:'refund',idempotencyKey:`order:${order.id}:refund`,entityType:'order',entityId:order.id});
  return r.sent;
}

export async function sendAbandonedCheckoutEmail(orderId: string) {
  const admin = getAdminSupabase();
  const { data: order, error } = await admin.from('orders').select('id,store_id,product_id,buyer_email,gross_amount,currency,status,created_at,products(id,title,slug),stores(name,username)').eq('id', orderId).maybeSingle();
  if (error) throw error;
  if (!order || !['created','pending'].includes(order.status)) return false;
  const product = Array.isArray(order.products) ? order.products[0] : order.products;
  const store = Array.isArray(order.stores) ? order.stores[0] : order.stores;
  if (!store?.username || !product?.id) return false;
  const link = `${getAppBaseUrl()}${getCheckoutPath(store.username, product.id)}`;
  const html = shell('Complete your purchase', `<p>You started checkout for <strong>${esc(product.title || 'a digital product')}</strong> but payment was not completed.</p><p>Return to checkout to finish your purchase. No download access has been granted.</p><p><a href="${esc(link)}" style="display:inline-block;padding:12px 18px;background:#5b4be7;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Return to checkout</a></p>`);
  const r = await sendEmail(order.buyer_email, `Complete your purchase — ${product.title || 'TABLELY'}`, html, {eventType:'checkout.abandoned',templateKey:'abandoned_checkout',idempotencyKey:`order:${order.id}:abandoned_checkout`,entityType:'order',entityId:order.id});
  return r.sent;
}

export async function sendSubscriptionConfirmationEmail(subscriptionId: string) {
  const admin = getAdminSupabase();
  const { data: sub, error } = await admin.from('sellora_subscriptions').select('id,creator_id,plan_key,amount_minor,currency,current_start,current_end,confirmation_email_sent_at,plan_version_id,sellora_plans(name)').eq('id', subscriptionId).maybeSingle();
  if (error) throw error;
  if (!sub || sub.confirmation_email_sent_at) return false;
  const user = await admin.auth.admin.getUserById(sub.creator_id);
  const email = user.data.user?.email;
  if (!email) return false;
  const plan = Array.isArray((sub as any).sellora_plans) ? (sub as any).sellora_plans[0] : (sub as any).sellora_plans;
  const body = shell('Your TABLELY plan is active', `<p>Your TABLELY subscription for <strong>${esc(plan?.name || sub.plan_key)}</strong> has been confirmed.</p><div style="padding:16px;background:#f8f7fc;border-radius:12px"><p><strong>Plan:</strong> ${esc(plan?.name || sub.plan_key)}</p><p><strong>Amount:</strong> ${esc(money(Number(sub.amount_minor || 0) / 100, sub.currency))} / month</p><p><strong>Subscription:</strong> ${esc(sub.id)}</p><p><strong>Current period:</strong> ${esc(sub.current_start ? new Date(sub.current_start).toLocaleDateString('en-IN') : '—')} to ${esc(sub.current_end ? new Date(sub.current_end).toLocaleDateString('en-IN') : '—')}</p></div>`);
  const result = await sendEmail(email, `TABLELY ${plan?.name || sub.plan_key} plan activated`, body, {eventType:'subscription.confirmed',templateKey:'subscription_confirmation',idempotencyKey:`subscription:${subscriptionId}:confirmation`,entityType:'subscription',entityId:subscriptionId});
  if (result.sent) await admin.from('sellora_subscriptions').update({ confirmation_email_sent_at: new Date().toISOString() }).eq('id', subscriptionId).is('confirmation_email_sent_at', null);
  return result.sent;
}

export async function sendSubscriptionRenewalEmail(subscriptionId: string, paymentId: string) {
  const admin = getAdminSupabase();
  const { data: payment, error: paymentError } = await admin.from('sellora_subscription_payments').select('id,subscription_id,provider_payment_id,amount_minor,currency,status,renewal_email_sent_at,paid_at').eq('provider_payment_id', paymentId).eq('subscription_id', subscriptionId).maybeSingle();
  if (paymentError) throw paymentError;
  if (!payment || payment.renewal_email_sent_at || payment.status !== 'captured') return false;
  const { data: sub, error: subError } = await admin.from('sellora_subscriptions').select('creator_id,plan_key').eq('id', subscriptionId).maybeSingle();
  if (subError) throw subError;
  if (!sub) return false;
  const user = await admin.auth.admin.getUserById(sub.creator_id);
  const email = user.data.user?.email;
  if (!email) return false;
  const body = shell('TABLELY renewal received', `<p>Your renewal payment for <strong>${esc(sub.plan_key)}</strong> was received successfully.</p><div style="padding:16px;background:#f8f7fc;border-radius:12px"><p><strong>Amount:</strong> ${esc(money(Number(payment.amount_minor || 0) / 100, payment.currency))}</p><p><strong>Payment:</strong> ${esc(payment.provider_payment_id)}</p></div>`);
  const result = await sendEmail(email, `TABLELY renewal received — ${sub.plan_key}`, body, {eventType:'subscription.renewal',templateKey:'subscription_renewal',idempotencyKey:`subscription:${subscriptionId}:payment:${payment.id}:renewal`,entityType:'subscription',entityId:subscriptionId});
  if (result.sent) await admin.from('sellora_subscription_payments').update({ renewal_email_sent_at: new Date().toISOString() }).eq('id', payment.id).is('renewal_email_sent_at', null);
  return result.sent;
}

export async function sendSubscriptionFailureEmail(subscriptionId: string) {
  const admin = getAdminSupabase();
  const { data: sub, error } = await admin.from('sellora_subscriptions').select('id,creator_id,plan_key,status,failure_email_sent_at,current_end').eq('id', subscriptionId).maybeSingle();
  if (error) throw error;
  if (!sub || sub.failure_email_sent_at) return false;
  const user = await admin.auth.admin.getUserById(sub.creator_id);
  const email = user.data.user?.email;
  if (!email) return false;
  const body = shell('TABLELY payment needs attention', `<p>Your <strong>${esc(sub.plan_key)}</strong> TABLELY subscription needs payment attention.</p><p>Your current access remains subject to the subscription state and any applicable grace period.</p><div style="padding:16px;background:#f8f7fc;border-radius:12px"><p><strong>Status:</strong> ${esc(sub.status)}</p><p><strong>Subscription:</strong> ${esc(sub.id)}</p></div><p>Open TABLELY Subscriptions to review the subscription and payment status.</p>`);
  const result = await sendEmail(email, `TABLELY payment issue — ${sub.plan_key}`, body, {eventType:'subscription.failure',templateKey:'subscription_failure',idempotencyKey:`subscription:${subscriptionId}:failure`,entityType:'subscription',entityId:subscriptionId});
  if (result.sent) await admin.from('sellora_subscriptions').update({ failure_email_sent_at: new Date().toISOString() }).eq('id', subscriptionId).is('failure_email_sent_at', null);
  return result.sent;
}

export async function sendSubscriptionCancellationEmail(subscriptionId: string) {
  const admin = getAdminSupabase();
  const { data: sub, error } = await admin.from('sellora_subscriptions').select('id,creator_id,plan_key,status,current_end,cancel_at_period_end,cancellation_email_sent_at').eq('id', subscriptionId).maybeSingle();
  if (error) throw error;
  if (!sub || sub.cancellation_email_sent_at) return false;
  const user = await admin.auth.admin.getUserById(sub.creator_id);
  const email = user.data.user?.email;
  if (!email) return false;
  const ending = sub.current_end ? new Date(sub.current_end).toLocaleDateString('en-IN') : 'the current period end';
  const body = shell('TABLELY subscription cancellation scheduled', `<p>Your <strong>${esc(sub.plan_key)}</strong> TABLELY subscription has been scheduled for cancellation.</p><p>Your current subscription period ends around <strong>${esc(ending)}</strong>. No new subscription renewal should be created after cancellation.</p><div style="padding:16px;background:#f8f7fc;border-radius:12px"><p><strong>Subscription:</strong> ${esc(sub.id)}</p><p><strong>Scheduled:</strong> ${esc(String(Boolean(sub.cancel_at_period_end)))}</p></div>`);
  const result = await sendEmail(email, `TABLELY cancellation scheduled — ${sub.plan_key}`, body, {eventType:'subscription.cancellation',templateKey:'subscription_cancellation',idempotencyKey:`subscription:${subscriptionId}:cancellation`,entityType:'subscription',entityId:subscriptionId});
  if (result.sent) await admin.from('sellora_subscriptions').update({ cancellation_email_sent_at: new Date().toISOString() }).eq('id', subscriptionId).is('cancellation_email_sent_at', null);
  return result.sent;
}

export async function sendTrialExpirationEmail(grantId: string) {
  const admin = getAdminSupabase();
  const { data: grant, error } = await admin.from('creator_access_grants').select('id,creator_id,plan,access_type,starts_at,expires_at,expiration_notice_sent_at').eq('id', grantId).maybeSingle();
  if (error) throw error;
  if (!grant || grant.expiration_notice_sent_at || !grant.creator_id || !grant.expires_at) return false;
  const user = await admin.auth.admin.getUserById(grant.creator_id);
  const email = user.data.user?.email;
  if (!email) return false;
  const body = shell('Your TABLELY access period is ending', `<p>Your <strong>${esc(grant.plan)}</strong> ${esc(grant.access_type)} access period is scheduled to end on <strong>${esc(new Date(grant.expires_at).toLocaleString('en-IN'))}</strong>.</p><p>After it expires, your account returns to the subscription entitlement unless another valid access grant is active.</p>`);
  const result = await sendEmail(email, `TABLELY ${grant.plan} access ends soon`, body, {eventType:'access.expiring',templateKey:'access_expiration',idempotencyKey:`grant:${grantId}:expiration`,entityType:'access_grant',entityId:grantId});
  if (result.sent) await admin.from('creator_access_grants').update({ expiration_notice_sent_at: new Date().toISOString() }).eq('id', grantId).is('expiration_notice_sent_at', null);
  return result.sent;
}
