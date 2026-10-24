import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { sendTrialExpirationEmail } from '../../../lib/server-email';
import { syncSubscriptionFromProvider } from '../../../lib/billing-service';

export const dynamic = 'force-dynamic';

function authorized(request: Request) {
  const secret = (process.env.SELLORA_CRON_SECRET || process.env.CRON_SECRET)?.trim();
  if (!secret) return false;
  const bearer = request.headers.get('authorization') || '';
  const header = request.headers.get('x-sellora-cron-secret') || '';
  return bearer === `Bearer ${secret}` || header === secret;
}

export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ ok:false, error:'Unauthorized' }, { status:401 });
  try {
    const db = getAdminSupabase();
    const now = new Date();
    const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await db.from('creator_access_grants').update({ status:'expired', updated_at:now.toISOString() }).in('status',['pending','active']).not('expires_at','is',null).lte('expires_at',now.toISOString());
    const { data: expiring } = await db.from('creator_access_grants').select('id').eq('status','active').not('expires_at','is',null).gt('expires_at',now.toISOString()).lte('expires_at',soon.toISOString()).is('expiration_notice_sent_at',null).limit(200);
    for (const grant of expiring || []) await sendTrialExpirationEmail(grant.id).catch(error => console.error('[trial-expiration-email]', error));

    const { data: staleSubs } = await db.from('sellora_subscriptions').select('id,provider_subscription_id').in('status',['active','authenticated','pending','paused','halted']).lt('last_synced_at',new Date(now.getTime()-15*60*1000).toISOString()).limit(100);
    const syncResults = { checked: staleSubs?.length || 0, synced: 0, failed: 0 };
    for (const sub of staleSubs || []) {
      try { await syncSubscriptionFromProvider(sub.provider_subscription_id); syncResults.synced += 1; } catch (error) { syncResults.failed += 1; console.error('[billing-cron-sync]', sub.id, error); }
    }
    return NextResponse.json({ ok:true, data:{ trialNotices: expiring?.length || 0, subscriptionSync: syncResults } });
  } catch (error) {
    console.error('[billing-cron]',error);
    return NextResponse.json({ok:false,error:'Billing cron failed.'},{status:500});
  }
}
