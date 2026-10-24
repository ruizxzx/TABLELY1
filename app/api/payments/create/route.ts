import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { createRazorpayOrder } from '@/lib/razorpay';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';
import { toRazorpayPaise } from '@/lib/payment-validation.mjs';

const schema = z.object({
  paymentAttemptId: z.string().uuid().optional(),
  attemptToken: z.string().min(32).max(128).optional(),
  orderId: z.string().uuid().optional(),
  trackingToken: z.string().min(20).max(128).optional(),
}).refine(
  (value) => Boolean(value.paymentAttemptId && value.attemptToken) || Boolean(value.orderId && value.trackingToken),
  'Invalid payment request.',
);

export async function POST(request: Request) {
  let claimedAttemptId: string | null = null;
  let claimedAttemptToken: string | null = null;
  let claimedAttemptCreationToken: string | null = null;
  let claimedLegacyOrderId: string | null = null;
  let claimedLegacyTrackingToken: string | null = null;
  let claimedLegacyCreationToken: string | null = null;
  const admin = getSupabaseAdminClient();

  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid payment request.' }, { status: 400 });
    if (!admin) return NextResponse.json({ error: 'Server payment configuration is incomplete.' }, { status: 503 });

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
    const { data: allowed, error: rateLimitError } = await admin.rpc('allow_rate_limit', {
      p_key: `payment:${ip}`,
      p_window_seconds: 60,
      p_max_requests: 30,
    });
    if (rateLimitError || allowed === false) {
      return NextResponse.json({ error: 'Too many payment attempts. Please wait a moment.' }, { status: 429 });
    }

    let branchId: string;
    let total: number;
    const paymentAttemptId = parsed.data.paymentAttemptId ?? null;

    if (paymentAttemptId && parsed.data.attemptToken) {
      const { data: attempt, error } = await admin
        .from('payment_attempts')
        .select('id,branch_id,total,status,payment_expires_at')
        .eq('id', paymentAttemptId)
        .eq('attempt_token', parsed.data.attemptToken)
        .maybeSingle();
      if (error || !attempt) return NextResponse.json({ error: 'Payment session not found.' }, { status: 404 });
      if (attempt.status === 'SUCCESS') return NextResponse.json({ error: 'Payment session has already been completed.' }, { status: 409 });
      if (['FAILED', 'EXPIRED'].includes(attempt.status)) {
        return NextResponse.json({ error: 'Payment session has expired or failed. Please place a new order.' }, { status: 409 });
      }
      if (new Date(attempt.payment_expires_at).getTime() <= Date.now()) {
        await admin.rpc('expire_stale_payment_attempts');
        return NextResponse.json({ error: 'Payment session has expired. Please place a new order.' }, { status: 409 });
      }
      branchId = attempt.branch_id;
      total = Number(attempt.total);
    } else {
      const orderId = parsed.data.orderId!;
      const trackingToken = parsed.data.trackingToken!;
      const { data: order, error } = await admin
        .from('orders')
        .select('id,branch_id,total,payment_status,payment_method,status')
        .eq('id', orderId)
        .eq('tracking_token', trackingToken)
        .maybeSingle();
      if (error || !order) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
      if (order.status === 'CANCELLED' || order.status === 'REJECTED') return NextResponse.json({ error: 'Order cannot be paid in its current state.' }, { status: 409 });
      if (order.payment_status === 'PAID') return NextResponse.json({ error: 'Order is already paid.' }, { status: 409 });
      if (!(order.payment_method === 'PAY_NOW' || order.payment_method?.startsWith('PAY_NOW:'))) {
        return NextResponse.json({ error: 'This order is not an online-payment order.' }, { status: 400 });
      }
      branchId = order.branch_id;
      total = Number(order.total);
    }

    const amountInPaise = toRazorpayPaise(total);
    if (amountInPaise === null) return NextResponse.json({ error: 'Order total must be a valid positive INR amount.' }, { status: 400 });

    const { data: branch, error: branchError } = await admin
      .from('branches')
      .select('organization_id')
      .eq('id', branchId)
      .maybeSingle();
    if (branchError || !branch) return NextResponse.json({ error: 'Restaurant not found.' }, { status: 404 });

    const { data: featureAllowed, error: featureError } = await admin.rpc('organization_has_feature', {
      p_organization_id: branch.organization_id,
      p_feature: 'ONLINE_PAYMENTS',
    });
    if (featureError || !featureAllowed) {
      return NextResponse.json({ error: featureError ? 'Could not create payment order.' : 'Online payments are not available on the current Tablely plan.' }, { status: featureError ? 500 : 403 });
    }

    const keys = resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin, branch.organization_id, branchId));
    if (!keys.enabled) return NextResponse.json({ error: 'Online payments are not enabled for this restaurant.' }, { status: 403 });

    // Serialize external Razorpay order creation for payment attempts. Duplicate
    // requests either receive the existing provider order or a retryable 409.
    if (paymentAttemptId && parsed.data.attemptToken) {
      const { data: claimRows, error: claimError } = await admin.rpc('claim_payment_attempt_razorpay_order', {
        p_payment_attempt_id: paymentAttemptId,
        p_attempt_token: parsed.data.attemptToken,
      });
      if (claimError) return NextResponse.json({ error: 'Could not prepare the payment session.' }, { status: 409 });
      const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
      if (claim?.existing_razorpay_order_id) {
        return NextResponse.json({ razorpayOrderId: claim.existing_razorpay_order_id, amount: amountInPaise, currency: 'INR', keyId: keys.keyId });
      }
      if (claim?.creation_in_progress || !claim?.claimed || !claim?.creation_token) {
        return NextResponse.json({ error: 'Payment setup is already in progress. Please retry shortly.' }, { status: 409, headers: { 'Retry-After': '2' } });
      }
      claimedAttemptId = paymentAttemptId;
      claimedAttemptToken = parsed.data.attemptToken;
      claimedAttemptCreationToken = claim.creation_token;
    } else if (parsed.data.orderId && parsed.data.trackingToken) {
      const { data: claimRows, error: claimError } = await admin.rpc('claim_legacy_razorpay_order', {
        p_order_id: parsed.data.orderId,
        p_tracking_token: parsed.data.trackingToken,
      });
      if (claimError) return NextResponse.json({ error: 'Could not prepare the payment session.' }, { status: 409 });
      const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
      if (claim?.existing_razorpay_order_id) {
        return NextResponse.json({ razorpayOrderId: claim.existing_razorpay_order_id, amount: amountInPaise, currency: 'INR', keyId: keys.keyId });
      }
      if (claim?.creation_in_progress || !claim?.claimed || !claim?.creation_token) {
        return NextResponse.json({ error: 'Payment setup is already in progress. Please retry shortly.' }, { status: 409, headers: { 'Retry-After': '2' } });
      }
      claimedLegacyOrderId = parsed.data.orderId;
      claimedLegacyTrackingToken = parsed.data.trackingToken;
      claimedLegacyCreationToken = claim.creation_token;
    }

    const rzp = await createRazorpayOrder({
      amountInPaise,
      receipt: `tl-${paymentAttemptId ?? parsed.data.orderId}`,
      notes: paymentAttemptId ? { tablely_payment_attempt_id: paymentAttemptId } : { tablely_legacy_payment: 'true' },
    }, { keyId: keys.keyId, keySecret: keys.secret });

    if (paymentAttemptId && parsed.data.attemptToken) {
      const { data: saved, error: saveError } = await admin.rpc('set_payment_attempt_razorpay_order', {
        p_payment_attempt_id: paymentAttemptId,
        p_attempt_token: parsed.data.attemptToken,
        p_razorpay_order_id: rzp.id,
        p_claim_token: claimedAttemptCreationToken,
      });
      if (saveError || saved !== true) {
        await admin.rpc('release_payment_attempt_razorpay_order_claim', {
          p_payment_attempt_id: paymentAttemptId,
          p_attempt_token: parsed.data.attemptToken,
          p_claim_token: claimedAttemptCreationToken,
        });
        claimedAttemptId = null;
        claimedAttemptToken = null;
        return NextResponse.json({ error: 'Payment session expired. Please place a new order.' }, { status: 409 });
      }
      claimedAttemptId = null;
      claimedAttemptToken = null;
      claimedAttemptCreationToken = null;
    } else {
      const { data: saved, error: saveError } = await admin.rpc('set_legacy_razorpay_order', {
        p_order_id: parsed.data.orderId!,
        p_tracking_token: parsed.data.trackingToken!,
        p_razorpay_order_id: rzp.id,
        p_claim_token: claimedLegacyCreationToken,
      });
      if (saveError || saved !== true) {
        await admin.rpc('release_legacy_razorpay_order_claim', {
          p_order_id: parsed.data.orderId!,
          p_tracking_token: parsed.data.trackingToken!,
          p_claim_token: claimedLegacyCreationToken,
        });
        claimedLegacyOrderId = null;
        claimedLegacyTrackingToken = null;
        return NextResponse.json({ error: 'Payment session changed. Please retry payment.' }, { status: 409 });
      }
      claimedLegacyOrderId = null;
      claimedLegacyTrackingToken = null;
      claimedLegacyCreationToken = null;
    }

    return NextResponse.json({ razorpayOrderId: rzp.id, amount: rzp.amount, currency: rzp.currency, keyId: keys.keyId });
  } catch (error: unknown) {
    if (admin && claimedAttemptId && claimedAttemptToken) {
      const { error: releaseError } = await admin.rpc('release_payment_attempt_razorpay_order_claim', {
        p_payment_attempt_id: claimedAttemptId,
        p_attempt_token: claimedAttemptToken,
        p_claim_token: claimedAttemptCreationToken,
      });
      if (releaseError) console.error('payments/create: failed to release payment-attempt order claim', releaseError);
    }
    if (admin && claimedLegacyOrderId && claimedLegacyTrackingToken) {
      const { error: releaseError } = await admin.rpc('release_legacy_razorpay_order_claim', {
        p_order_id: claimedLegacyOrderId,
        p_tracking_token: claimedLegacyTrackingToken,
        p_claim_token: claimedLegacyCreationToken,
      });
      if (releaseError) console.error('payments/create: failed to release legacy order claim', releaseError);
    }
    console.error('payments/create: unexpected error', error);
    return NextResponse.json({ error: 'Could not create payment order.' }, { status: 500 });
  }
}
