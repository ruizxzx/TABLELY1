'use client';

import Link from 'next/link';
import { Check, Clock3, Circle, RefreshCw, CreditCard, Banknote } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CustomerFrame } from './CustomerLayout';
import { clearCart, formatMoney, getCustomerOrderChannel, getPublicOrder, getPublicTableContext, retryPublicOrder, type PublicOrderRow } from '@/lib/customer';
import { getSupabaseBrowserClient } from '@/lib/supabase';


const steps = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED'];

async function loadRazorpayScript() {
  if (typeof window === 'undefined') return false;
  if (window.Razorpay) return true;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Razorpay Checkout.'));
    document.body.appendChild(script);
  });
  return Boolean(window.Razorpay);
}

function paymentLabel(method: string | null, status: string) {
  if (status === 'FAILED') return 'Online payment failed';
  if (method === 'PAY_AT_COUNTER') return status === 'PAID' ? 'Paid at counter' : 'Awaiting counter payment';
  if (method === 'CASH') return 'Paid · Cash';
  if (method === 'UPI') return 'Paid · UPI';
  if (method?.startsWith('PAY_NOW:')) return status === 'PAID' ? 'Paid online' : 'Pay online';
  if (method === 'PAY_NOW') return status === 'PAID' ? 'Paid online' : 'Pay online';
  return status === 'PAID' ? 'Paid' : 'Payment pending';
}

