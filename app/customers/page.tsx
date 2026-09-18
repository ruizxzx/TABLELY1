'use client';

import Link from 'next/link';
import { Search, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { formatMoney } from '@/lib/customer';

type Customer = { customer_profile_id: string; name: string | null; email: string | null; phone: string | null; total_orders: number; total_spend: number; last_order_at: string | null };

export default function CustomersPage() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'repeat' | 'recent' | 'high-value'>('all');
  const [sort, setSort] = useState<'recent' | 'name' | 'orders' | 'spend'>('recent');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    void (async () => {
      const context = await getCurrentRestaurantContext(supabase);
      if (!context.data) { setError(context.error?.message ?? 'Workspace not found.'); setLoading(false); return; }
      const { data, error: rpcError } = await supabase.rpc('get_branch_customer_history', { p_branch_id: context.data.branch.id });
      if (rpcError) setError(rpcError.message);
      else setRows((data ?? []) as Customer[]);
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filteredRows = rows.filter(row => {
      const matchesSearch = !needle || [row.name, row.email, row.phone]
        .some(value => value?.toLowerCase().includes(needle));
      const lastOrder = row.last_order_at ? new Date(row.last_order_at).getTime() : 0;
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      return matchesSearch
        && (filter === 'all'
          || (filter === 'repeat' && row.total_orders > 1)
          || (filter === 'recent' && lastOrder >= thirtyDaysAgo)
          || (filter === 'high-value' && Number(row.total_spend) >= 1000));
    });
    return [...filteredRows].sort((a, b) => {
      if (sort === 'name') return (a.name ?? '').localeCompare(b.name ?? '');
      if (sort === 'orders') return b.total_orders - a.total_orders;
      if (sort === 'spend') return Number(b.total_spend) - Number(a.total_spend);
      return new Date(b.last_order_at ?? 0).getTime() - new Date(a.last_order_at ?? 0).getTime();
    });
  }, [filter, query, rows, sort]);

  return <StudioShell><SectionHeader eyebrow="RELATIONSHIPS" title="Customers" description="Restaurant-scoped customer history and Pay-Later relationships." />
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <section className="surface-card">
      <div className="customer-menu-toolbar">
        <div className="customer-search-wrap"><Search size={16}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, phone, or email" aria-label="Search customers"/></div>
        <label className="customer-language-picker">Filter
          <select value={filter} onChange={event => setFilter(event.target.value as typeof filter)} aria-label="Filter customers">
            <option value="all">All customers</option><option value="repeat">Repeat customers</option><option value="recent">Active in 30 days</option><option value="high-value">Spend over ₹1,000</option>
          </select>
        </label>
        <label className="customer-language-picker">Sort
          <select value={sort} onChange={event => setSort(event.target.value as typeof sort)} aria-label="Sort customers">
            <option value="recent">Most recent</option><option value="name">Name</option><option value="orders">Orders</option><option value="spend">Spend</option>
          </select>
        </label>
      </div>
      {loading ? <p className="muted-small">Loading customers…</p> : filtered.length ? <div className="data-table">
        <div className="data-row data-head"><span>Customer</span><span>Orders</span><span>Total spend</span><span>Last order</span><span/></div>
        {filtered.map(row => <div className="data-row" key={row.customer_profile_id}><div><strong>{row.name || 'Unnamed customer'}</strong><span>{row.phone || row.email || 'No contact details'}</span></div><span>{row.total_orders}</span><strong>{formatMoney(Number(row.total_spend))}</strong><span>{row.last_order_at ? new Date(row.last_order_at).toLocaleDateString('en-IN') : '—'}</span><Link className="button button-light compact" href={`/customers/${row.customer_profile_id}`}><Users size={13}/> View</Link></div>)}
      </div> : <p className="muted-small">No customers found for this branch.</p>}
    </section>
  </StudioShell>;
}
