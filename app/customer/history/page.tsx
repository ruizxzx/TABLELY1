'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { History as HistoryIcon, Search } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type HistoryRow = { order_id: string; order_number: number; restaurant_name: string; branch_name: string; created_at: string; total: number; order_status: string; payment_status: string; item_count: number };
const PAGE_SIZE = 20;

export default function CustomerHistoryPage() {
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    await Promise.resolve();
    setError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    const { data: user } = await supabase.auth.getUser();
    if (!user.user) { window.location.href = '/customer/login?next=/customer/history'; return; }
    const { data, error: rpcError } = await supabase.rpc('get_my_customer_history_page', { p_query: search || null, p_limit: PAGE_SIZE, p_offset: page * PAGE_SIZE });
    if (rpcError) setError(rpcError.message);
    else {
      const result = data as { rows?: HistoryRow[]; total_rows?: number };
      setHistory(result.rows ?? []); setTotal(Number(result.total_rows ?? 0));
    }
    setLoading(false);
  }, [page, search]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  return <main className="auth-page"><div className="auth-panel" style={{ maxWidth: 760 }}>
    <div className="eyebrow">TABLELY CUSTOMER</div><h1>Order history</h1><p>Search your past orders and open the current menu to repeat an order.</p>
    <div className="button-row" style={{ marginTop: 18 }}><Link href="/customer/orders" className="button button-light">Ongoing orders</Link><Link href="/customer/account" className="button button-light">Account</Link></div>
    <form className="history-search" onSubmit={event => { event.preventDefault(); setLoading(true); setPage(0); setSearch(query.trim()); }}><Search size={16}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Restaurant, branch or order number"/><button className="button button-light compact">Search</button></form>
    {error ? <div className="notice notice-error">{error}</div> : null}
    {history.length ? history.map(row => <section className="customer-checkout-card" key={row.order_id}><div className="ops-order-meta"><span><HistoryIcon size={15}/> #{row.order_number} · {row.restaurant_name}</span><strong>₹{Number(row.total).toLocaleString('en-IN')}</strong></div><p className="muted-small">{row.branch_name} · {new Date(row.created_at).toLocaleDateString('en-IN')} · {row.order_status} · Payment {row.payment_status} · {row.item_count} item{row.item_count === 1 ? '' : 's'}</p><div className="button-row"><Link href={`/customer/history/${row.order_id}`} className="button button-light compact">Details / reorder</Link><Link href={`/customer/history/${row.order_id}/receipt`} className="button button-light compact">Receipt</Link></div></section>) : !loading ? <section className="customer-empty-card"><p>{search ? 'No orders match your search.' : 'No authenticated orders yet.'}</p><Link href="/" className="button button-primary">Browse restaurants</Link></section> : <p className="muted-small">Loading order history…</p>}
    <div className="button-row history-pagination"><span>{total} orders · page {Math.min(page + 1, Math.max(1, Math.ceil(total / PAGE_SIZE)))} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</span><button className="button button-light compact" disabled={page === 0 || loading} onClick={() => { setLoading(true); setPage(value => Math.max(0, value - 1)); }}>Previous</button><button className="button button-light compact" disabled={(page + 1) * PAGE_SIZE >= total || loading} onClick={() => { setLoading(true); setPage(value => value + 1); }}>Next</button></div>
  </div></main>;
}