export default function CustomerOrderClient({ restaurantSlug, tableCode, orderToken }: { restaurantSlug: string; tableCode: string; orderToken: string }) {
  const [context, setContext] = useState<Awaited<ReturnType<typeof getPublicTableContext>> | null>(null);
  const [rows, setRows] = useState<PublicOrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<'PAY_NOW' | 'PAY_AT_COUNTER' | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [engagementLinks, setEngagementLinks] = useState<{ feedbackUrl: string | null; reviewUrl: string | null }>({ feedbackUrl: null, reviewUrl: null });
  const loadSeq = useRef(0);
  const connectedRef = useRef(false);

  async function load() {
    const seq = ++loadSeq.current;
    try {
      const [table, orderRows] = await Promise.all([getPublicTableContext(tableCode), getPublicOrder(orderToken)]);
      if (seq !== loadSeq.current) return;
      if (table.restaurant_slug !== restaurantSlug) throw new Error('Invalid restaurant QR.');
      if (!orderRows.length) throw new Error('Order not found.');
      if (orderRows[0].table_number !== table.table_number) throw new Error('Order does not belong to this table.');
      setContext(table); setRows(orderRows); setError(null);
    } catch (err: unknown) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : 'Could not load order.');
    }
  }

  useEffect(() => {
    void load();
    const fallback = window.setInterval(() => { if (!connectedRef.current) void load(); }, 20000);
    const channel = getCustomerOrderChannel(orderToken);
    if (!channel) return () => window.clearInterval(fallback);
    channel
      .on('broadcast', { event: 'ORDER_STATUS' }, () => void load())
      .on('broadcast', { event: 'INSERT' }, () => void load())
      .on('broadcast', { event: 'CANCELLATION_STATUS' }, (event) => { const payload = event.payload as { status?: string }; void load(); if (payload.status === 'ACCEPTED') setCancelMessage('Cancellation approved by the restaurant.'); else if (payload.status === 'REJECTED') setCancelMessage('Cancellation declined. Your order will continue.'); })
      .subscribe((status) => {
        const live = status === 'SUBSCRIBED';
        connectedRef.current = live;
        setConnected(live);
      });
    const onOnline = () => { connectedRef.current = false; setConnected(false); void load(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(fallback);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      const client = getSupabaseBrowserClient();
      if (client) void client.removeChannel(channel);
    };
  }, [orderToken, tableCode, restaurantSlug]);

  const order = rows[0];
  const items = useMemo(() => rows.filter((row) => row.item_name), [rows]);
  useEffect(() => {
    let active = true;
    setEngagementLinks({ feedbackUrl: null, reviewUrl: null });
    if (!order || order.status !== 'COMPLETED' || order.payment_status !== 'PAID') return () => { active = false; };
    const params = new URLSearchParams({ orderId: order.order_id, trackingToken: orderToken });
    void fetch(`/api/customer-engagement/order?${params}`, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Could not load customer follow-up links.');
        if (active) setEngagementLinks({ feedbackUrl: body.feedbackUrl ?? null, reviewUrl: body.reviewUrl ?? null });
      })
      .catch(() => {
        if (active) setEngagementLinks({ feedbackUrl: null, reviewUrl: null });
      });
    return () => { active = false; };
  }, [order?.order_id, order?.status, order?.payment_status, orderToken]);
  const awaitingOnlinePayment = Boolean(order && order.status === 'NEW' && order.payment_status === 'PENDING' && (order.payment_method === 'PAY_NOW' || order.payment_method?.startsWith('PAY_NOW:')));
  const awaitingCounterPayment = Boolean(order && order.status === 'NEW' && order.payment_status === 'PENDING' && order.payment_method === 'PAY_AT_COUNTER');
  const awaitingPayment = awaitingOnlinePayment || awaitingCounterPayment;
  const currentIndex = order ? Math.max(0, steps.indexOf(order.status)) : -1;
  const canRequestCancel = Boolean(order && ['NEW', 'ACCEPTED', 'PREPARING'].includes(order.status));
  const onlinePaymentCancelled = Boolean(order && order.status === 'CANCELLED' && order.payment_status === 'FAILED' && (order.payment_method === 'PAY_NOW' || order.payment_method?.startsWith('PAY_NOW:')));
  const paymentTimedOut = Boolean(onlinePaymentCancelled && order?.cancellation_reason === 'ONLINE_PAYMENT_TIMEOUT');
  const failedOnline = onlinePaymentCancelled && !paymentTimedOut;
  const counterPaymentNotReceived = Boolean(order?.status === 'CANCELLED' && order.cancellation_reason === 'COUNTER_PAYMENT_NOT_RECEIVED');

  async function requestCancellation() {
    if (!order || cancelBusy) return;
    const reason = window.prompt('Cancellation reason (optional):') ?? '';
    setCancelBusy(true); setCancelMessage(null);
    try {
      const s = getSupabaseBrowserClient();
      if (!s) throw new Error('Supabase is not configured.');
      const { error: rpcError } = await s.rpc('request_order_cancellation', { p_order_id: order.order_id, p_tracking_token: orderToken, p_reason: reason });
      if (rpcError) throw new Error(rpcError.message);
      setCancelMessage('Cancellation request sent. The restaurant must approve it.');
    } catch (e: unknown) { setCancelMessage(e instanceof Error ? e.message : 'Could not request cancellation.'); }
    finally { setCancelBusy(false); }
  }

  async function retryPayment(method: 'PAY_NOW' | 'PAY_AT_COUNTER') {
    if (!order || retryBusy) return;
    setRetryBusy(method); setRetryError(null);
    try {
      const next = await retryPublicOrder({ orderId: order.order_id, trackingToken: orderToken, paymentMethod: method });
      if (method === 'PAY_AT_COUNTER') {
        clearCart(tableCode);
        window.location.href = `/r/${restaurantSlug}/table/${tableCode}/order/${next.tracking_token}`;
        return;
      }
      const ready = await loadRazorpayScript();
      if (!ready || !window.Razorpay) throw new Error('Razorpay Checkout is unavailable.');
      const paymentResponse = await fetch('/api/payments/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: next.order_id, trackingToken: next.tracking_token }) });
      const paymentBody = await paymentResponse.json().catch(() => ({}));
      if (!paymentResponse.ok) throw new Error(paymentBody.error ?? 'Could not initialize online payment.');
      const Razorpay = window.Razorpay;
      const rzp = new Razorpay({
        key: paymentBody.keyId, amount: paymentBody.amount, currency: paymentBody.currency ?? 'INR', order_id: paymentBody.razorpayOrderId,
        name: context?.restaurant_name ?? 'Tablely', description: `Table ${context?.table_number ?? ''} · Order #${next.order_number}`,
        handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
          const verification = await fetch('/api/payments/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: next.order_id, trackingToken: next.tracking_token, razorpayPaymentId: response.razorpay_payment_id, razorpayOrderId: response.razorpay_order_id, razorpaySignature: response.razorpay_signature }) });
          const payload = await verification.json().catch(() => ({}));
          if (!verification.ok) { setRetryError(payload.error ?? 'Payment verification failed.'); setRetryBusy(null); return; }
          clearCart(tableCode);
          window.location.href = `/r/${restaurantSlug}/table/${tableCode}/order/${next.tracking_token}`;
        },
        modal: { ondismiss: () => setRetryBusy(null) },
      });
      rzp.on('payment.failed', async (failure: unknown) => {
        try {
          const response = (failure as { response?: { error?: { description?: string; reason?: string; code?: string; metadata?: { payment_id?: string } } } }).response;
          const errorInfo = response?.error ?? {};
          const fr = await fetch('/api/payments/failure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: next.order_id, trackingToken: next.tracking_token, razorpayOrderId: paymentBody.razorpayOrderId, razorpayPaymentId: errorInfo.metadata?.payment_id ?? null, reason: errorInfo.description ?? errorInfo.reason ?? errorInfo.code ?? 'Online payment failed' }) });
          if (!fr.ok) throw new Error('Payment failed.');
          clearCart(tableCode);
          window.location.href = `/r/${restaurantSlug}/table/${tableCode}/order/${next.tracking_token}`;
        } catch (e: unknown) { setRetryError(e instanceof Error ? e.message : 'Payment failed.'); setRetryBusy(null); }
      });
      rzp.open();
    } catch (e: unknown) { setRetryError(e instanceof Error ? e.message : 'Could not retry payment.'); setRetryBusy(null); }
  }

  if (!context) return <main className="customer-page customer-loading">{error ?? 'Loading order…'}</main>;

  if (order?.status === 'REJECTED') return (
    <CustomerFrame restaurantName={context.restaurant_name} tableNumber={context.table_number} tableCode={context.table_code} restaurantSlug={context.restaurant_slug}>
      <div className="customer-content customer-order-page">
        <div className="customer-order-success">
          <div className="customer-checkmark cancelled">×</div>
          <span className="customer-eyebrow">ORDER #{order.order_number}</span>
          <h1>Order declined.</h1>
          <p>{order.rejection_reason ? `Reason: ${order.rejection_reason.replaceAll('_', ' ').toLowerCase()}.` : 'The restaurant declined this order.'}</p>
          {order.rejection_note ? <p className="customer-rejection-note">{order.rejection_note}</p> : null}
        </div>
        <div className="customer-order-card">
          <div className="customer-payment-heading"><h2>Order status</h2><span>REJECTED</span></div>
          <div className="customer-order-charge-row"><span>Payment</span><span>{paymentLabel(order.payment_method, order.payment_status)}</span></div>
        </div>
        <Link className="customer-secondary-button" href={`/r/${restaurantSlug}/table/${tableCode}`}>Back to menu</Link>
      </div>
    </CustomerFrame>
  );

  if (order?.status === 'CANCELLED') return (
    <CustomerFrame restaurantName={context.restaurant_name} tableNumber={context.table_number} tableCode={context.table_code} restaurantSlug={context.restaurant_slug}>
      <div className="customer-content customer-order-page">
        <div className="customer-order-success">
          <div className="customer-checkmark cancelled">×</div>
          <span className="customer-eyebrow">ORDER #{order.order_number}</span>
          <h1>Order cancelled.</h1>
          <p>{counterPaymentNotReceived ? 'Payment not received. Order cancelled, please reorder!' : failedOnline ? 'Your online payment failed, so this order was cancelled. No food will be prepared for this order.' : paymentTimedOut ? 'Your payment session expired after 1 hour, so this order was cancelled. No food will be prepared for this order.' : 'The restaurant cancelled this order.'}</p>
          {onlinePaymentCancelled ? <div className="customer-checkout-card"><div className="customer-payment-heading"><h2>{paymentTimedOut ? 'Payment session expired' : 'Payment failed'}</h2><span>Choose what to do next</span></div><p className="muted-small">The old order is closed. You can create a new order with online payment or pay at the counter.</p><div className="button-row"><button className="customer-primary-button" onClick={() => void retryPayment('PAY_NOW')} disabled={retryBusy !== null}><CreditCard size={15}/>{retryBusy === 'PAY_NOW' ? 'Opening…' : 'Retry payment'}</button><button className="customer-secondary-button" onClick={() => void retryPayment('PAY_AT_COUNTER')} disabled={retryBusy !== null}><Banknote size={15}/>{retryBusy === 'PAY_AT_COUNTER' ? 'Creating…' : 'Pay at counter'}</button></div>{retryError ? <div className="notice notice-error" role="alert">{retryError}</div> : null}</div> : null}
        </div>
        <Link className="customer-secondary-button" href={`/r/${restaurantSlug}/table/${tableCode}`}>Back to menu</Link>
      </div>
    </CustomerFrame>
  );

  return <CustomerFrame restaurantName={context.restaurant_name} tableNumber={context.table_number} tableCode={context.table_code} restaurantSlug={context.restaurant_slug}>
    <div className="customer-content customer-order-page">
      <div className="customer-order-success"><div className="customer-checkmark">{awaitingPayment ? <CreditCard size={26}/> : <Check size={26} />}</div><span className="customer-eyebrow">ORDER #{order.order_number}</span><h1>{awaitingCounterPayment ? 'Awaiting counter payment.' : awaitingOnlinePayment ? 'Awaiting payment.' : 'Order placed.'}</h1><p>{awaitingCounterPayment ? 'Pay at the counter now to start your order. The restaurant cannot prepare it until payment is confirmed.' : awaitingOnlinePayment ? 'Complete online payment to confirm your order. The restaurant cannot prepare this order until payment succeeds.' : 'Your kitchen has received the order. This page updates automatically.'}</p><span className="muted-small">{connected ? 'Live updates enabled' : 'Reconnecting to live updates'}</span></div>
      {order.status === 'COMPLETED' && order.payment_status === 'PAID' && (engagementLinks.feedbackUrl || engagementLinks.reviewUrl) ? <section className="customer-order-card" aria-label="Share your experience"><div className="customer-payment-heading"><h2>Share your experience</h2><span>Your choice</span></div><p className="muted-small">Your honest feedback is welcome. You can contact the restaurant privately or share your experience on Google. Both options are voluntary.</p><div className="button-row">{engagementLinks.feedbackUrl ? <Link className="customer-secondary-button" href={engagementLinks.feedbackUrl}>Give private feedback</Link> : null}{engagementLinks.reviewUrl ? <a className="customer-secondary-button" href={engagementLinks.reviewUrl}>View Google review link</a> : null}</div></section> : null}
      <div className="customer-order-card"><div className="customer-order-card-head"><div><span>Table {order.table_number}</span><small><Clock3 size={12} /> {new Date(order.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</small></div><button className="customer-refresh" onClick={() => void load()} aria-label="Refresh order"><RefreshCw size={15} /></button></div>{awaitingPayment ? <div className="customer-checkout-card"><div className="customer-payment-heading"><h2>{awaitingCounterPayment ? 'Awaiting counter payment' : 'Payment pending'}</h2><span>{awaitingCounterPayment ? 'Pay now to start' : order.payment_expires_at ? `Expires ${new Date(order.payment_expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Up to 1 hour'}</span></div><p className="muted-small">{awaitingCounterPayment ? 'Your order remains NEW until the counter payment is confirmed.' : 'The restaurant cannot accept, prepare, cancel, or complete this PAY_NOW order until payment succeeds.'}</p></div> : <div className="customer-timeline">{steps.map((step, index) => <div className={`customer-timeline-row ${index <= currentIndex ? 'done' : ''} ${index === currentIndex ? 'current' : ''}`} key={step}><div className="customer-timeline-icon">{index < currentIndex ? <Check size={14} /> : index === currentIndex ? <Circle size={12} fill="currentColor" /> : <span>{index + 1}</span>}</div><div><strong>{step === 'NEW' ? 'Order received' : step === 'ACCEPTED' ? 'Order Accepted' : step === 'PREPARING' ? 'Preparing your order' : step === 'READY' ? 'Order ready' : step === 'SERVED' ? 'Served at your table' : 'Completed'}</strong>{index === currentIndex ? <small>Current status</small> : null}</div></div>)}</div>}</div>
      <div className="customer-order-card"><div className="customer-payment-heading"><h2>Payment</h2><span>{paymentLabel(order.payment_method, order.payment_status)}</span></div><div className="customer-order-charge-row"><span>Method</span><span>{order.payment_method ?? '—'}</span></div><div className="customer-order-charge-row"><span>Status</span><span>{order.payment_status}</span></div></div>
      <div className="customer-order-card"><div className="customer-payment-heading"><h2>Your items</h2><span>{formatMoney(Number(order.total))}</span></div>{items.map((item) => <div className="customer-order-item" key={item.item_id}><span>{item.quantity} × {item.item_name}{item.selected_options?.length?<small>{item.selected_options.map(x=>x.type==='VARIANT'?`Size: ${x.name}`:x.name).join(', ')}</small>:item.selected_addons?.length?<small>{item.selected_addons.map(x=>x.name).join(', ')}</small>:null}</span><b>{formatMoney(Number(item.line_total))}</b></div>)}<div className="customer-order-charges"><div className="customer-order-charge-row"><span>Subtotal</span><span>{formatMoney(Number(order.subtotal))}</span></div>{Number(order.discount) > 0 ? <div className="customer-order-charge-row"><span>Discount</span><span>-{formatMoney(Number(order.discount))}</span></div> : null}{(order.charge_breakdown ?? []).filter((c) => Number(c.amount) > 0).map((c) => <div className="customer-order-charge-row" key={c.name}><span>{c.name}{c.calculation_type === 'PERCENT' ? ` (${c.value}%)` : ''}</span><span>{formatMoney(Number(c.amount))}</span></div>)}</div><div className="customer-order-total"><span>Total</span><strong>{formatMoney(Number(order.total))}</strong></div></div>
      {cancelMessage ? <div className="notice notice-info">{cancelMessage}</div> : null}
      {canRequestCancel ? <button className="customer-secondary-button customer-danger-button" onClick={() => void requestCancellation()} disabled={cancelBusy}>{cancelBusy ? 'Sending…' : 'Request cancellation'}</button> : null}
      <Link className="customer-secondary-button" href={`/r/${restaurantSlug}/table/${tableCode}`}>Order more</Link>
    </div>
  </CustomerFrame>;
}
