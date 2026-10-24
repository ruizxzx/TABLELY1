import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit, writeAudit } from '../../../lib/server-security';
import { cancelScheduledBillingUpdate } from '../../../lib/billing';
import { persistProviderSubscription } from '../../../lib/billing-service';

export const dynamic = 'force-dynamic';
const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'billing-resume', 10);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Please sign in again.', 401);

    const db = getAdminSupabase();
    const { data: sub, error } = await db.from('sellora_subscriptions')
      .select('*')
      .eq('creator_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!sub || !sub.cancel_at_period_end || sub.pending_plan_key !== 'free') {
      return fail('No scheduled cancellation is available to resume.', 409);
    }

    const remote = await cancelScheduledBillingUpdate(sub.provider_subscription_id);
    await persistProviderSubscription(sub.id, remote);
    const { error: patchError } = await db.from('sellora_subscriptions').update({
      pending_plan_key: null,
      pending_plan_version_id: null,
      pending_change_at: null,
      cancel_at_period_end: false,
      cancelled_at: null,
      cancellation_email_sent_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', sub.id);
    if (patchError) throw patchError;

    await writeAudit({
      actorUserId: user.id,
      action: 'subscription.cancellation_resumed',
      entityType: 'subscription',
      entityId: sub.id,
      before: { pendingPlanKey: 'free', cancelAtPeriodEnd: true },
      after: { pendingPlanKey: null, cancelAtPeriodEnd: false },
    });
    return NextResponse.json({ ok: true, data: remote });
  } catch (error) {
    console.error('[billing/resume]', error);
    return fail(error instanceof Error ? error.message : 'Could not resume subscription.', 500);
  }
}
