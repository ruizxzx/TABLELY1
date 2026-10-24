import { NextResponse } from 'next/server';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';
import { fetchRazorpayPayment } from '@/lib/razorpay';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';
import { isRazorpayPaymentCaptured, matchesRazorpayPayment, toRazorpayPaise } from '@/lib/payment-validation.mjs';

export const dynamic = 'force-dynamic';

function csvCell(value: unknown) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const branchId = url.searchParams.get('branchId');
  const resolved = await resolveServerRestaurantAccess({ branchId, permission: 'PAYMENTS' });
  if (resolved.error) return resolved.error;

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const search = url.searchParams.get('q')?.slice(0, 120) || null;
  const method = url.searchParams.get('method')?.slice(0, 32) || null;
  const status = url.searchParams.get('status')?.slice(0, 32) || null;
  const exportCsv = url.searchParams.get('export') === 'csv';
  const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page')) || 1));
  const pageSize = exportCsv ? 100 : Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize')) || 50));

  const callPage = (offset: number, limit: number) => resolved.access.supabase.rpc('get_payment_reconciliation_dashboard', {
    p_branch_id: resolved.access.branchId,
    p_from: from ? new Date(from).toISOString() : null,
    p_to: to ? new Date(to).toISOString() : null,
    p_search: search,
    p_method: method,
    p_status: status,
    p_limit: limit,
    p_offset: offset,
  });

  try {
    const { data, error } = await callPage((page - 1) * pageSize, pageSize);
    if (error) return NextResponse.json({ error: 'Could not load payment reconciliation data.' }, { status: 500 });
    const result = data as { rows?: Array<Record<string, unknown>>; summary?: Record<string, unknown>; total_rows?: number };
    if (exportCsv) {
      const total = Math.min(Number(result.total_rows ?? 0), 100000);
      const rows = [...(result.rows ?? [])];
      for (let offset = rows.length; offset < total; offset += 100) {
        const { data: next, error: nextError } = await callPage(offset, 100);
        if (nextError) return NextResponse.json({ error: 'Could not finish the transaction export.' }, { status: 500 });
        rows.push(...(((next as typeof result)?.rows) ?? []));
      }
      const columns = ['transaction_id','order_id','order_number','customer_name','customer_phone','expected_total','actual_amount','currency','provider','provider_order_id','provider_payment_id','method','transaction_status','order_payment_status','order_status','transaction_date','order_date','paid_at','duplicate_reference','issue'];
      const body = [columns.join(','), ...rows.map(row => columns.map(key => csvCell(row[key])).join(','))].join('\r\n');
      return new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tablely-payments-${new Date().toISOString().slice(0,10)}.csv"`, 'Cache-Control': 'private, no-store' } });
    }
    return NextResponse.json({ ...result, page, pageSize, branchId: resolved.access.branchId }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return NextResponse.json({ error: 'Invalid reconciliation filter.' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const resolved = await resolveServerRestaurantAccess({ permission: 'PAYMENTS' });
  if (resolved.error) return resolved.error;
  let body: { orderId?: string; transactionId?: string; action?: string; note?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  if (body.action === 'verify_gateway') {
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    const transactionId = typeof body.transactionId === 'string' ? body.transactionId : '';
    if (!orderId) return NextResponse.json({ error: 'Order reference is required.' }, { status: 400 });
    const { data: order, error: orderError } = await resolved.access.admin.from('orders')
      .select('id,branch_id,total,payment_status,status,payment_method,razorpay_order_id,razorpay_payment_id')
      .eq('id', orderId).eq('branch_id', resolved.access.branchId).maybeSingle();
    if (orderError || !order) return NextResponse.json({ error: 'Order not found in this branch.' }, { status: 404 });
    if (!(order.payment_method === 'PAY_NOW' || order.payment_method?.startsWith('PAY_NOW:')) || !order.razorpay_order_id) {
      return NextResponse.json({ error: 'This order has no verified Razorpay order reference.' }, { status: 409 });
    }
    const { data: transaction } = transactionId ? await resolved.access.admin.from('payment_transactions')
      .select('provider,provider_order_id,provider_payment_id,amount,currency,branch_id,order_id').eq('id', transactionId).eq('order_id', orderId).maybeSingle() : { data: null };
    const paymentId = order.razorpay_payment_id || transaction?.provider_payment_id;
    if (!paymentId || (transaction && transaction.provider !== 'RAZORPAY')) return NextResponse.json({ error: 'A stored Razorpay payment reference is required before gateway verification.' }, { status: 409 });
    const { data: branch, error: branchError } = await resolved.access.admin.from('branches').select('organization_id').eq('id', order.branch_id).maybeSingle();
    if (branchError || !branch) return NextResponse.json({ error: 'Branch configuration could not be loaded.' }, { status: 500 });
    try {
      const keys = resolveRazorpayCredentials(await getRestaurantPaymentSettings(resolved.access.admin, branch.organization_id, order.branch_id));
      if (!keys.enabled) return NextResponse.json({ error: 'Restaurant Razorpay credentials are not configured.' }, { status: 409 });
      const payment = await fetchRazorpayPayment(paymentId, { keyId: keys.keyId, keySecret: keys.secret });
      const expectedAmountInPaise = toRazorpayPaise(Number(order.total));
      if (expectedAmountInPaise === null || !matchesRazorpayPayment(payment, { orderId: order.razorpay_order_id, paymentId, amountInPaise: expectedAmountInPaise, currency: 'INR' })) {
        const { error: noteError } = await resolved.access.supabase.rpc('add_payment_reconciliation_note', { p_order_id: order.id, p_transaction_id: transactionId || null, p_action: 'ESCALATED', p_note: 'Gateway verification detected a payment reference, amount, order or currency mismatch.' });
        return NextResponse.json({ error: noteError
          ? 'Gateway amount, order or currency differs from TABLELY. No financial state was changed, and the audit note could not be recorded.'
          : 'Gateway amount, order or currency differs from TABLELY. An audit note was recorded; no financial state was changed.' }, { status: 409 });
      }
      if (!isRazorpayPaymentCaptured(payment)) return NextResponse.json({ ok: true, captured: false, gatewayStatus: payment.status });
      const { error: finalizeError } = await resolved.access.admin.rpc('finalize_legacy_razorpay_order', {
        p_order_id: order.id, p_tracking_token: null, p_razorpay_order_id: order.razorpay_order_id,
        p_razorpay_payment_id: paymentId, p_amount_in_paise: payment.amount, p_currency: payment.currency,
        p_method: payment.method || 'ONLINE', p_metadata: { source: 'BUILD29_OWNER_RECONCILIATION' },
      });
      if (finalizeError) return NextResponse.json({ error: 'Provider verification passed, but the protected finalizer rejected the settlement.' }, { status: 409 });
      return NextResponse.json({ ok: true, captured: true, gatewayStatus: payment.status });
    } catch {
      return NextResponse.json({ error: 'Razorpay could not verify this reference. No financial state was changed.' }, { status: 502 });
    }
  }
  const orderId = body.orderId || null;
  const transactionId = body.transactionId || null;
  const action = body.action || 'NOTE';
  const note = body.note?.trim() || '';
  if ((!orderId && !transactionId) || note.length < 1 || note.length > 2000) return NextResponse.json({ error: 'Choose a transaction and enter a note up to 2,000 characters.' }, { status: 400 });
  const { data, error } = await resolved.access.supabase.rpc('add_payment_reconciliation_note', {
    p_order_id: orderId, p_transaction_id: transactionId, p_action: action, p_note: note,
  });
  if (error) return NextResponse.json({ error: 'Could not save the reconciliation note.' }, { status: 400 });
  return NextResponse.json({ ok: true, id: data });
}
