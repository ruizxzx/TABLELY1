import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit, writeAudit } from '../../../lib/server-security';
import { fetchBillingPayment, fetchBillingSubscription, verifySubscriptionCheckoutSignature } from '../../../lib/billing';
import { persistProviderSubscription, persistSubscriptionPayment } from '../../../lib/billing-service';

export const dynamic = 'force-dynamic';
const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'billing-verify', 15);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Please sign in again.', 401);
    const body = await request.json() as { razorpay_payment_id?: unknown; razorpay_subscription_id?: unknown; razorpay_signature?: unknown };
    const paymentId = String(body.razorpay_payment_id || '').trim();
    const subscriptionId = String(body.razorpay_subscription_id || '').trim();
    const signature = String(body.razorpay_signature || '').trim();
    if (!paymentId || !subscriptionId || !signature) return fail('Subscription payment verification data is incomplete.');

    const db = getAdminSupabase();
    const { data: local, error: localError } = await db.from('sellora_subscriptions').select('*').eq('provider_subscription_id', subscriptionId).eq('creator_id', user.id).maybeSingle();
    if (localError) throw localError;
    if (!local) return fail('Subscription is not registered to this account.', 404);
    if (!verifySubscriptionCheckoutSignature(paymentId, subscriptionId, signature)) return fail('Invalid subscription payment signature.', 401);

    const remoteSubscription = await fetchBillingSubscription(subscriptionId);
    if (remoteSubscription.plan_id !== local.provider_plan_id) {
      const { data: validVersion } = await db.from('sellora_plan_versions').select('id').eq('environment', local.environment).eq('provider_plan_id', remoteSubscription.plan_id).maybeSingle();
      const matchesCurrent = validVersion?.id === local.plan_version_id;
      const matchesPending = validVersion?.id === local.pending_plan_version_id;
      if (!matchesCurrent && !matchesPending) return fail('Subscription plan verification failed.', 409);
    }
    const remotePayment = await fetchBillingPayment(paymentId);
    if (String(remotePayment.status) !== 'captured' && remotePayment.captured !== true) return fail(`Payment is not captured yet (provider status: ${remotePayment.status}).`, 409);

    await persistSubscriptionPayment(local.id, remotePayment);
    await persistProviderSubscription(local.id, remoteSubscription);
    await writeAudit({ actorUserId: user.id, action: 'subscription.checkout_verified', entityType: 'subscription', entityId: local.id, after: { providerSubscriptionId: subscriptionId, providerPaymentId: paymentId, status: remoteSubscription.status } });
    return NextResponse.json({ ok: true, data: { status: remoteSubscription.status, subscriptionId } });
  } catch (error) {
    console.error('[billing/verify]', error);
    return fail(error instanceof Error ? error.message : 'Could not verify the subscription payment.', 500);
  }
}
