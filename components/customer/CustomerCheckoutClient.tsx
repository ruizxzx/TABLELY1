'use client';

import Link from 'next/link';
import { Check, CreditCard, Banknote, Loader2, ShieldCheck, Tag, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CustomerFrame, CustomerBack } from './CustomerLayout';
import { createPublicOrder, createPublicPaymentAttempt, createPayLaterOrder, openPayLaterSession, clearCart, getPublicMenu, getPublicTableContext, getPublicOrderingOptions, previewPublicCheckout, type CartItem, type PublicCheckoutPreview, readCart, readCouponCode, saveCouponCode, clearCouponCode, formatMoney } from '@/lib/customer';
import { getSupabaseBrowserClient } from '@/lib/supabase';

function checkoutKey(tableCode: string) { if (typeof window === 'undefined') return `tablely-checkout:${tableCode}`; const key=`tablely-checkout:${tableCode}`; let current=window.sessionStorage.getItem(key); if(!current){current=crypto.randomUUID();window.sessionStorage.setItem(key,current)} return current; }
async function loadRazorpayScript(){if(typeof window==='undefined')return false;if(window.Razorpay)return true;await new Promise<void>((resolve,reject)=>{const script=document.createElement('script');script.src='https://checkout.razorpay.com/v1/checkout.js';script.async=true;script.onload=()=>resolve();script.onerror=()=>reject(new Error('Could not load Razorpay Checkout. Check your internet connection.'));document.body.appendChild(script)});return Boolean(window.Razorpay)}

