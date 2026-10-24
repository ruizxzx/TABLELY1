import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchRazorpayPayment, verifyRazorpayPaymentSignature } from '@/lib/razorpay';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';
import { isRazorpayPaymentCaptured, matchesRazorpayPayment, toRazorpayPaise } from '@/lib/payment-validation.mjs';

const schema = z.object({
  paymentAttemptId: z.string().uuid().optional(),
  attemptToken: z.string().min(32).max(128).optional(),
  orderId: z.string().uuid().optional(),
  trackingToken: z.string().min(20).max(128).optional(),
  razorpayPaymentId: z.string().min(5).max(100),
  razorpayOrderId: z.string().min(5).max(100),
  razorpaySignature: z.string().length(64),
}).refine(
  (value) => Boolean(value.paymentAttemptId && value.attemptToken) || Boolean(value.orderId && value.trackingToken),
  'Invalid payment verification request.',
);

export async function POST(request: Request) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid payment verification request.' }, { status: 400 });

    const admin = getSupabaseAdminClient();
    if (!admin) return NextResponse.json({ error: 'Payment verification is not configured.' }, { status: 503 });

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
    const { data: allowed, error: rateLimitError } = await admin.rpc('allow_rate_limit', {
      p_key: `payment-verify:${ip}`,
      p_window_seconds: 60,
      p_max_requests: 30,
    });
    if (rateLimitError || allowed === false) {
      return NextResponse.json({ error: 'Too many payment verification requests. Please wait a moment.' }, { status: 429 });
    }

    const input = parsed.data;
    let branchId: string;
    let expectedAmountInPaise: number | null;
    let expectedRazorpayOrderId: string | null = null;

    if (input.paymentAttemptId && input.attemptToken) {
      const { data: attempt, error } = await admin
        .from('payment_attempts')
        .select('id,branch_id,total,status,payment_expires_at,razorpay_order_id,razorpay_payment_id,order_id')
        .eq('id', input.paymentAttemptId)
        .eq('attempt_token', input.attemptToken)
        .maybeSingle();
      if (error || !attempt) return NextResponse.json({ error: 'Payment session not found.' }, { status: 404 });
      if (attempt.status === 'SUCCESS') {
        if (attempt.razorpay_payment_id !== input.razorpayPaymentId || attempt.razorpay_order_id !== input.razorpayOrderId || !attempt.order_id) {
          return NextResponse.json({ error: 'Payment session was completed with a different payment.' }, { status: 409 });
        }
        const { data: completedOrder, error: completedOrderError } = await admin
          .from('orders')
          .select('id,order_number,tracking_token')
          .eq('id', attempt.order_id)
          .maybeSingle();
        if (completedOrderError || !completedOrder) return NextResponse.json({ error: 'Completed order could not be loaded.' }, { status: 500 });
        return NextResponse.json({ ok: true, paid: true, status: 'CAPTURED', orderId: completedOrder.id, orderNumber: completedOrder.order_number, trackingToken: completedOrder.tracking_token });
      }
      if (['FAILED', 'EXPIRED'].includes(attempt.status)) {
        return NextResponse.json({ error: 'Payment session is no longer valid. Please place a new order.' }, { status: 409 });
      }
      if (new Date(attempt.payment_expires_at).getTime() <= Date.now()) {
        await admin.rpc('expire_stale_payment_attempts');
        return NextResponse.json({ error: 'Payment session expired. Please place a new order.' }, { status: 409 });
      }
      branchId = attempt.branch_id;
      expectedAmountInPaise = toRazorpayPaise(Number(attempt.total));
      expectedRazorpayOrderId = attempt.razorpay_order_id;
    } else {
      const { data: order, error } = await admin
        .from('orders')
        .select('id,branch_id,total,payment_status,razorpay_order_id,status,payment_method,razorpay_payment_id')
        .eq('id', input.orderId!)
        .eq('tracking_token', input.trackingToken!)
        .maybeSingle();
      if (error || !order) return NextResponse.json({ error: 'Order not found.' }, { status: 404 });
      if (order.status === 'CANCELLED' || order.status === 'REJECTED') {
        return NextResponse.json({ error: 'Order cannot be paid in its current state.' }, { status: 409 });
      }
      if (!(order.payment_method === 'PAY_NOW' || order.payment_method?.startsWith('PAY_NOW:'))) {
        return NextResponse.json({ error: 'This order is not an online-payment order.' }, { status: 400 });
      }
      if (order.payment_status === 'PAID'
          && (order.razorpay_payment_id !== input.razorpayPaymentId || order.razorpay_order_id !== input.razorpayOrderId)) {
        return NextResponse.json({ error: 'Order is already paid.' }, { status: 409 });
      }
      branchId = order.branch_id;
      expectedAmountInPaise = toRazorpayPaise(Number(order.total));
      expectedRazorpayOrderId = order.razorpay_order_id;
    }

    if (expectedAmountInPaise === null) return NextResponse.json({ error: 'Invalid expected payment amount.' }, { status: 409 });

    const { data: branch, error: branchError } = await admin
      .from('branches')
      .select('organization_id')
      .eq('id', branchId)
      .maybeSingle();
    if (branchError || !branch) return NextResponse.json({ error: 'Restaurant not found.' }, { status: 404 });

    const keys = resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin, branch.organization_id, branchId));
    if (!keys.enabled) return NextResponse.json({ error: 'Online payments are disabled.' }, { status: 403 });
    if (expectedRazorpayOrderId !== input.razorpayOrderId) return NextResponse.json({ error: 'Razorpay order mismatch.' }, { status: 400 });
    if (!verifyRazorpayPaymentSignature(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature, { keyId: keys.keyId, keySecret: keys.secret })) {
      return NextResponse.json({ error: 'Payment signature verification failed.' }, { status: 400 });
    }

    const payment = await fetchRazorpayPayment(input.razorpayPaymentId, { keyId: keys.keyId, keySecret: keys.secret });
    if (!matchesRazorpayPayment(payment, { orderId: input.razorpayOrderId, paymentId: input.razorpayPaymentId, amountInPaise: expectedAmountInPaise, currency: 'INR' })) {
      return NextResponse.json({ error: 'Payment order, amount or currency mismatch.' }, { status: 400 });
    }

    const status = String(payment.status ?? '').toUpperCase();
    if (status === 'FAILED') {
      if (input.paymentAttemptId) {
        const { error } = await admin.rpc('mark_payment_attempt_failed', {
          p_payment_attempt_id: input.paymentAttemptId,
          p_attempt_token: input.attemptToken!,
          p_razorpay_payment_id: input.razorpayPaymentId,
          p_reason: 'Online payment failed',
        });
        if (error) return NextResponse.json({ error: 'Could not record payment failure.' }, { status: 500 });
      } else {
        const { error } = await admin.rpc('record_online_payment_failure', {
          p_order_id: input.orderId!,
          p_tracking_token: input.trackingToken!,
          p_razorpay_order_id: input.razorpayOrderId,
          p_razorpay_payment_id: input.razorpayPaymentId,
          p_reason: 'Online payment failed',
        });
        if (error) return NextResponse.json({ error: 'Could not record payment failure.' }, { status: 500 });
      }
      return NextResponse.json({ ok: true, paid: false, status });
    }

    if (!isRazorpayPaymentCaptured(payment)) return NextResponse.json({ ok: true, paid: false, status });

    if (input.paymentAttemptId) {
      const { data: rows, error } = await admin.rpc('finalize_payment_attempt_v18', {
        p_payment_attempt_id: input.paymentAttemptId,
        p_attempt_token: input.attemptToken!,
        p_razorpay_payment_id: input.razorpayPaymentId,
        p_payment_method: payment.method ?? 'ONLINE',
      });
      if (error) {
        console.error('payments/verify: finalize attempt failed', error);
        return NextResponse.json({ error: error.message.toLowerCase().includes('expired') ? 'Payment session expired. Please place a new order.' : 'Could not finalize payment.' }, { status: error.message.toLowerCase().includes('expired') ? 409 : 500 });
      }
      const row = Array.isArray(rows) ? rows[0] : rows;
      return NextResponse.json({ ok: true, paid: true, status, orderId: row?.order_id, orderNumber: row?.order_number, trackingToken: row?.tracking_token });
    }

    const { error: finalizeError } = await admin.rpc('finalize_legacy_razorpay_order', {
      p_order_id: input.orderId!,
      p_tracking_token: input.trackingToken!,
      p_razorpay_order_id: input.razorpayOrderId,
      p_razorpay_payment_id: input.razorpayPaymentId,
      p_amount_in_paise: payment.amount,
      p_currency: payment.currency,
      p_method: payment.method ?? 'ONLINE',
      p_metadata: { source: 'checkout-verification' },
    });
    if (finalizeError) {
      console.error('payments/verify: legacy payment finalization failed', finalizeError);
      return NextResponse.json({ error: 'Could not finalize payment.' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, paid: true, status, trackingToken: input.trackingToken });
  } catch (error: unknown) {
    console.error('payments/verify: unexpected error', error);
    return NextResponse.json({ error: 'Could not verify payment.' }, { status: 500 });
  }
}
