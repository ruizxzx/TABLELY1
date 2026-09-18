'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ClipboardList, RefreshCw } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type OngoingOrder = {
  order_id: string;
  order_number: number;
  restaurant_name: string;
  created_at: string;
  total: number;
  status: string;
  payment_status: string;
};

export default function CustomerOrdersPage() {
  const [orders, setOrders] = useState<OngoingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setLoading(true); setError(null);
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) { window.location.href = '/customer/login?next=/customer/orders'; return; }
    const { data, error: rpcError } = await supabase.rpc('get_my_customer_ongoing_orders');
    if (rpcError) setError(rpcError.message);
    else setOrders((data ?? []) as OngoingOrder[]);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel('customer-ongoing-orders')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => { void load(); })
      .subscribe();
    const fallback = window.setInterval(() => { void load(); }, 30000);
    const onVisibility = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(fallback);
      document.removeEventListener('visibilitychange', onVisibility);
      void supabase.removeChannel(channel);
    };
  }, []);

  return <main className="auth-page"><div className="auth-panel" style={{ maxWidth: 760 }}>
    <div className="eyebrow">TABLELY CUSTOMER</div><h1>Ongoing orders</h1>
    <p>Track orders that are still being prepared or served.</p>
    <div className="button-row" style={{ marginTop: 18 }}><Link href="/customer/account" className="button button-light">Account</Link><button className="button button-light" onClick={() => void load()}><RefreshCw size={14}/> Refresh</button></div>
    {error ? <div className="notice notice-error">{error}</div> : null}
    {loading ? <p className="muted-small">Loading your orders…</p> : orders.length ? orders.map(order => <section className="customer-checkout-card" key={order.order_id}>
      <div className="ops-order-meta"><span><ClipboardList size={15}/> Order #{order.order_number}</span><strong>₹{Number(order.total).toLocaleString('en-IN')}</strong></div>
      <p className="muted-small">{order.restaurant_name} · {new Date(order.created_at).toLocaleString('en-IN')}</p>
      <div className="orders-summary"><span>Status</span><strong>{order.status}</strong></div>
      <div className="orders-summary"><span>Payment</span><strong>{order.payment_status}</strong></div>
    </section>) : <section className="customer-empty-card"><p>No ongoing orders right now.</p><Link href="/" className="button button-primary">Browse restaurants</Link></section>}
  </div></main>;
}
