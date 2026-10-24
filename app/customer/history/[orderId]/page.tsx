'use client';

import Link from 'next/link';
import { ArrowLeft, FileText, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getPublicMenu, getPublicTableContext, saveCart, type CartItem, type PublicMenuItem } from '@/lib/customer';

type OrderDetail = { order_id: string; order_number: number; restaurant_name: string; branch_name: string; created_at: string; status: string; payment_status: string; payment_method: string | null; total: number; review: { id: string; rating: number; comment: string | null; created_at: string } | null; items: Array<{ menu_item_id: string; item_name_snapshot: string; unit_price: number; quantity: number; selected_addons?: unknown; selected_options?: unknown; special_instructions?: string | null }> };

export default function CustomerOrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [tableCode, setTableCode] = useState('');
  const [repeatBusy, setRepeatBusy] = useState(false);
  const [repeatMessage, setRepeatMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { orderId } = await params;
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) { window.location.href = `/customer/login?next=/customer/history/${orderId}`; return; }
      const { data, error: detailError } = await supabase.rpc('get_my_customer_order_detail', { p_order_id: orderId });
      if (detailError) setError(detailError.message);
      else if (!data) setError('Order not found.');
      else setOrder(data as OrderDetail);
    })();
  }, [params]);

  async function submitReview() {
    if (!order) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setReviewBusy(true); setError(null);
    const { data, error: reviewError } = await supabase.rpc('submit_customer_review', { p_order_id: order.order_id, p_rating: rating, p_comment: comment });
    if (reviewError) setError(reviewError.message);
    else setOrder(current => current ? { ...current, review: data as OrderDetail['review'] } : current);
    setReviewBusy(false);
  }

  async function repeatOrder() {
    if (!order || !tableCode.trim()) { setRepeatMessage('Enter the table code from the current QR menu.'); return; }
    setRepeatBusy(true); setRepeatMessage(null);
    try {
      const context = await getPublicTableContext(tableCode.trim());
      const menu = await getPublicMenu(tableCode.trim());
      const current = new Map(menu.filter(item => item.item_id).map(item => [item.item_id as string, item]));
      const next: CartItem[] = [];
      const unavailable: string[] = [];
      const changed: string[] = [];
      for (const item of order.items) {
        const live = current.get(item.menu_item_id) as PublicMenuItem | undefined;
        if (!live || !live.is_available || live.item_price === null) { unavailable.push(item.item_name_snapshot); continue; }
        const options = Array.isArray(item.selected_options) ? item.selected_options as Array<{ type?: string; id?: string; name?: string }> : [];
        const variantOption = options.find(option => option.type === 'VARIANT');
        if (!variantOption && live.variants?.some(option => option.is_available)) { changed.push(`${item.item_name_snapshot}: the current menu requires a variant selection.`); continue; }
        const variant = variantOption ? live.variants?.find(option => option.id === variantOption.id && option.is_available) : undefined;
        if (variantOption && !variant) { changed.push(`${item.item_name_snapshot}: previous variant is unavailable; choose a current variant from the menu.`); continue; }
        const modifierOptions = options.filter(option => option.type === 'MODIFIER');
        const allModifiers = (live.modifier_groups ?? []).flatMap(group => group.modifiers.map(modifier => ({ ...modifier, groupId: group.id, groupName: group.name })));
        const modifiers = modifierOptions.map(option => {
          const active = allModifiers.find(modifier => modifier.id === option.id && modifier.is_available);
          return active ? { id: active.id, groupId: active.groupId, groupName: active.groupName, name: active.name, priceDelta: Number(active.price_delta) } : null;
        });
        if (modifiers.some(modifier => !modifier)) { changed.push(`${item.item_name_snapshot}: a previous modifier is no longer available; select current options from the menu.`); continue; }
        const requiredWithoutChoice = (live.modifier_groups ?? []).some(group => group.is_required && !modifiers.some(modifier => modifier?.groupId === group.id));
        if (requiredWithoutChoice) { changed.push(`${item.item_name_snapshot}: the menu now requires a new option; select it from the menu.`); continue; }
        const oldAddons = Array.isArray(item.selected_addons) ? item.selected_addons as Array<{ name?: string }> : [];
        const addons = oldAddons.map(old => live.addons?.find(addon => addon.name === old.name)).filter((addon): addon is NonNullable<typeof addon> => Boolean(addon)).map(addon => ({ name: addon.name, price: Number(addon.price) }));
        if (oldAddons.length !== addons.length) { changed.push(`${item.item_name_snapshot}: a previous add-on is unavailable; review it from the menu.`); continue; }
        const currentUnitPrice = Number(live.item_price) + Number(variant?.price_delta ?? 0) + modifiers.reduce((sum, modifier) => sum + Number(modifier?.priceDelta ?? 0), 0) + addons.reduce((sum, addon) => sum + addon.price, 0);
        if (Math.abs(currentUnitPrice - Number(item.unit_price)) > 0.001) changed.push(`${item.item_name_snapshot}: current price is ₹${currentUnitPrice.toFixed(2)} (previously ₹${Number(item.unit_price).toFixed(2)}).`);
        next.push({ menuItemId: item.menu_item_id, name: live.item_name ?? item.item_name_snapshot, price: Number(live.item_price), quantity: item.quantity, imageUrl: live.image_url, note: item.special_instructions ?? '', variant: variant ? { id: variant.id, name: variant.name, priceDelta: Number(variant.price_delta) } : undefined, modifiers: modifiers.filter((modifier): modifier is NonNullable<typeof modifier> => Boolean(modifier)), addons });
      }
      if (!next.length) throw new Error('None of the items from this order are currently available.');
      saveCart(tableCode.trim(), next);
      setRepeatMessage(`${next.length} item${next.length === 1 ? '' : 's'} rebuilt using today's menu and prices. Review the cart before checkout.${[...unavailable.map(name => `${name}: unavailable.`), ...changed].length ? ` ${[...unavailable.map(name => `${name}: unavailable.`), ...changed].join(' ')}` : ''}`);
      window.location.href = `/r/${encodeURIComponent(context.restaurant_slug)}/table/${encodeURIComponent(tableCode.trim())}/cart`;
    } catch (repeatError) {
      setRepeatMessage(repeatError instanceof Error ? repeatError.message : 'Could not repeat this order.');
    } finally {
      setRepeatBusy(false);
    }
  }

  return <main className="auth-page"><div className="auth-panel" style={{ maxWidth: 760 }}><Link href="/customer/history" className="customer-back"><ArrowLeft size={15}/> Order history</Link><div className="eyebrow">TABLELY CUSTOMER</div><h1>{order ? `Order #${order.order_number}` : 'Order details'}</h1>{error ? <div className="notice notice-error">{error}</div> : null}{order ? <><p>{order.restaurant_name} · {order.branch_name} · {new Date(order.created_at).toLocaleString('en-IN')}</p><div className="button-row"><Link href={`/customer/history/${order.order_id}/receipt`} className="button button-primary"><FileText size={14}/> View / print receipt</Link></div><section className="customer-checkout-card"><div className="ops-order-meta"><span>Status: {order.status}</span><strong>₹{Number(order.total).toLocaleString('en-IN')}</strong></div><p className="muted-small">Payment: {order.payment_status} · {order.payment_method || '—'}</p>{order.items.map(item => <div className="ops-order-meta" key={item.menu_item_id}><span>{item.item_name_snapshot} × {item.quantity}</span><strong>₹{Number(item.unit_price * item.quantity).toLocaleString('en-IN')}</strong></div>)}</section>{order.review ? <section className="customer-checkout-card"><h2>Your review</h2><p>{'★'.repeat(order.review.rating)}{'☆'.repeat(5 - order.review.rating)} · {order.review.comment || 'No written feedback.'}</p></section> : (['SERVED', 'COMPLETED'].includes(order.status) && order.payment_status === 'PAID' ? <section className="customer-checkout-card"><h2>Review your visit</h2><label>Rating<select value={rating} onChange={event => setRating(Number(event.target.value))}>{[5, 4, 3, 2, 1].map(value => <option key={value} value={value}>{value} stars</option>)}</select></label><label>Feedback (optional)<textarea value={comment} onChange={event => setComment(event.target.value)} maxLength={1000} rows={4}/></label><button className="button button-primary" disabled={reviewBusy} onClick={() => void submitReview()}>{reviewBusy ? 'Submitting…' : 'Submit review'}</button></section> : null)}<section className="customer-checkout-card"><h2>Repeat this order</h2><p className="muted-small">Prices and availability will be checked against the current menu. Old coupons are not reused.</p><label>Current table code<input value={tableCode} onChange={event => setTableCode(event.target.value)} placeholder="Example: T5"/></label><button className="button button-primary" disabled={repeatBusy} onClick={() => void repeatOrder()}><RefreshCw size={14}/> {repeatBusy ? 'Checking current menu…' : 'Add current items to cart'}</button>{repeatMessage ? <div className="notice notice-success">{repeatMessage}</div> : null}</section></> : !error ? <p className="muted-small">Loading order…</p> : null}</div></main>;
}