export default function CustomerCheckoutClient({ restaurantSlug, tableCode }: { restaurantSlug: string; tableCode: string }) {
  const [context,setContext]=useState<Awaited<ReturnType<typeof getPublicTableContext>>|null>(null);const [cart,setCart]=useState<CartItem[]>([]);const [method,setMethod]=useState<'PAY_NOW'|'PAY_AT_COUNTER'|'PAY_LATER'>('PAY_AT_COUNTER');const [counterEnabled,setCounterEnabled]=useState(true);const [onlineEnabled,setOnlineEnabled]=useState(false);const [payLaterEnabled,setPayLaterEnabled]=useState(false);const [note,setNote]=useState('');const [customerName,setCustomerName]=useState('');const [customerPhone,setCustomerPhone]=useState('');const [coupon,setCoupon]=useState('');const [couponInput,setCouponInput]=useState('');const [preview,setPreview]=useState<PublicCheckoutPreview|null>(null);const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);const [previewBusy,setPreviewBusy]=useState(false);const [error,setError]=useState<string|null>(null);

  useEffect(()=>{Promise.all([getPublicTableContext(tableCode),getPublicMenu(tableCode),getPublicOrderingOptions(tableCode)]).then(async([table,rows,paymentOptions])=>{if(table.restaurant_slug!==restaurantSlug)throw new Error('Invalid restaurant QR.');const original=readCart(tableCode);if(!original.length)throw new Error('Your cart is empty.');const available=new Map(rows.filter(x=>x.item_id).map(x=>[x.item_id!,x]));const valid=original.flatMap(item=>{const row=available.get(item.menuItemId);if(!row?.is_available||row.item_price===null)return[];const latestAddons=new Map((row.addons??[]).map(addon=>[addon.name,Number(addon.price||0)]));const selected=(item.addons??[]).filter(addon=>latestAddons.has(addon.name)).map(addon=>({name:addon.name,price:latestAddons.get(addon.name)??addon.price}));if(selected.length!==(item.addons??[]).length)return[];const addonTotal=selected.reduce((sum,addon)=>sum+addon.price,0);return[{...item,price:Number(row.item_price)+addonTotal,addons:selected}]});if(!valid.length)throw new Error('All items in your cart are unavailable.');if(valid.length!==original.length)throw new Error('One or more items in your cart changed or became unavailable. Please review your cart.');const code=readCouponCode(tableCode);setContext(table);setCart(valid);setCounterEnabled(paymentOptions.pay_at_counter_enabled);setOnlineEnabled(paymentOptions.online_payment_enabled);setPayLaterEnabled(paymentOptions.pay_later_available);if(!paymentOptions.pay_at_counter_enabled&&paymentOptions.online_payment_enabled)setMethod('PAY_NOW');setCoupon(code);setCouponInput(code);
    const supabase=getSupabaseBrowserClient();
    if(supabase){const{data:{user}}=await supabase.auth.getUser();if(user){const{data:profile}=await supabase.from('customer_profiles').select('name,phone,customer_account_enabled').eq('auth_user_id',user.id).maybeSingle();if(profile?.customer_account_enabled){setCustomerName(profile.name??'');setCustomerPhone(profile.phone??'');}}}
    setLoading(false)}).catch((err:unknown)=>{setError(err instanceof Error?err.message:'Could not load checkout.');setLoading(false)})},[restaurantSlug,tableCode]);

  async function refreshPreview(code=coupon,phone=customerPhone){if(!cart.length)return;setPreviewBusy(true);try{const normalized=phone.replace(/[^0-9]/g,'').replace(/^91(?=\d{10}$)/,'');const p=await previewPublicCheckout(tableCode,cart,code||null,/^[6-9]\d{9}$/.test(normalized)?normalized:undefined);setPreview(p);setError(null)}catch(e:unknown){setPreview(null);if(code)setError(e instanceof Error?e.message:'Could not validate coupon.')}finally{setPreviewBusy(false)}}
  useEffect(()=>{if(!loading&&cart.length)void refreshPreview(coupon);},[loading,cart]);
  useEffect(()=>{const onCoupon=()=>{const code=readCouponCode(tableCode);setCoupon(code);setCouponInput(code);void refreshPreview(code)};window.addEventListener('tablely-coupon-change',onCoupon);return()=>window.removeEventListener('tablely-coupon-change',onCoupon)},[tableCode,cart,customerPhone]);

  function finishOrder(result:{tracking_token:string}){clearCart(tableCode);clearCouponCode(tableCode);if(typeof window!=='undefined')window.sessionStorage.removeItem(`tablely-checkout:${tableCode}`);window.location.href=`/r/${restaurantSlug}/table/${tableCode}/order/${result.tracking_token}`;}
  async function saveAuthenticatedCustomerContact(name:string,phone:string){
    const supabase=getSupabaseBrowserClient();
    if(!supabase)return;
    const{data:{user},error:userError}=await supabase.auth.getUser();
    if(userError)throw new Error(userError.message);
    if(!user)return;
    const{data:profile,error:profileError}=await supabase.from('customer_profiles').select('customer_account_enabled').eq('auth_user_id',user.id).maybeSingle();
    if(profileError)throw new Error(profileError.message);
    if(!profile?.customer_account_enabled)return;
    const{error:updateError}=await supabase.rpc('update_customer_profile',{p_name:name,p_phone:phone});
    if(updateError)throw new Error(updateError.message);
  }
  async function placeCounterOrder(){const result=await createPublicOrder({tableCode,items:cart,paymentMethod:'PAY_AT_COUNTER',idempotencyKey:checkoutKey(tableCode),note,customerName:customerName.trim(),customerPhone:customerPhone.trim(),couponCode:coupon||undefined});finishOrder(result)}
  async function placePayLaterOrder(){const session=await openPayLaterSession(tableCode);const result=await createPayLaterOrder({tableCode,items:cart,sessionId:session.id,idempotencyKey:checkoutKey(tableCode),note,couponCode:coupon||undefined});finishOrder(result)}
  async function placePaidOrder(){const attempt=await createPublicPaymentAttempt({tableCode,items:cart,idempotencyKey:checkoutKey(tableCode),note,customerName:customerName.trim(),customerPhone:customerPhone.trim(),couponCode:coupon||undefined});const response=await fetch('/api/payments/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paymentAttemptId:attempt.payment_attempt_id,attemptToken:attempt.attempt_token})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error??'Could not initialize online payment.');const ready=await loadRazorpayScript();if(!ready||!window.Razorpay)throw new Error('Razorpay Checkout is unavailable.');const Razorpay=window.Razorpay;const rzp=new Razorpay({key:body.keyId,amount:body.amount,currency:body.currency??'INR',order_id:body.razorpayOrderId,name:context?.restaurant_name??'Tablely',description:`Table ${context?.table_number??''} · Online payment`,handler:async(paymentResponse:{razorpay_payment_id:string;razorpay_order_id:string;razorpay_signature:string})=>{try{const verification=await fetch('/api/payments/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paymentAttemptId:attempt.payment_attempt_id,attemptToken:attempt.attempt_token,razorpayPaymentId:paymentResponse.razorpay_payment_id,razorpayOrderId:paymentResponse.razorpay_order_id,razorpaySignature:paymentResponse.razorpay_signature})});const payload=await verification.json().catch(()=>({}));if(!verification.ok)throw new Error(payload.error??'Payment verification failed.');if(!payload.trackingToken)throw new Error('Payment verified but order confirmation was not returned.');finishOrder({tracking_token:payload.trackingToken})}catch(err:unknown){setError(err instanceof Error?err.message:'Payment verification failed.');setBusy(false)}},modal:{ondismiss:()=>setBusy(false)}});rzp.on('payment.failed',async(failure:unknown)=>{try{const response=(failure as {response?:{error?:{description?:string;reason?:string;code?:string;metadata?:{payment_id?:string}}}}).response;const errorInfo=response?.error??{};const fr=await fetch('/api/payments/failure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paymentAttemptId:attempt.payment_attempt_id,attemptToken:attempt.attempt_token,razorpayOrderId:body.razorpayOrderId,razorpayPaymentId:errorInfo.metadata?.payment_id??null,reason:errorInfo.description??errorInfo.reason??errorInfo.code??'Online payment failed'})});if(!fr.ok)throw new Error('Payment failed.');setError('Payment failed. Your order was not placed. Please try again.');setBusy(false)}catch(err:unknown){setError(err instanceof Error?err.message:'Payment failed.');setBusy(false)}});rzp.open()}
  async function applyCoupon(){const code=couponInput.trim().toUpperCase();if(!code){clearCouponCode(tableCode);setCoupon('');await refreshPreview('');return;}setPreviewBusy(true);setError(null);try{const normalized=customerPhone.replace(/[^0-9]/g,'').replace(/^91(?=\d{10}$)/,'');const p=await previewPublicCheckout(tableCode,cart,code,/^[6-9]\d{9}$/.test(normalized)?normalized:undefined);saveCouponCode(tableCode,code);setCoupon(code);setPreview(p)}catch(e:unknown){setError(e instanceof Error?e.message:'Could not apply coupon.');setCoupon('');clearCouponCode(tableCode)}finally{setPreviewBusy(false)}}
  function removeCoupon(){clearCouponCode(tableCode);setCoupon('');setCouponInput('');void refreshPreview('')}
  async function requireCustomerAuth() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError && !authError.message.toLowerCase().includes('auth session missing')) {
      throw new Error(authError.message);
    }
    if (!user) {
      const next = typeof window === 'undefined' ? `/r/${restaurantSlug}/table/${tableCode}/checkout` : window.location.pathname;
      window.location.href = `/customer/login?next=${encodeURIComponent(next)}`;
      return false;
    }
    const metadata = user.user_metadata ?? {};
    const { error: activationError } = await supabase.rpc('activate_customer_account', {
      p_name: String(metadata.full_name ?? metadata.name ?? ''),
      p_phone: String(metadata.phone ?? ''),
    });
    if (activationError) {
      const missingFunction = activationError.message.toLowerCase().includes('could not find the function')
        || activationError.message.toLowerCase().includes('schema cache');
      if (!missingFunction) throw new Error(`Could not activate your customer account: ${activationError.message}`);

      const { data: legacyProfile, error: legacyError } = await supabase.rpc('build22_current_customer_profile');
      if (legacyError || !legacyProfile) {
        throw new Error('Customer account setup is incomplete. Please run the latest customer identity SQL migration in Supabase, then try again.');
      }
    }
    return true;
  }

  async function selectPayLater() {
    if (!payLaterEnabled) {
      setError('Pay After Delivery is not available for this branch.');
      return;
    }
    try {
      if (!(await requireCustomerAuth())) return;
      setMethod('PAY_LATER');
      setError(null);
    } catch (error: unknown) {
      setMethod('PAY_AT_COUNTER');
      setError(error instanceof Error ? error.message : 'Could not enable Pay After Delivery.');
    }
  }

  async function placeOrder(){if(!cart.length||!context||busy)return;const normalizedPhone=customerPhone.replace(/[^0-9]/g,'').replace(/^91(?=\d{10}$)/,'');if(method==='PAY_LATER'&&!(await requireCustomerAuth()))return;if(!customerName.trim()){setError('Please enter your name.');return;}if(!/^[6-9]\d{9}$/.test(normalizedPhone)){setError('Please enter a valid 10-digit mobile number.');return;}if(method==='PAY_AT_COUNTER'&&!counterEnabled){setError('Pay at counter is not available for this branch.');return;}if(method==='PAY_LATER'&&!payLaterEnabled){setError('Pay After Delivery is not available for this branch.');return;}setBusy(true);setError(null);try{await saveAuthenticatedCustomerContact(customerName.trim(),normalizedPhone);if(method==='PAY_AT_COUNTER')await placeCounterOrder();else if(method==='PAY_LATER')await placePayLaterOrder();else await placePaidOrder()}catch(err:unknown){setError(err instanceof Error?err.message:'Could not place order.');setBusy(false)}}

  if(loading)return <main className="customer-page customer-loading">Loading checkout…</main>;if(!context)return <main className="customer-page"><div className="customer-error"><h1>Checkout unavailable</h1><p>{error}</p><Link className="customer-primary-button" href={`/r/${restaurantSlug}/table/${tableCode}`}>Back to menu</Link></div></main>;
  const subtotal=preview?.subtotal??cart.reduce((sum,item)=>sum+item.price*item.quantity,0);const discount=preview?.discount??0;const discounted=preview?.discounted_subtotal??Math.max(0,subtotal-discount);const tax=preview?.tax??0;const fees=preview?.additional_charges??0;const total=preview?.total??Math.round((subtotal-discount+tax+fees)*100)/100;const breakdown=preview?.charge_breakdown??[];
  return <CustomerFrame restaurantName={context.restaurant_name} tableNumber={context.table_number} tableCode={context.table_code} restaurantSlug={context.restaurant_slug}><div className="customer-content customer-checkout-page"><CustomerBack href={`/r/${restaurantSlug}/table/${tableCode}/cart`} label="Cart"/><div className="customer-page-title"><span className="customer-eyebrow">CHECKOUT</span><h1>Place your order</h1><p>Table {context.table_number} · {cart.reduce((s,x)=>s+x.quantity,0)} items</p></div>{error?<div className="notice notice-error" role="alert">{error}</div>:null}
    <div className="customer-checkout-card"><div className="customer-payment-heading"><h2>Your details</h2><span>Required for your order</span></div><label>Customer name<input value={customerName} onChange={e=>setCustomerName(e.target.value)} maxLength={120} autoComplete="name" placeholder="Your name" required/></label><label>Mobile number<input value={customerPhone} onChange={e=>setCustomerPhone(e.target.value)} onBlur={()=>coupon?void refreshPreview(coupon,customerPhone):undefined} inputMode="tel" maxLength={15} autoComplete="tel" placeholder="10-digit mobile number" required/></label></div>
    <div className="customer-checkout-card customer-coupon-card"><div className="customer-payment-heading"><h2><Tag size={16}/> Coupon or offer</h2><span>{coupon?'Applied':'Optional'}</span></div>{coupon?<div className="customer-applied-coupon"><div><strong>{coupon}</strong><small>{discount>0?`${formatMoney(discount)} discount applied`:'Coupon validated'}</small></div><button type="button" className="customer-remove" onClick={removeCoupon}><X size={14}/> Remove</button></div>:<div className="customer-coupon-row"><input value={couponInput} onChange={e=>setCouponInput(e.target.value.toUpperCase())} placeholder="Enter coupon code" maxLength={64}/><button type="button" className="button button-light" onClick={()=>void applyCoupon()} disabled={previewBusy}>{previewBusy?<Loader2 size={15} className="spin"/>:'Apply'}</button></div>}</div>
    <div className="customer-checkout-card"><div className="customer-payment-heading"><h2>Payment method</h2><span>Choose how you want to pay</span></div>{onlineEnabled?<button type="button" className={`customer-payment-option ${method==='PAY_NOW'?'selected':''}`} onClick={()=>setMethod('PAY_NOW')}><CreditCard size={20}/><span><strong>Pay Online</strong><small>Pay online now and we'll start preparing your order after payment.</small></span>{method==='PAY_NOW'?<Check size={18}/>:null}</button>:null}{counterEnabled?<button type="button" className={`customer-payment-option ${method==='PAY_AT_COUNTER'?'selected':''}`} onClick={()=>setMethod('PAY_AT_COUNTER')}><Banknote size={20}/><span><strong>Pay Now at Counter</strong><small>Pay at the counter now to start your order.</small></span>{method==='PAY_AT_COUNTER'?<Check size={18}/>:null}</button>:null}{payLaterEnabled?<button type="button" className={`customer-payment-option ${method==='PAY_LATER'?'selected':''}`} onClick={()=>void selectPayLater()}><CreditCard size={20}/><span><strong>Pay After Delivery</strong><small>Pay after your food is delivered. Login required.</small></span>{method==='PAY_LATER'?<Check size={18}/>:null}</button>:null}{method==='PAY_NOW'?<div className="payment-trust"><ShieldCheck size={16}/><span>Your payment is processed by Razorpay. Tablely never receives your card or UPI credentials.</span></div>:null}{method==='PAY_LATER'?<div className="payment-trust"><ShieldCheck size={16}/><span>You must sign in or create a TABLELY account before placing a Pay After Delivery order.</span></div>:null}</div>
    <div className="customer-checkout-card"><div className="customer-payment-heading"><h2>Note for the restaurant</h2><span>Optional</span></div><textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={300} rows={3} placeholder="Anything the kitchen should know?"/></div>
    <div className="customer-checkout-card"><div className="customer-payment-heading"><h2>Bill summary</h2><span>{previewBusy?'Recalculating…':'Server-calculated'}</span></div><div className="customer-order-charges"><div className="customer-order-charge-row"><span>Subtotal</span><span>{formatMoney(subtotal)}</span></div>{discount>0?<><div className="customer-order-charge-row customer-discount-row"><span>Discount{coupon?` · ${coupon}`:''}</span><span>−{formatMoney(discount)}</span></div><div className="customer-order-charge-row"><span>Discounted subtotal</span><span>{formatMoney(discounted)}</span></div></>:null}{breakdown.filter(x=>Number(x.amount)>0).map(x=><div className="customer-order-charge-row" key={`${x.name}-${x.charge_type}`}><span>{x.name}{x.calculation_type==='PERCENT'?` (${x.value}%)`:''}</span><span>{formatMoney(Number(x.amount))}</span></div>)}{!breakdown.length&&tax+fees>0?<><div className="customer-order-charge-row"><span>Tax</span><span>{formatMoney(tax)}</span></div><div className="customer-order-charge-row"><span>Charges</span><span>{formatMoney(fees)}</span></div></>:null}</div></div>
    <div className="customer-total-card"><div><span>Final payable</span><strong>{formatMoney(total)}</strong></div><button className="customer-primary-button" disabled={busy||previewBusy} onClick={placeOrder}>{busy?<><Loader2 size={16} className="spin"/> {method==='PAY_NOW'?'Opening payment…':'Placing…'}</>:method==='PAY_NOW'?'Pay & place order':'Place order'}</button></div>
  </div></CustomerFrame>;
}
