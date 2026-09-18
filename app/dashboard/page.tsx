'use client';

import Link from 'next/link';
import { ArrowRight, ClipboardList, Clock3, LayoutDashboard, Table2, UtensilsCrossed } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StudioShell } from '@/components/StudioShell';
import { StatusBadge } from '@/components/StatusBadge';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';
import { toLiveStatus, type LiveStatus } from '@/lib/realtime';

interface OrderRow { id: string; order_number: number | null; table_id: string; status: string; total: number; created_at: string; }
// operational_state is the server-derived table state (Build 17+): the same
// column the Tables page reads. A table is occupied whenever this is anything
// other than 'AVAILABLE' — driven by open table_sessions, not by re-scanning
// raw order rows here, so it never disagrees with /tables and never gets
// stuck "occupied" because of a terminal (e.g. REJECTED) order.
interface TableRow { id: string; table_number: number; active: boolean; operational_state: string; }

export default function DashboardPage() {
  const [context, setContext] = useState<CurrentRestaurantContext | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [menuCount, setMenuCount] = useState(0);
  const [availableCount, setAvailableCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const liveRef = useRef<LiveStatus>('connecting');
  const seq = useRef(0);
  const supabase = getSupabaseBrowserClient();

  async function load() {
    const n = ++seq.current;
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    const result = await getCurrentRestaurantContext(supabase);
    if (n !== seq.current) return;
    if (result.error || !result.data) { setError(result.error?.message ?? 'Workspace not found.'); setLoading(false); return; }
    setContext(result.data);
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const [{ data: orderRows, error: orderError }, { data: tableRows, error: tableError }, { data: menuRows, error: menuError }] = await Promise.all([
      supabase.from('orders').select('id, order_number, table_id, status, total, created_at').eq('branch_id', result.data.branch.id).gte('created_at', since.toISOString()).order('created_at', { ascending: false }).limit(50),
      supabase.from('tables').select('id, table_number, active, operational_state').eq('branch_id', result.data.branch.id).order('table_number', { ascending: true }),
      supabase.from('menu_items').select('id, is_available').eq('branch_id', result.data.branch.id),
    ]);
    if (n !== seq.current) return;
    if (orderError) setError(orderError.message); else setOrders((orderRows ?? []).map((row) => ({ ...row, total: Number(row.total) })) as OrderRow[]);
    if (tableError) setError(tableError.message); else setTables((tableRows ?? []) as TableRow[]);
    if (menuError) setError(menuError.message); else { const m = menuRows ?? []; setMenuCount(m.length); setAvailableCount(m.filter((x) => x.is_available).length); }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  // Realtime: table occupancy is session-derived, so it must update the
  // moment tables/table_sessions/orders change on this branch — the same
  // channel shape the Tables page already subscribes to — instead of only on
  // manual refresh.
  useEffect(() => {
    if (!supabase || !context?.branch.id) return;
    let active = true;
    const branch = context.branch.id;
    const channel = supabase.channel(`tablely:overview:${branch}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables', filter: `branch_id=eq.${branch}` }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'table_sessions', filter: `branch_id=eq.${branch}` }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `branch_id=eq.${branch}` }, () => void load())
      .subscribe(status => { if (!active) return; const live = toLiveStatus(status); liveRef.current = live; setLiveStatus(live); if (live === 'live') void load(); });
    const timer = window.setInterval(() => { if (liveRef.current !== 'live') void load(); }, 20000);
    return () => { active = false; window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [context?.branch.id]);

  const sales = useMemo(() => orders.filter((o) => o.status !== 'CANCELLED').reduce((sum, o) => sum + o.total, 0), [orders]);
  const pending = orders.filter((o) => ['NEW', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status)).length;
  const occupied = tables.filter((t) => t.active && t.operational_state !== 'AVAILABLE').length;
  const liveLabel = liveStatus === 'live' ? 'Live data' : liveStatus === 'offline' ? 'Offline' : 'Reconnecting…';

  if (loading) return <StudioShell><div className="setup-loading">Loading restaurant overview…</div></StudioShell>;

  return <StudioShell>
    <div className="section-header dashboard-header"><div><div className="eyebrow">OVERVIEW</div><h1>Good morning, {context?.organization.name}</h1><p>{context?.branch.name} · Today&apos;s operating picture</p></div><div className="dashboard-header-actions"><span className={`live-chip ${liveStatus === 'live' ? '' : 'offline'}`}><i />{liveLabel}</span><button className="button button-light" onClick={() => void load()}><Clock3 size={15} /> Refresh</button></div></div>
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <div className="metric-grid">
      <div className="metric-card"><div className="metric-head"><span>Today's sales</span><UtensilsCrossed size={16} /></div><strong>₹{sales.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong><small>{orders.length ? `${orders.length} orders today` : 'No orders yet'}</small></div>
      <div className="metric-card"><div className="metric-head"><span>Orders</span><ClipboardList size={16} /></div><strong>{orders.length}</strong><small>{pending} active now</small></div>
      <div className="metric-card"><div className="metric-head"><span>Menu</span><UtensilsCrossed size={16} /></div><strong>{availableCount}/{menuCount}</strong><small>{menuCount ? 'items available' : 'Add your first item'}</small></div>
      <div className="metric-card"><div className="metric-head"><span>Tables occupied</span><Table2 size={16} /></div><strong>{occupied} / {tables.length}</strong><small>{tables.length ? 'derived from live table state' : 'Create tables'}</small></div>
    </div>
    <div className="dashboard-grid">
      <section className="surface-card"><div className="card-heading"><div><h2>Table status</h2><p>Active tables with live occupancy derived from open sessions.</p></div><Link href="/tables" className="text-link">Manage tables <ArrowRight size={14} /></Link></div><div className="table-status-grid">{tables.slice(0, 16).map((table) => { const busy = table.operational_state !== 'AVAILABLE'; return <div className={`table-status ${busy ? 'busy' : ''} ${!table.active ? 'inactive' : ''}`} key={table.id}><strong>{String(table.table_number).padStart(2, '0')}</strong><span><i />{!table.active ? 'Inactive' : busy ? 'Occupied' : 'Available'}</span></div>; })}</div>{tables.length === 0 ? <div className="menu-empty">No tables yet. <Link href="/tables">Create tables</Link>.</div> : null}</section>
      <section className="surface-card"><div className="card-heading"><div><h2>Today's orders</h2><p>Latest orders from your branch.</p></div><Link href="/orders" className="text-link">All orders <ArrowRight size={14} /></Link></div><div className="order-list">{orders.slice(0, 6).map((order) => <div className="order-line" key={order.id}><div><strong>#{order.order_number ?? order.id.slice(0, 6)}</strong><span>{new Date(order.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div><strong>₹{order.total.toFixed(0)}</strong><StatusBadge status={order.status} /></div>)}{orders.length === 0 ? <div className="menu-empty">No orders today yet.</div> : null}</div></section>
    </div>
    <section className="surface-card dashboard-quick-actions"><div><LayoutDashboard size={18} /><div><strong>Finish your setup</strong><span>{menuCount === 0 ? 'Add menu items' : tables.length === 0 ? 'Add tables and print QR codes' : 'Your restaurant is ready to receive customer orders'}</span></div></div><div className="button-row"><Link href="/menu" className="button button-light">Menu</Link><Link href="/tables" className="button button-light">Tables</Link><Link href="/qr" className="button button-primary">QR Codes</Link></div></section>
  </StudioShell>;
}
