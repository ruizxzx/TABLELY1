import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit } from '../../../lib/server-security';
import { cancelBillingSubscription } from '../../../lib/billing';

export const dynamic = 'force-dynamic';
const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'billing-abandon', 20);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Please sign in again.', 401);
    const body = await request.json() as { subscriptionId?: unknown };
    const subscriptionId = String(body.subscriptionId || '').trim();
    if (!subscriptionId) return fail('Subscription ID is required.');

    const db = getAdminSupabase();
    const { data: local, error: lookupError } = await db.from('sellora_subscriptions')
      .select('id,provider_subscription_id,status')
      .eq('id', subscriptionId)
      .eq('creator_id', user.id)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!local || String(local.status) !== 'created') return NextResponse.json({ ok: true, removed: false });

    try { await cancelBillingSubscription(local.provider_subscription_id, false); } catch (providerError) {
      console.error('[billing/abandon-provider-cancel]', providerError);
    }
    const { error: deleteError } = await db.from('sellora_subscriptions').delete().eq('id', local.id).eq('creator_id', user.id).eq('status', 'created');
    if (deleteError) throw deleteError;
    return NextResponse.json({ ok: true, removed: true });
  } catch (error) {
    console.error('[billing/abandon]', error);
    return fail(error instanceof Error ? error.message : 'Could not clear the unfinished checkout.', 500);
  }
}