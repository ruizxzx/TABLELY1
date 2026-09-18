'use client';

import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { formatMoney } from '@/lib/customer';

type Detail = { customer_profile_id: string; name: string | null; email: string | null; phone: string | null; customer_since: string; total_orders: number; total_spend: number; last_order_at: string | null; active_pay_later: number };
type Order = { order_id: string; order_number: number; created_at: string; total: number; status: string; payment_status: string; payment_method: string | null };

export default function CustomerDetailPage({ params }: { params: Promise<{ customerId: string }> }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
      const { customerId } = await params;
      const context = await getCurrentRestaurantContext(supabase);
      if (!context.data) { setError(context.error?.message ?? 'Workspace not found.'); setLoading(false); return; }
      const [{ data: detailData, error: detailError }, { data: orderData, error: orderError }] = await Promise.all([
        supabase.rpc('get_branch_customer_detail', { p_branch_id: context.data.branch.id, p_customer_profile_id: customerId }),
        supabase.rpc('get_branch_customer_orders', { p_branch_id: context.data.branch.id, p_customer_profile_id: customerId }),
      ]);
      if (detailError || orderError) setError(detailError?.message ?? orderError?.message ?? 'Could not load customer.');
      else {
        const nextDetail = Array.isArray(detailData) ? detailData[0] as Detail : detailData as Detail;
        if (!nextDetail) setError('Customer not found for this branch.');
        else { setDetail(nextDetail); setOrders((orderData ?? []) as Order[]); }
      }
      setLoading(false);
    })();
  }, [params]);

  const activity = orders.flatMap(order => [
    { key: `${order.order_id}-created`, date: order.created_at, text: `Order #${order.order_number} placed`, detail: `${order.status} · ${formatMoney(Number(order.total))}` },
    { key: `${order.order_id}-payment`, date: order.created_at, text: `Payment ${order.payment_status.toLowerCase()}`, detail: order.payment_method || 'Payment method not recorded' },
  ]).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return <StudioShell><SectionHeader eyebrow="CUSTOMER DETAILS" title={detail?.name || 'Customer'} description={detail?.email || detail?.phone || 'Restaurant-scoped profile'} action={<Link className="button button-light" href="/customers"><ArrowLeft size={14}/> Customers</Link>} />
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    {loading ? <p className="muted-small">Loading customer…</p> : null}
    {detail ? <><section className="surface-card"><h2>Customer profile</h2><div className="data-table"><div className="data-row"><span>Name</span><strong>{detail.name || 'Not provided'}</strong></div><div className="data-row"><span>Phone</span><strong>{detail.phone || 'Not provided'}</strong></div><div className="data-row"><span>Email</span><strong>{detail.email || 'Not provided'}</strong></div><div className="data-row"><span>Customer since</span><strong>{detail.customer_since ? new Date(detail.customer_since).toLocaleDateString('en-IN') : '—'}</strong></div></div></section><div className="metric-grid"><div className="metric-card"><span>Orders</span><strong>{detail.total_orders}</strong></div><div className="metric-card"><span>Total spend</span><strong>{formatMoney(Number(detail.total_spend))}</strong></div><div className="metric-card"><span>Active Pay-Later</span><strong>{formatMoney(Number(detail.active_pay_later))}</strong></div></div><section className="surface-card"><h2>Order history</h2><div className="data-table"><div className="data-row data-head"><span>Order</span><span>Date</span><span>Total</span><span>Status</span><span>Payment</span></div>{orders.map(order => <div className="data-row" key={order.order_id}><strong>#{order.order_number}</strong><span>{new Date(order.created_at).toLocaleString('en-IN')}</span><strong>{formatMoney(Number(order.total))}</strong><span>{order.status}</span><span>{order.payment_status} · {order.payment_method || '—'}</span></div>)}</div></section><section className="surface-card"><h2>Activity</h2><div className="data-table">{activity.map(event => <div className="data-row" key={event.key}><div><strong>{event.text}</strong><span>{event.detail}</span></div><span>{new Date(event.date).toLocaleString('en-IN')}</span></div>)}</div></section></> : null}
  </StudioShell>;
}
