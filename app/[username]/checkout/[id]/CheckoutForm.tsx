'use client';

import Script from 'next/script';
import { useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { createAnalyticsEventId, getAnalyticsAttribution, getAnalyticsIdentity } from '../../../lib/analytics-client';

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

type RazorpayResponse = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

export default function CheckoutForm({
  productId,
  productTitle,
  amount,
  currency,
  storeId,
}: {
  productId: string;
  productTitle: string;
  amount: number;
  currency: string;
  storeId: string;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [scriptReady, setScriptReady] = useState(false);
  const [message, setMessage] = useState('');
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState('');
  const [checkoutAmount, setCheckoutAmount] = useState(amount);
  const formatted = useMemo(() => `₹${Number(checkoutAmount).toLocaleString('en-IN')}`, [checkoutAmount]);

  async function applyCoupon(){
    setMessage('');setAppliedCoupon('');
    if(!couponCode.trim()) return;
    try{
      if(!isValidEmail(email)){setMessage('Enter a valid email address before applying a coupon.');return;}
      const r=await fetch('/api/payments/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId,buyerEmail:email.trim().toLowerCase(),couponCode:couponCode.trim()})});
      const d=await r.json();
      if(!r.ok||!d.ok) throw new Error(d.error||'Coupon could not be applied.');
      setCheckoutAmount(Number(d.amountMajor||amount));
      setAppliedCoupon(couponCode.trim().toUpperCase());
      setMessage('Coupon applied.');
    }catch(e){setCheckoutAmount(amount);setMessage(e instanceof Error?e.message:'Coupon could not be applied.');}
  }

  async function startPayment() {
    setMessage('');
    if (!isValidEmail(email)) {
      setMessage('Enter a valid email address.');
      return;
    }
    if (!window.Razorpay) {
      setMessage('Payment checkout is still loading. Please try again.');
      return;
    }
    setBusy(true);
    let paymentCompleted = false;
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const { sessionId, visitorId } = getAnalyticsIdentity();
      const analytics = { sessionId, visitorId, ...getAnalyticsAttribution() };
      const response = await fetch('/api/payments/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ productId, buyerEmail: email.trim().toLowerCase(), couponCode: appliedCoupon || undefined, analytics }),
      });
      const data = await response.json() as { ok?: boolean; error?: string; keyId?: string; orderId?: string; providerOrderId?: string; amount?: number; currency?: string; cancelToken?: string };
      if (!response.ok || !data.ok || !data.keyId || !data.orderId || !data.providerOrderId) {
        throw new Error(data.error || 'Could not initialize payment.');
      }

      void fetch('/api/analytics/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storeId,productId,eventType:'checkout_start',eventId:createAnalyticsEventId('checkout_start'),...analytics,checkoutId:data.orderId})}).catch(()=>undefined);

      const cancelToken = data.cancelToken || '';
      const options = {
        key: data.keyId,
        order_id: data.providerOrderId,
        amount: data.amount,
        currency: data.currency || currency,
        name: 'TABLELY',
        description: productTitle,
        prefill: { email: email.trim().toLowerCase() },
        notes: { sellora_order_id: data.orderId },
        handler: async (razorpay: RazorpayResponse) => {
          paymentCompleted = true;
          try {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), 30000);
            let verifyResponse: Response;
            try {
              verifyResponse = await fetch('/api/payments/razorpay/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  orderId: data.orderId,
                  razorpayOrderId: razorpay.razorpay_order_id,
                  razorpayPaymentId: razorpay.razorpay_payment_id,
                  razorpaySignature: razorpay.razorpay_signature,
                }),
                signal: controller.signal,
              });
            } finally {
              window.clearTimeout(timeout);
            }
            const verify = await verifyResponse.json() as { ok?: boolean; orderId?: string; orderUrl?: string; accessToken?: string; error?: string; status?: string };
            if (!verifyResponse.ok || !verify.ok || !verify.orderId) {
              throw new Error(verify.error || 'Payment could not be verified. Please wait a moment and check your order.');
            }
            window.location.assign(verify.orderUrl || `/payment-success/${encodeURIComponent(verify.orderId!)}?token=${encodeURIComponent(verify.accessToken || '')}`);
          } catch (error) {
            setBusy(false);
            setMessage(error instanceof DOMException && error.name === 'AbortError' ? 'Payment verification is taking too long. Your payment may already be recorded. Please open your order from the payment confirmation or retry after a moment.' : (error instanceof Error ? error.message : 'Payment verification failed.'));
          }
        },
        modal: {
          ondismiss: () => {
            setBusy(false);
            if (!paymentCompleted) {
              void fetch('/api/payments/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: data.orderId, cancelToken }) }).catch(() => undefined);
            }
          },
        },
        theme: { color: '#5b4be7' },
      };
      const checkout = new window.Razorpay(options);
      checkout.open();
    } catch (error) {
      setBusy(false);
      setMessage(error instanceof Error ? error.message : 'Could not start payment.');
    }
  }

  return (
    <>
      <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="afterInteractive" onLoad={() => setScriptReady(true)} onError={() => setMessage('Payment checkout could not load. Check your connection and try again.')} />
      <div>
        <label className="label" htmlFor="buyer-email">Email address</label>
        <input
          id="buyer-email"
          className="input"
          placeholder="you@example.com"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />

        <div className="coupon-row"><input className="input" value={couponCode} onChange={e=>{setCouponCode(e.target.value.toUpperCase());setAppliedCoupon('');setCheckoutAmount(amount);}} placeholder="Discount code" disabled={busy}/><button className="btn btn-sm" type="button" onClick={()=>void applyCoupon()} disabled={busy||!email}>Apply</button></div>{appliedCoupon&&<div className="success-box" style={{marginTop:8}}>Applied {appliedCoupon}. Final total will be checked on the server.</div>}
        <div style={{ marginTop: 20, padding: 14, borderRadius: 14, background: '#f6f4ff', color: '#5d46b7', fontSize: 12, lineHeight: 1.6 }}>
          You will complete payment in Razorpay Checkout. TABLELY marks the order paid only after server-side signature and payment-status verification.
        </div>
        {message && <div className="error-box" style={{ marginTop: 12 }}>{message}</div>}
        <button className="btn btn-primary" type="button" disabled={busy || !scriptReady} onClick={startPayment} style={{ width: '100%', marginTop: 18 }}>
          {busy ? 'Opening payment…' : !scriptReady ? 'Loading payment…' : `Pay ${formatted} →`}
        </button>
        <p className="muted" style={{ fontSize: 11, lineHeight: 1.6, marginTop: 12 }}>
          Payment uses {currency}. No customer account is required.
        </p>
      </div>
    </>
  );
}
