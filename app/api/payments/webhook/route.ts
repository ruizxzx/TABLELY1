import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchRazorpayPayment, verifyRazorpayWebhookSignature } from '@/lib/razorpay';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';
import { isRazorpayPaymentCaptured, matchesRazorpayPayment, toRazorpayPaise } from '@/lib/payment-validation.mjs';

type RazorpayWebhookBody = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; amount?: number; currency?: string; status?: string; method?: string; captured?: boolean } };
    order?: { entity?: { id?: string } };
  };
};

const SUPPORTED_EVENTS = new Set(['payment.captured', 'order.paid', 'payment.authorized', 'payment.failed']);

export async function POST(request: Request) {
  const rawBody = await request.text();
  const admin = getSupabaseAdminClient();
  if (!admin) return new NextResponse('Server not configured', { status: 503 });

  try {
    const body = JSON.parse(rawBody) as RazorpayWebhookBody;
    if (!SUPPORTED_EVENTS.has(body.event ?? '')) return NextResponse.json({ ok: true });

    const entity = body.payload?.payment?.entity;
    const paymentId = entity?.id;
    const razorpayOrderId = entity?.order_id ?? body.payload?.order?.entity?.id;
    if (!paymentId || !razorpayOrderId) return NextResponse.json({ ok: true });

    const { data: attempt, error: attemptLookupError } = await admin
      .from('payment_attempts')
      .select('id,attempt_token,branch_id,total,status,payment_expires_at,razorpay_order_id')
      .eq('razorpay_order_id', razorpayOrderId)
      .maybeSingle();
    if (attemptLookupError) return NextResponse.json({ error: 'Webhook lookup failed.' }, { status: 500 });

    if (attempt) {
      const { data: branch, error: branchError } = await admin.from('branches').select('organization_id').eq('id', attempt.branch_id).maybeSingle();
      if (branchError || !branch) return NextResponse.json({ error: 'Webhook branch lookup failed.' }, { status: 500 });
      const keys = resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin, branch.organization_id, attempt.branch_id));
      if (!keys.enabled || !verifyRazorpayWebhookSignature(rawBody, request.headers.get('x-razorpay-signature') ?? '', { keyId: keys.keyId, keySecret: keys.secret, webhookSecret: keys.webhook })) {
        return new NextResponse('Invalid signature', { status: 400 });
      }

      // Failure events are snapshots and can be delivered after the provider
      // state has changed. Re-fetch them before applying a failure transition.
      const shouldFetchCurrentState = String(entity?.status ?? '').toUpperCase() === 'FAILED';
      const payment = !shouldFetchCurrentState && entity?.amount !== undefined && entity.currency
        ? entity
        : await fetchRazorpayPayment(paymentId, { keyId: keys.keyId, keySecret: keys.secret });
      const expectedAmountInPaise = toRazorpayPaise(Number(attempt.total));
      if (expectedAmountInPaise === null || !matchesRazorpayPayment(payment, { orderId: razorpayOrderId, paymentId, amountInPaise: expectedAmountInPaise, currency: 'INR' })) {
        return new NextResponse('Payment order, amount or currency mismatch', { status: 400 });
      }

      const status = String(payment.status ?? '').toUpperCase();
      if (status === 'FAILED') {
        const { error } = await admin.rpc('mark_payment_attempt_failed', {
          p_payment_attempt_id: attempt.id,
          p_attempt_token: attempt.attempt_token,
          p_razorpay_payment_id: paymentId,
          p_reason: 'Online payment failed',
        });
        if (error) return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 });
      } else if (isRazorpayPaymentCaptured(payment)) {
        const { error } = await admin.rpc('finalize_payment_attempt_v18', {
          p_payment_attempt_id: attempt.id,
          p_attempt_token: attempt.attempt_token,
          p_razorpay_payment_id: paymentId,
          p_payment_method: payment.method ?? 'ONLINE',
        });
        if (error) {
          console.error('payments/webhook: payment-attempt finalization failed', error);
          return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 });
        }
      }
      return NextResponse.json({ ok: true });
    }

    const { data: order, error: orderLookupError } = await admin
      .from('orders')
      .select('id,branch_id,total,payment_status,status,payment_method,razorpay_order_id,razorpay_payment_id')
      .eq('razorpay_order_id', razorpayOrderId)
      .maybeSingle();
    if (orderLookupError) return NextResponse.json({ error: 'Webhook order lookup failed.' }, { status: 500 });
    if (!order) return NextResponse.json({ ok: true });
    if (!(order.payment_method === 'PAY_NOW' || order.payment_method?.startsWith('PAY_NOW:'))) return new NextResponse('Order is not an online-payment order', { status: 400 });

    const { data: branch, error: branchError } = await admin.from('branches').select('organization_id').eq('id', order.branch_id).maybeSingle();
    if (branchError || !branch) return NextResponse.json({ error: 'Webhook branch lookup failed.' }, { status: 500 });
    const keys = resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin, branch.organization_id, order.branch_id));
    if (!keys.enabled || !verifyRazorpayWebhookSignature(rawBody, request.headers.get('x-razorpay-signature') ?? '', { keyId: keys.keyId, keySecret: keys.secret, webhookSecret: keys.webhook })) {
      return new NextResponse('Invalid signature', { status: 400 });
    }

    // Failure events are snapshots and can be delivered after the provider
    // state has changed. Re-fetch them before applying a failure transition.
    const shouldFetchCurrentState = String(entity?.status ?? '').toUpperCase() === 'FAILED';
    const payment = !shouldFetchCurrentState && entity?.amount !== undefined && entity.currency
      ? entity
      : await fetchRazorpayPayment(paymentId, { keyId: keys.keyId, keySecret: keys.secret });
    const expectedAmountInPaise = toRazorpayPaise(Number(order.total));
    if (expectedAmountInPaise === null || !matchesRazorpayPayment(payment, { orderId: razorpayOrderId, paymentId, amountInPaise: expectedAmountInPaise, currency: 'INR' })) {
      return new NextResponse('Payment order, amount or currency mismatch', { status: 400 });
    }

    const status = String(payment.status ?? '').toUpperCase();
    if (status === 'FAILED') {
      const { error } = await admin.rpc('record_online_payment_failure_by_provider', {
        p_razorpay_order_id: razorpayOrderId,
        p_razorpay_payment_id: paymentId,
        p_reason: 'Online payment failed',
        p_metadata: { source: 'razorpay-webhook', event: body.event, event_id: request.headers.get('x-razorpay-event-id') },
      });
      if (error) return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 });
    } else if (isRazorpayPaymentCaptured(payment)) {
      // Re-run the idempotent finalizer even when the order already shows PAID:
      // it can repair a missing legacy ledger row without settling twice.
      const { error } = await admin.rpc('finalize_legacy_razorpay_order', {
        p_order_id: order.id,
        p_tracking_token: null,
        p_razorpay_order_id: razorpayOrderId,
        p_razorpay_payment_id: paymentId,
        p_amount_in_paise: payment.amount,
        p_currency: payment.currency,
        p_method: payment.method ?? 'ONLINE',
        p_metadata: { source: 'razorpay-webhook', event: body.event, event_id: request.headers.get('x-razorpay-event-id') },
      });
      if (error) {
        console.error('payments/webhook: legacy order finalization failed', error);
        return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    console.error('payments/webhook: unexpected error', error);
    return NextResponse.json({ error: 'Webhook processing failed.' }, { status: 500 });
  }
}
