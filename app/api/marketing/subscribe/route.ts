import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { trackEvent } from '../../../lib/server-analytics';
import { getCreatorEntitlements } from '../../../lib/server-entitlements';
import { sendWelcomeCampaign } from '../../../lib/server-email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { storeId?: unknown; email?: unknown };
    const storeId = typeof body.storeId === 'string' ? body.storeId : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!storeId || !EMAIL_RE.test(email) || email.length > 320) {
      return NextResponse.json({ ok: false, error: 'Enter a valid email address.' }, { status: 400 });
    }

    const admin = getAdminSupabase();
    const { data: store } = await admin.from('stores').select('id,owner_id,status,email_collection_enabled').eq('id', storeId).maybeSingle();
    if (!store || store.status !== 'active' || store.email_collection_enabled === false) {
      return NextResponse.json({ ok: false, error: 'Email collection is unavailable.' }, { status: 400 });
    }

    const entitlements = await getCreatorEntitlements(store.owner_id);
    const limits: Record<string, number | null> = { free: 100, creator: 2000, pro: 10000, max: null };
    const limit = limits[entitlements.planKey] ?? 100;

    const { data: result, error: rpcError } = await admin.rpc('create_email_subscriber_if_under_limit', {
      p_store_id: storeId,
      p_email: email,
      p_source: 'storefront',
      p_limit: limit === null ? null : Number(limit),
    });

    if (rpcError) throw rpcError;
    const row = Array.isArray(result) ? result[0] : result;
    if (!row || row.limit_reached) {
      const label = limit === null ? 'unlimited' : Number(limit).toLocaleString('en-IN');
      return NextResponse.json({ ok: false, error: `This creator has reached the ${entitlements.planName} subscriber limit of ${label}.` }, { status: 409 });
    }

    const subscriberId = row?.subscriber_id || null;
    await trackEvent({ storeId, eventType: 'email_subscribe', source: 'storefront' });
    if (subscriberId) void sendWelcomeCampaign(storeId, subscriberId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[marketing/subscribe]', error);
    return NextResponse.json({ ok: false, error: 'Could not save your email.' }, { status: 500 });
  }
}
