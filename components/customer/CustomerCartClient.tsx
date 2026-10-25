'use client';

import Link from 'next/link';
import { Minus, Plus, Trash2, Tag, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CustomerFrame, CustomerBack } from './CustomerLayout';
import { cartStorageKey, couponStorageKey, getPublicTableContext, previewPublicCheckout, type CartItem, readCart, saveCart, readCouponCode, saveCouponCode, clearCouponCode, formatMoney, type PublicCheckoutPreview } from '@/lib/customer';

export default function CustomerCartClient({ restaurantSlug, tableCode }: { restaurantSlug: string; tableCode: string }) {
  const [context, setContext] = useState<Awaited<ReturnType<typeof getPublicTableContext>> | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [coupon, setCoupon] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [preview, setPreview] = useState<PublicCheckoutPreview | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getPublicTableContext(tableCode)]).then(([table]) => {
      if (table.restaurant_slug !== restaurantSlug) throw new Error('Invalid restaurant QR.');
      const code=readCouponCode(tableCode); setContext(table); setCart(readCart(tableCode)); setCoupon(code); setCouponInput(code);
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load cart.'));
  }, [restaurantSlug, tableCode]);

  useEffect(() => {
    const onStorage=(event:StorageEvent)=>{
      if(event.storageArea!==window.localStorage || (event.key!==cartStorageKey(tableCode) && event.key!==couponStorageKey(tableCode))) return;
      setCart(readCart(tableCode));
      const code=readCouponCode(tableCode); setCoupon(code); setCouponInput(code);
    };
    const onCartChange=()=>setCart(readCart(tableCode));
    const onCouponChange=()=>{const code=readCouponCode(tableCode);setCoupon(code);setCouponInput(code);};
    window.addEventListener('storage',onStorage);
    window.addEventListener('tablely-cart-change',onCartChange);
    window.addEventListener('tablely-coupon-change',onCouponChange);
    return()=>{
      window.removeEventListener('storage',onStorage);
      window.removeEventListener('tablely-cart-change',onCartChange);
      window.removeEventListener('tablely-coupon-change',onCouponChange);
    };
  },[tableCode]);

  useEffect(()=>{if(!cart.length){setPreview(null);return;}let cancelled=false;previewPublicCheckout(tableCode,cart,coupon||null).then(x=>{if(!cancelled)setPreview(x)}).catch(()=>{if(!cancelled)setPreview(null)});return()=>{cancelled=true};},[tableCode,cart,coupon]);

  function update(index: number, delta: number) { const next = cart.map((item, i) => i === index ? { ...item, quantity: Math.max(1, Math.min(50, item.quantity + delta)) } : item); setCart(next); saveCart(tableCode, next); }
  function remove(index: number) { const next = cart.filter((_, i) => i !== index); setCart(next); saveCart(tableCode, next); }
  async function apply(){
    const code=couponInput.trim().toUpperCase();
    if(!code){clearCouponCode(tableCode);setCoupon('');return;}
    setCouponBusy(true);setError(null);
    try{const p=await previewPublicCheckout(tableCode,cart,code);saveCouponCode(tableCode,code);setCoupon(code);setPreview(p);}catch(e:unknown){setError(e instanceof Error?e.message:'Could not apply coupon.');clearCouponCode(tableCode);setCoupon('');}
    finally{setCouponBusy(false)}
  }
  function removeCoupon(){clearCouponCode(tableCode);setCoupon('');setCouponInput('');setError(null);}

  if (!context) return <main className="customer-page customer-loading">{error ?? 'Loading cart…'}</main>;
  const subtotal = preview?.subtotal ?? cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const discount = preview?.discount ?? 0;
  const total = preview?.total ?? subtotal;

  return (
    <CustomerFrame restaurantName={context.restaurant_name} tableNumber={context.table_number} tableCode={context.table_code} restaurantSlug={context.restaurant_slug}>
      <div className="customer-content customer-cart-page">
        <CustomerBack href={`/r/${restaurantSlug}/table/${tableCode}`} label="Menu" />
        <div className="customer-page-title"><span className="customer-eyebrow">TABLE {context.table_number}</span><h1>Your order</h1><p>{cart.length} line item{cart.length === 1 ? '' : 's'}</p></div>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        {cart.length === 0 ? (
          <div className="customer-empty-card"><h2>Your cart is empty</h2><p>Add something delicious from the menu.</p><Link className="customer-primary-button" href={`/r/${restaurantSlug}/table/${tableCode}`}>Browse menu</Link></div>
        ) : (
          <>
            <div className="customer-cart-list">
              {cart.map((item, index) => <article className="customer-cart-item" key={`${item.menuItemId}-${index}`}><div className="customer-cart-thumb">{item.imageUrl ? <img src={item.imageUrl} alt="" /> : <span>{item.name.slice(0, 1)}</span>}</div><div className="customer-cart-copy"><h2>{item.name}</h2><strong>{formatMoney(item.price)}</strong>{item.variant ? <small>Variant: {item.variant.name}</small> : null}{item.modifiers?.length ? <small>Options: {item.modifiers.map(m => m.name).join(', ')}</small> : null}{item.note ? <small>{item.note}</small> : null}<div className="customer-cart-actions"><div className="customer-quantity small"><button onClick={() => update(index, -1)} aria-label="Decrease"><Minus size={14} /></button><strong>{item.quantity}</strong><button onClick={() => update(index, 1)} aria-label="Increase"><Plus size={14} /></button></div><button className="customer-remove" onClick={() => remove(index)}><Trash2 size={14} /> Remove</button></div></div></article>)}
            </div>
            <div className="customer-checkout-card customer-coupon-card"><div className="customer-payment-heading"><h2><Tag size={16}/> Coupon or offer</h2><span>{coupon?'Applied':'Optional'}</span></div>{coupon?<div className="customer-applied-coupon"><div><strong>{coupon}</strong><small>{discount>0?`${formatMoney(discount)} discount applied`: 'Coupon validated at checkout'}</small></div><button type="button" className="customer-remove" onClick={removeCoupon}><X size={14}/> Remove</button></div>:<div className="customer-coupon-row"><input value={couponInput} onChange={e=>setCouponInput(e.target.value.toUpperCase())} placeholder="Enter coupon code" maxLength={64}/><button type="button" className="button button-light" onClick={()=>void apply()} disabled={couponBusy}>{couponBusy?<Loader2 size={15} className="spin"/>:'Apply'}</button></div>}</div>
            <div className="customer-total-card"><div><span>Subtotal</span><strong>{formatMoney(subtotal)}</strong>{discount>0?<small className="customer-discount-line">Discount −{formatMoney(discount)}</small>:null}<small className="customer-cart-total-muted">Final payable updates at checkout</small></div><Link href={`/r/${restaurantSlug}/table/${tableCode}/checkout`} className="customer-primary-button">Proceed to checkout · {formatMoney(total)}</Link></div>
          </>
        )}
      </div>
    </CustomerFrame>
  );
}
