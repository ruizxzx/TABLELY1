import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { dispatchScheduledCampaigns, processDueAutomations, retryFailedEmailEvents, sendTrialExpirationEmail } from '../../../lib/server-email';
import { syncSubscriptionFromProvider } from '../../../lib/billing-service';

export const dynamic = 'force-dynamic';

function authorized(request: Request) {
  const secret = (process.env.SELLORA_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const bearer = request.headers.get('authorization') || '';
  const header = request.headers.get('x-sellora-cron-secret') || '';
  return Boolean(secret) && (bearer === `Bearer ${secret}` || header === secret);
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const email = await retryFailedEmailEvents(20);
    const campaigns = await dispatchScheduledCampaigns(10);
    const automationRun = await processDueAutomations(25);
    const db = getAdminSupabase();
    const now = new Date();
    const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await db.from('creator_access_grants').update({ status: 'expired', updated_at: now.toISOString() }).in('status', ['pending', 'active']).not('expires_at', 'is', null).lte('expires_at', now.toISOString());
    const { data: expiring } = await db.from('creator_access_grants').select('id').eq('status', 'active').not('expires_at', 'is', null).gt('expires_at', now.toISOString()).lte('expires_at', soon.toISOString()).is('expiration_notice_sent_at', null).limit(200);
    for (const grant of expiring || []) await sendTrialExpirationEmail(grant.id).catch(error => console.error('[daily-cron-trial-email]', error));

    const { data: staleSubs } = await db.from('sellora_subscriptions').select('id,provider_subscription_id').in('status', ['active', 'authenticated', 'pending', 'paused', 'halted']).lt('last_synced_at', new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()).limit(100);
    const subscriptionSync = { checked: staleSubs?.length || 0, synced: 0, failed: 0 };
    for (const sub of staleSubs || []) {
      try { await syncSubscriptionFromProvider(sub.provider_subscription_id); subscriptionSync.synced += 1; } catch (error) { subscriptionSync.failed += 1; console.error('[daily-cron-subscription-sync]', sub.id, error); }
    }
    return NextResponse.json({ ok: true, data: { email, campaigns, automationRun, trialNotices: expiring?.length || 0, subscriptionSync } });
  } catch (error) {
    console.error('[cron/daily]', error);
    return NextResponse.json({ ok: false, error: 'Daily maintenance failed.' }, { status: 500 });
  }
}

export async function POST(request: Request) { return GET(request); }
