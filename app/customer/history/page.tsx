'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { History as HistoryIcon } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type HistoryRow = { order_id: string; order_number: number; restaurant_name: string; created_at: string; total: number; status: string };

export default function CustomerHistoryPage() {
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    void (async () => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) { window.location.href = '/customer/login?next=/customer/history'; return; }
      const { data, error: rpcError } = await supabase.rpc('get_my_customer_history');
      if (rpcError) setError(rpcError.message);
      else setHistory((data ?? []) as HistoryRow[]);
    })();
  }, []);

  return <main className="auth-page"><div className="auth-panel" style={{ maxWidth: 760 }}>
    <div className="eyebrow">TABLELY CUSTOMER</div><h1>Order history</h1><p>Everything you have ordered with your account.</p>
    <div className="button-row" style={{ marginTop: 18 }}><Link href="/customer/orders" className="button button-light">Ongoing orders</Link><Link href="/customer/account" className="button button-light">Account</Link></div>
    {error ? <div className="notice notice-error">{error}</div> : null}
    {history.length ? history.map(row => <section className="customer-checkout-card" key={row.order_id}><div className="ops-order-meta"><span><HistoryIcon size={15}/> #{row.order_number} · {row.restaurant_name}</span><strong>₹{Number(row.total).toLocaleString('en-IN')}</strong></div><p className="muted-small">{new Date(row.created_at).toLocaleDateString('en-IN')} · {row.status}</p><Link href={`/customer/history/${row.order_id}`} className="button button-light compact">View details / repeat</Link></section>) : <section className="customer-empty-card"><p>No authenticated orders yet.</p><Link href="/" className="button button-primary">Browse restaurants</Link></section>}
  </div></main>;
}
