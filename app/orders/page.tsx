'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, Clock3, RefreshCw, X, Banknote, ChevronDown, ChevronUp, RotateCcw, MessageCircle, MapPin, Bike, ShoppingBag, Check } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { removeById, uniqueById, upsertById } from '@/lib/live-ops';
import { toLiveStatus, type LiveStatus } from '@/lib/realtime';
import { OrderCancellationRequests } from '@/components/OrderCancellationRequests';
import { ORDER_STATES, type OrderState, type Priority, formatElapsed } from '@/lib/restaurant-ops';
import { SessionManagementPanel } from '@/components/orders/SessionManagementPanel';
import { getLocalDateInputValue, getOrderDateBounds, type OrderDatePreset, type OrderDateRange } from '@/lib/order-date-range';

interface OrderRow {
  id: string;
  order_number: number | null;
  table_id: string | null;
  table_session_id: string | null;
  branch_id: string;
  status: OrderState;
  fulfillment_type?: 'DINE_IN' | 'PICKUP' | 'DELIVERY';
  payment_status: string;
  payment_method: string | null;
  total: number;
  created_at: string;
  updated_at: string;
  customer_note: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  cancellation_reason: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  payment_started_at: string | null;
  payment_expires_at: string | null;
  priority: Priority;
}

interface ItemRow {
  id: string;
  order_id: string;
  item_name_snapshot: string;
  unit_price: number;
  quantity: number;
  selected_addons: Array<{ name: string; price?: number }> | null;
  selected_options: Array<{ type: string; name: string; price_delta?: number }> | null;
  special_instructions: string | null;
  preparation_status: string | null;
  station_id: string | null;
  priority: Priority;
}

interface Station {
  id: string;
  name: string;
  is_active: boolean;
}

interface CustomerChatConversation {
  id: string;
  table_id: string;
  table_session_id: string | null;
  table_number: number | null;
  unread_customer_count: number;
  last_message_at: string;
}

interface FulfillmentDetail {
  id: string;
  order_id: string;
  branch_id: string;
  fulfillment_type: 'PICKUP' | 'DELIVERY';
  pickup_code: string | null;
  pickup_verified_at: string | null;
  pickup_window_start: string | null;
  pickup_window_end: string | null;
  delivery_address_line1: string | null;
  delivery_address_line2: string | null;
  delivery_landmark: string | null;
  delivery_city: string | null;
  delivery_pin_code: string | null;
  delivery_status: string | null;
  assigned_staff_id: string | null;
}

const rejectReasons = [
  ['ITEM_UNAVAILABLE', 'Item unavailable'],
  ['KITCHEN_TOO_BUSY', 'Kitchen too busy'],
  ['RESTAURANT_CLOSING', 'Restaurant closing'],
  ['OUT_OF_STOCK', 'Out of stock'],
  ['CUSTOMER_REQUESTED', 'Customer requested'],
  ['RESTAURANT_CANNOT_FULFILL', 'Cannot fulfill'],
  ['OTHER', 'Other'],
] as const;

const statuses: Array<[OrderState | 'ALL', string]> = [
  ['ALL', 'All'],
  ...ORDER_STATES.map((s): [OrderState, string] => [s, s.replaceAll('_', ' ')]),
];

function humanPayment(method: string | null, status: string) {
  if (status === 'FAILED') return 'Payment failed';
  if (method === 'PAY_AT_COUNTER') return status === 'PAID' ? 'Paid at counter' : 'Awaiting counter payment';
  if (method?.startsWith('PAY_NOW:')) return status === 'PAID' ? 'Paid online' : 'Online payment';
  return method ?? '—';
}

function optionLines(item: ItemRow) {
  const out: string[] = [];
  for (const x of item.selected_options ?? []) {
    out.push(x.type === 'VARIANT' ? `Size: ${x.name}` : `${x.name}${Number(x.price_delta) > 0 ? ` +₹${x.price_delta}` : ''}`);
  }
  for (const x of item.selected_addons ?? []) {
    out.push(`${x.name}${Number(x.price) > 0 ? ` +₹${x.price}` : ''}`);
  }
  return out;
}

export default function OrdersPage() {
  const supabase = getSupabaseBrowserClient();
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [tables, setTables] = useState<Record<string, number>>({});
  const [items, setItems] = useState<Record<string, ItemRow[]>>({});
  const [stations, setStations] = useState<Station[]>([]);
  const [fulfillmentMap, setFulfillmentMap] = useState<Record<string, FulfillmentDetail>>({});
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null);
  const [canManageSessions, setCanManageSessions] = useState(false);
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);
  const [chatConversations, setChatConversations] = useState<CustomerChatConversation[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | OrderState>('ALL');
  const [fulfillmentFilter, setFulfillmentFilter] = useState<'ALL' | 'DINE_IN' | 'PICKUP' | 'DELIVERY'>('ALL');
  const [datePreset, setDatePreset] = useState<OrderDatePreset|'custom'>('today');
  const [customFrom, setCustomFrom] = useState(getLocalDateInputValue);
  const [customTo, setCustomTo] = useState(getLocalDateInputValue);
  const [appliedDateLabel, setAppliedDateLabel] = useState('Today');
  const orderDateFilterRef = useRef<OrderDateRange>({ preset: 'today' });
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const liveRef = useRef<LiveStatus>('connecting');
  const seq = useRef(0);

  const [rejectTarget, setRejectTarget] = useState<OrderRow | null>(null);
  const [rejectCode, setRejectCode] = useState('ITEM_UNAVAILABLE');
  const [rejectNote, setRejectNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [settleOrder, setSettleOrder] = useState<OrderRow | null>(null);
  const [counterPaymentOrder, setCounterPaymentOrder] = useState<OrderRow | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [reopenTarget, setReopenTarget] = useState<OrderRow | null>(null);
  const [reopenReason, setReopenReason] = useState('Customer requested an operational correction.');

  const [verifyTarget, setVerifyTarget] = useState<OrderRow | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyOverride, setVerifyOverride] = useState(false);
  const [verifyOverrideReason, setVerifyOverrideReason] = useState('Customer ID / Phone verified');
  const [verifyError, setVerifyError] = useState<string | null>(null);

  async function loadCustomerChats(branchId: string) {
    try {
      const response = await fetch(`/api/customer-messages?branchId=${encodeURIComponent(branchId)}`, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Customer chat status could not be loaded.');
      setChatConversations((result.conversations ?? []) as CustomerChatConversation[]);
      setChatError(null);
    } catch (e: unknown) {
      setChatError(e instanceof Error ? e.message : 'Customer chat status could not be loaded.');
    }
  }

  async function load(silent = false) {
    const n = ++seq.current;
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    if (!silent) setRefreshing(true);
    try {
      const c = await getCurrentRestaurantContext(supabase);
      if (!c.data) throw c.error ?? new Error('Workspace not found.');
      const b = c.data.branch.id;
      setActiveBranchId(b);
      setCanManageSessions(c.data.staff.role === 'OWNER' || c.data.staff.role === 'MANAGER');
      void loadCustomerChats(b);

      const bounds = getOrderDateBounds(orderDateFilterRef.current);
      if (!bounds) throw new Error('Choose a valid order date range.');
      const orderRows: OrderRow[] = [];
      let orderOffset = 0;
      let hasMoreOrders = true;
      while (hasMoreOrders) {
        const { data, error: orderError } = await supabase
          .from('orders')
          .select('id,order_number,table_id,table_session_id,branch_id,status,payment_status,payment_method,total,created_at,updated_at,customer_note,customer_name,customer_phone,cancellation_reason,cancelled_by,cancelled_at,payment_started_at,payment_expires_at,priority,fulfillment_type')
          .eq('branch_id', b)
          .gte('created_at',bounds.from).lt('created_at',bounds.toExclusive)
          .order('created_at', { ascending: false })
          .range(orderOffset,orderOffset+199);
        if (orderError) throw orderError;
        const page = data ?? [];
        orderRows.push(...(page as OrderRow[]));
        hasMoreOrders = page.length === 200;
        orderOffset += page.length;
      }

      const [{ data: t, error: te }, { data: st, error: se }] = await Promise.all([
        supabase.from('tables').select('id,table_number').eq('branch_id', b),
        supabase.from('kitchen_stations').select('id,name,is_active').eq('branch_id', b).order('sort_order'),
      ]);
      if (te) throw te;
      if (se) throw se;

      const ids = orderRows.map((x) => x.id);
      const grouped: Record<string, ItemRow[]> = {};
      const fMap: Record<string, FulfillmentDetail> = {};

      for (let start = 0; start < ids.length; start += 200) {
        const batch = ids.slice(start, start + 200);
        let itemOffset = 0;
        let hasMoreItems = true;
        while (hasMoreItems) {
          const { data: it, error: ie } = await supabase
            .from('order_items')
            .select('id,order_id,item_name_snapshot,unit_price,quantity,selected_addons,selected_options,special_instructions,preparation_status,station_id,priority')
            .in('order_id', batch)
            .range(itemOffset,itemOffset+199);
          if (ie) throw ie;
          const itemPage = it ?? [];
          for (const row of uniqueById(itemPage.map((x) => ({ ...x, unit_price: Number(x.unit_price) })) as ItemRow[])) {
            (grouped[row.order_id] ??= []).push(row);
          }
          hasMoreItems = itemPage.length === 200;
          itemOffset += itemPage.length;
        }

        const { data: fdData } = await supabase
          .from('order_fulfillment_details')
          .select('*')
          .in('order_id', batch);
        if (fdData) {
          for (const item of fdData) {
            fMap[item.order_id] = item as FulfillmentDetail;
          }
        }
      }

      if (n !== seq.current) return;
      setRows(orderRows.map((x) => ({ ...x, total: Number(x.total), priority: (x.priority ?? 'NORMAL') as Priority })));
      setItems(grouped);
      setFulfillmentMap(fMap);
      setTables(Object.fromEntries((t ?? []).map((x) => [x.id, x.table_number])));
      setStations((st ?? []) as Station[]);
      setError(null);
      setLoading(false);
    } catch (e: unknown) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : 'Could not load orders.');
        setLoading(false);
      }
    } finally {
      if (n === seq.current) setRefreshing(false);
    }
  }

  function chooseDatePreset(value: OrderDatePreset | 'custom') {
    setDatePreset(value);
    if (value === 'custom') return;
    orderDateFilterRef.current = { preset: value };
    setAppliedDateLabel(value === 'today' ? 'Today' : value === '7days' ? 'Last 7 days' : 'Last 30 days');
    void load();
  }

  function applyCustomDateRange() {
    const range: OrderDateRange = { preset: 'custom', from: customFrom, to: customTo };
    if (!getOrderDateBounds(range)) return;
    orderDateFilterRef.current = range;
    setAppliedDateLabel(`${customFrom} – ${customTo}`);
    void load();
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const onChatUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ conversations?: CustomerChatConversation[] }>).detail;
      if (detail?.conversations) setChatConversations(detail.conversations);
    };
    window.addEventListener('tablely-customer-chat-inbox-changed', onChatUpdate);
    return () => window.removeEventListener('tablely-customer-chat-inbox-changed', onChatUpdate);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let ch: ReturnType<typeof supabase.channel> | null = null;
    let active = true;
    const timer = window.setInterval(() => {
      if (liveRef.current !== 'live') void load(true);
    }, 20000);

    (async () => {
      const c = await getCurrentRestaurantContext(supabase);
      if (!c.data || !active) return;
      const b = c.data.branch.id;
      ch = supabase
        .channel(`tablely:orders-v2:${b}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'orders', filter: `branch_id=eq.${b}` },
          (p) => {
            const o = { ...(p.new as OrderRow), total: Number((p.new as OrderRow)?.total) };
            if (p.eventType === 'DELETE') setRows((cur) => removeById(cur, (p.old as OrderRow).id));
            else setRows((cur) => upsertById(cur, { ...o, priority: (o.priority ?? 'NORMAL') as Priority }));
            void load(true);
          }
        )
        .on('postgres_changes', { event: '*', schema: 'public', table: 'table_sessions', filter: `branch_id=eq.${b}` }, () => void load(true))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_fulfillment_details', filter: `branch_id=eq.${b}` }, () => void load(true))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, (p) => {
          const row = p.new as ItemRow;
          if (p.eventType === 'DELETE') {
            setItems((cur) => {
              const next = { ...cur, [String((p.old as ItemRow).order_id)]: (cur[String((p.old as ItemRow).order_id)] ?? []).filter((i) => i.id !== (p.old as ItemRow).id) };
              return next;
            });
          } else if (row?.order_id) {
            setItems((cur) => ({ ...cur, [row.order_id]: upsertById(cur[row.order_id] ?? [], { ...row, unit_price: Number(row.unit_price), priority: (row.priority ?? 'NORMAL') as Priority }) }));
          }
        })
        .subscribe((status) => {
          const s = toLiveStatus(status);
          liveRef.current = s;
          setLiveStatus(s);
          if (s === 'live') void load(true);
        });
    })();
    return () => {
      active = false;
      window.clearInterval(timer);
      if (ch) void supabase.removeChannel(ch);
    };
  }, []);

  async function advance(o: OrderRow) {
    if (!supabase) return;
    const next: Record<string, OrderState> = { NEW: 'ACCEPTED', ACCEPTED: 'PREPARING', PREPARING: 'READY', READY: 'SERVED', SERVED: 'COMPLETED' };
    const target = next[o.status];
    if (!target) return;
    if (target === 'COMPLETED' && o.payment_status !== 'PAID') {
      setSettleOrder(o);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error: e } = await supabase.rpc('transition_order_status', { p_order_id: o.id, p_new_status: target });
      if (e) throw e;
      void load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not update order.');
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyPickup() {
    if (!supabase || !verifyTarget || busy) return;
    setBusy(true);
    setVerifyError(null);
    try {
      const { error: e } = await supabase.rpc('fulfillment_confirm_pickup', {
        p_order_id: verifyTarget.id,
        p_pickup_code: verifyOverride ? null : verifyCode.trim(),
        p_manager_override: verifyOverride,
      });
      if (e) throw e;
      setVerifyTarget(null);
      setVerifyCode('');
      setVerifyOverride(false);
      void load(true);
    } catch (e: unknown) {
      setVerifyError(e instanceof Error ? e.message : 'Could not verify pickup.');
    } finally {
      setBusy(false);
    }
  }

  async function settle(method: 'CASH' | 'UPI') {
    if (!supabase || !settleOrder) return;
    setBusy(true);
    setError(null);
    try {
      const { error: paymentError } = await supabase.rpc('settle_counter_payment', { p_order_id: settleOrder.id, p_method: method });
      if (paymentError) throw paymentError;
      const { error: completionError } = await supabase.rpc('transition_order_status', { p_order_id: settleOrder.id, p_new_status: 'COMPLETED' });
      if (completionError) throw completionError;
      setSettleOrder(null);
      void load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not settle and complete order.');
    } finally {
      setBusy(false);
    }
  }

  async function decideCounterPayment(received: boolean, method?: 'CASH' | 'UPI', target = counterPaymentOrder) {
    if (!supabase || !target) return;
    setBusy(true);
    try {
      const { error: e } = await supabase.rpc('decide_counter_payment', { p_order_id: target.id, p_received: received, p_method: method ?? null });
      if (e) throw e;
      setCounterPaymentOrder(null);
      void load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not update counter payment.');
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!supabase || !rejectTarget || busy) return;
    setBusy(true);
    try {
      const { error: e } = await supabase.rpc('reject_order', { p_order_id: rejectTarget.id, p_reason_code: rejectCode, p_reason_note: rejectNote || null });
      if (e) throw e;
      setRejectTarget(null);
      setRejectNote('');
      void load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not reject order.');
    } finally {
      setBusy(false);
    }
  }

  async function setPriority(o: OrderRow, p: Priority) {
    if (!supabase || busy) return;
    setBusy(true);
    try {
      const { error: e } = await supabase.rpc('set_order_priority', { p_order_id: o.id, p_priority: p });
      if (e) throw e;
      void load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not change priority.');
    } finally {
      setBusy(false);
    }
  }

  async function setStation(item: ItemRow, stationId: string) {
    if (!supabase) return;
    try {
      const { error: e } = await supabase.rpc('set_order_item_station', { p_order_item_id: item.id, p_station_id: stationId || null });
      if (e) throw e;
      void load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not assign station.');
    }
  }

  async function reopen() {
    if (!supabase || !reopenTarget) return;
    setBusy(true);
    try {
      const { error: e } = await supabase.rpc('reopen_order', { p_order_id: reopenTarget.id, p_reason: reopenReason });
      if (e) throw e;
      setReopenTarget(null);
      void load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not reopen order.');
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(
    () =>
      rows
        .filter((o) => filter === 'ALL' || o.status === filter)
        .filter((o) => fulfillmentFilter === 'ALL' || (o.fulfillment_type ?? 'DINE_IN') === fulfillmentFilter),
    [rows, filter, fulfillmentFilter]
  );

  const customDateRangeValid = Boolean(getOrderDateBounds({ preset: 'custom', from: customFrom, to: customTo }));
  const liveLabel = liveStatus === 'live' ? 'Live' : liveStatus === 'offline' ? 'Offline' : 'Reconnecting';

  if (loading) {
    return (
      <StudioShell>
        <div className="setup-loading">Loading restaurant orders…</div>
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="ORDERS / OPERATIONS 2.0"
        title="Orders"
        description="Full lifecycle, per-item preparation, rejection, priority, payment state, and table-session context."
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Link href="/pickup" className="button button-light">
              <ShoppingBag size={15} /> Pickup Manager
            </Link>
            <Link href="/delivery" className="button button-light">
              <Bike size={15} /> Delivery Board
            </Link>
            <button className="button button-light" onClick={() => void load()} disabled={refreshing}>
              <RefreshCw size={15} className={refreshing ? 'spin' : ''} /> Refresh
            </button>
          </div>
        }
      />
      <div className="live-status">
        <span className={`status-dot ${liveStatus === 'live' ? 'online' : 'offline'}`} />
        {liveLabel}
        <span className="muted-small">· realtime order and item updates</span>
      </div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {chatError ? <div className="notice notice-error" role="alert">{chatError}</div> : null}
      {activeBranchId && canManageSessions ? (
        <SessionManagementPanel
          branchId={activeBranchId}
          requestedSessionId={requestedSessionId}
          onSessionHandled={() => setRequestedSessionId(null)}
        />
      ) : null}

      <div className="orders-date-controls" aria-label="Order date filters">
        <label className="orders-date-preset">
          <CalendarDays size={16} />
          <span>Date range</span>
          <select aria-label="Filter orders by date" value={datePreset} onChange={(e) => chooseDatePreset(e.target.value as OrderDatePreset | 'custom')}>
            <option value="today">Today</option>
            <option value="7days">Last 7 days</option>
            <option value="30days">Last 30 days</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {datePreset === 'custom' ? (
          <div className="orders-custom-range">
            <label>
              From
              <input aria-label="Order start date" type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label>
              To
              <input aria-label="Order end date" type="date" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
            <button type="button" className="button button-primary compact" onClick={applyCustomDateRange} disabled={!customDateRangeValid || refreshing}>
              Apply
            </button>
            {!customDateRangeValid ? <span className="orders-date-error" role="alert">Choose a valid date range.</span> : null}
          </div>
        ) : null}
        <span className="orders-range-caption">
          Showing orders: <strong>{appliedDateLabel}</strong>
        </span>
      </div>

      <div className="status-tabs" style={{ marginBottom: 8 }}>
        {(['ALL', 'DINE_IN', 'PICKUP', 'DELIVERY'] as const).map((mode) => (
          <button
            key={mode}
            className={fulfillmentFilter === mode ? 'active' : ''}
            onClick={() => setFulfillmentFilter(mode)}
          >
            {mode === 'ALL' ? 'All Channels' : mode.replaceAll('_', ' ')} ·{' '}
            {mode === 'ALL'
              ? rows.length
              : rows.filter((o) => (o.fulfillment_type ?? 'DINE_IN') === mode).length}
          </button>
        ))}
      </div>

      <div className="status-tabs">
        {statuses.map(([value, label]) => (
          <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value as typeof filter)}>
            {label} · {value === 'ALL' ? rows.length : rows.filter((o) => o.status === value).length}
          </button>
        ))}
      </div>

      <OrderCancellationRequests />

      <section className="order-card-grid">
        {visible.map((o) => {
          const open = expanded[o.id] === true;
          const its = items[o.id] ?? [];
          const matchingChats = chatConversations.filter(
            (chat) => o.table_session_id !== null && chat.unread_customer_count > 0 && chat.table_session_id === o.table_session_id
          );
          const unreadMessages = matchingChats.reduce((count, chat) => count + chat.unread_customer_count, 0);
          const latestChat = matchingChats[0];
          const fDetail = fulfillmentMap[o.id];

          return (
            <article className="surface-card live-order-card ops-order-card" key={o.id}>
              <div className="live-order-head">
                <div>
                  <strong>
                    #{o.order_number ?? o.id.slice(0, 6)} ·{' '}
                    {o.fulfillment_type==='PICKUP'?'Pickup':o.fulfillment_type==='DELIVERY'?'Delivery':`Table ${tables[o.table_id ?? ''] ?? '—'}`}
                  </strong>
                  <span>
                    <Clock3 size={12} />{' '}
                    <time dateTime={o.created_at} title={new Date(o.created_at).toLocaleString()}>
                      {new Date(o.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
                    </time>{' '}
                    · {formatElapsed(o.created_at)} ago ·{' '}
                    {o.table_session_id ? (
                      <button type="button" className="ops-session-link" onClick={() => setRequestedSessionId(o.table_session_id)}>
                        Session {o.table_session_id.slice(0, 8).toUpperCase()}
                      </button>
                    ) : o.fulfillment_type === 'PICKUP' ? (
                      'Pickup Order'
                    ) : o.fulfillment_type === 'DELIVERY' ? (
                      'Delivery Order'
                    ) : (
                      'No linked session'
                    )}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {o.fulfillment_type && o.fulfillment_type !== 'DINE_IN' ? (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '0.04em',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: o.fulfillment_type === 'DELIVERY' ? 'rgba(59,130,246,0.12)' : 'rgba(16,185,129,0.12)',
                        color: o.fulfillment_type === 'DELIVERY' ? '#2563eb' : '#059669',
                        border: o.fulfillment_type === 'DELIVERY' ? '1px solid rgba(59,130,246,0.3)' : '1px solid rgba(16,185,129,0.3)',
                      }}
                    >
                      {o.fulfillment_type}
                    </span>
                  ) : null}
                  <StatusBadge status={o.status} />
                </div>
              </div>

              {o.fulfillment_type === 'PICKUP' ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: 4,
                    padding: '6px 10px',
                    background: '#f0fdf4',
                    borderRadius: 6,
                    border: '1px solid #bbf7d0',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ShoppingBag size={14} color="#059669" />
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#166534' }}>
                      Pickup Code:{' '}
                      <span style={{ fontFamily: 'monospace', letterSpacing: '0.08em', background: '#dcfce7', padding: '2px 6px', borderRadius: 4 }}>
                        {fDetail?.pickup_code ? `#${fDetail.pickup_code}` : 'PENDING'}
                      </span>
                    </span>
                  </div>
                  {fDetail?.pickup_verified_at ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#059669', display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Check size={13} /> Handed Over
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: '#15803d' }}>Awaiting pickup</span>
                  )}
                </div>
              ) : o.fulfillment_type === 'DELIVERY' ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    marginTop: 4,
                    padding: '6px 10px',
                    background: '#eff6ff',
                    borderRadius: 6,
                    border: '1px solid #bfdbfe',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Bike size={14} color="#2563eb" />
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#1e40af' }}>
                        Delivery · {fDetail?.delivery_status ? fDetail.delivery_status.replaceAll('_', ' ') : 'AWAITING DISPATCH'}
                      </span>
                    </div>
                    <Link
                      href="/delivery"
                      style={{ fontSize: 11, fontWeight: 600, color: '#2563eb', textDecoration: 'underline' }}
                    >
                      Dispatch Board →
                    </Link>
                  </div>
                  {fDetail?.delivery_address_line1 ? (
                    <span style={{ fontSize: 11, color: '#1e3a8a', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <MapPin size={11} /> {fDetail.delivery_address_line1}
                      {fDetail.delivery_pin_code ? ` (PIN ${fDetail.delivery_pin_code})` : ''}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {unreadMessages > 0 && latestChat ? (
                <button
                  type="button"
                  className="ops-chat-alert"
                  aria-label={`${unreadMessages} new customer message${unreadMessages === 1 ? '' : 's'} for ${
                    o.fulfillment_type === 'PICKUP' ? 'Pickup' : o.fulfillment_type === 'DELIVERY' ? 'Delivery' : `Table ${tables[o.table_id ?? ''] ?? '—'}`
                  }`}
                  onClick={() => window.dispatchEvent(new CustomEvent('tablely-open-customer-chat', { detail: { conversationId: latestChat.id } }))}
                >
                  <MessageCircle size={14} />
                  <strong>
                    {unreadMessages} new message{unreadMessages === 1 ? '' : 's'}
                  </strong>
                  <span>Open live chat</span>
                </button>
              ) : null}

              <div className="ops-order-meta">
                <span>
                  Payment: <b>{humanPayment(o.payment_method, o.payment_status)}</b>
                </span>
                <span className={`ops-priority ops-priority-${o.priority.toLowerCase()}`}>{o.priority}</span>
                <span>
                  {its.length} item{its.length === 1 ? '' : 's'}
                </span>
                <strong>₹{Number(o.total).toLocaleString('en-IN')}</strong>
              </div>

              {o.customer_name ? (
                <div className="muted-small">
                  Customer: {o.customer_name}
                  {o.customer_phone ? ` · ${o.customer_phone}` : ''}
                </div>
              ) : null}
              {o.customer_note ? <div className="order-note">{o.customer_note}</div> : null}

              <button className="ops-expand" onClick={() => setExpanded((cur) => ({ ...cur, [o.id]: !open }))}>
                {open ? (
                  <>
                    <ChevronUp size={14} /> Hide items
                  </>
                ) : (
                  <>
                    <ChevronDown size={14} /> View item operations
                  </>
                )}
              </button>

              {open ? (
                <div className="ops-order-items">
                  {its.length ? (
                    its.map((item) => (
                      <div className="ops-item-row" key={item.id}>
                        <div>
                          <strong>
                            {item.quantity} × {item.item_name_snapshot}
                          </strong>
                          <small>{optionLines(item).join(' · ') || 'Base configuration'}</small>
                          {item.special_instructions ? <small>Note: {item.special_instructions}</small> : null}
                        </div>
                        <div className="ops-item-controls">
                          <span className={`item-state item-state-${(item.preparation_status ?? 'PENDING').toLowerCase()}`}>
                            {item.preparation_status ?? 'PENDING'}
                          </span>
                          <select value={item.station_id ?? ''} onChange={(e) => void setStation(item, e.target.value)}>
                            <option value="">No station</option>
                            {stations
                              .filter((s) => s.is_active)
                              .map((s) => (
                                <option value={s.id} key={s.id}>
                                  {s.name}
                                </option>
                              ))}
                          </select>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="empty-wide">No order items found.</div>
                  )}
                </div>
              ) : null}

              <div className="live-order-footer">
                <select className="field-select compact-select" value={o.priority} onChange={(e) => void setPriority(o, e.target.value as Priority)} disabled={busy}>
                  <option value="NORMAL">Normal</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </select>
                <span>{humanPayment(o.payment_method, o.payment_status)}</span>

                {o.status === 'NEW' && o.payment_method === 'PAY_AT_COUNTER' && o.payment_status === 'PENDING' ? (
                  <div className="button-row">
                    <button className="button button-primary compact" onClick={() => setCounterPaymentOrder(o)} disabled={busy}>
                      Received
                    </button>
                    <button className="button button-light compact danger-button" onClick={() => void decideCounterPayment(false, undefined, o)} disabled={busy}>
                      Not received
                    </button>
                  </div>
                ) : o.status === 'NEW' && !((o.payment_method === 'PAY_AT_COUNTER' || o.payment_method?.startsWith('PAY_NOW')) && o.payment_status === 'PENDING') ? (
                  <button className="button button-primary compact" onClick={() => void advance(o)} disabled={busy}>
                    Accept
                  </button>
                ) : o.fulfillment_type === 'PICKUP' && o.status === 'READY' && !fDetail?.pickup_verified_at ? (
                  <button
                    className="button button-primary compact"
                    style={{ background: '#059669', borderColor: '#059669' }}
                    onClick={() => {
                      setVerifyTarget(o);
                      setVerifyCode('');
                      setVerifyOverride(false);
                      setVerifyError(null);
                    }}
                    disabled={busy}
                  >
                    Verify Pickup
                  </button>
                ) : o.fulfillment_type === 'DELIVERY' && (o.status === 'READY' || o.status === 'SERVED') ? (
                  <Link href="/delivery" className="button button-light compact" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Bike size={13} /> Delivery Board
                  </Link>
                ) : o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && o.status !== 'REJECTED' && !(o.payment_method === 'PAY_AT_COUNTER' && o.payment_status === 'PENDING') ? (
                  <button className="button button-light compact" onClick={() => void advance(o)} disabled={busy}>
                    {o.status === 'SERVED' ? 'Complete' : o.status === 'READY' ? 'Mark served' : o.status === 'PREPARING' ? 'Mark ready' : 'Start preparing'}
                  </button>
                ) : null}

                {o.status === 'NEW' && !(o.payment_method === 'PAY_AT_COUNTER' && o.payment_status === 'PENDING') ? (
                  <button
                    className="button button-light compact danger-button"
                    onClick={() => {
                      setRejectTarget(o);
                      setRejectCode('ITEM_UNAVAILABLE');
                    }}
                    disabled={busy}
                  >
                    Reject
                  </button>
                ) : null}

                {o.status === 'COMPLETED' ? (
                  <button className="button button-danger compact" onClick={() => setReopenTarget(o)} disabled={busy}>
                    <RotateCcw size={13} /> Reopen
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {visible.length === 0 ? (
          <div className="empty-wide">
            <h2>No orders in this view</h2>
            <p>New orders and operational updates appear here automatically.</p>
          </div>
        ) : null}
      </section>

      {verifyTarget ? (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setVerifyTarget(null);
          }}
        >
          <div className="modal-card compact-modal">
            <div className="modal-head">
              <div>
                <span className="eyebrow">ORDER #{verifyTarget.order_number ?? verifyTarget.id.slice(0, 6)} · SELF PICKUP</span>
                <h2>Verify Pickup Handover</h2>
              </div>
              <button className="icon-button" onClick={() => setVerifyTarget(null)}>
                <X size={17} />
              </button>
            </div>
            <div className="modal-form">
              <p>Ask customer for their 4-digit pickup code, or check Manager Override if verified via phone/receipt.</p>
              {verifyError ? <div className="notice notice-error" role="alert">{verifyError}</div> : null}
              {!verifyOverride ? (
                <label>
                  4-Digit Pickup Code
                  <input
                    type="text"
                    maxLength={4}
                    autoFocus
                    placeholder="e.g. 4829"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                    style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.25em', textAlign: 'center' }}
                  />
                </label>
              ) : (
                <label>
                  Manager Override Reason
                  <input
                    type="text"
                    value={verifyOverrideReason}
                    onChange={(e) => setVerifyOverrideReason(e.target.value)}
                    placeholder="e.g. Customer showed SMS / receipt / ID"
                  />
                </label>
              )}
              <div style={{ margin: '8px 0', fontSize: 13 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={verifyOverride}
                    onChange={(e) => setVerifyOverride(e.target.checked)}
                  />
                  <span>Manager override (handover without 4-digit code)</span>
                </label>
              </div>
              <div className="modal-actions">
                <button className="button button-light" onClick={() => setVerifyTarget(null)}>
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  onClick={() => void handleVerifyPickup()}
                  disabled={busy || (!verifyOverride && verifyCode.trim().length < 4)}
                >
                  {busy ? 'Verifying…' : 'Confirm Handover & Complete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {rejectTarget ? (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setRejectTarget(null);
          }}
        >
          <div className="modal-card compact-modal">
            <div className="modal-head">
              <div>
                <span className="eyebrow">ORDER #{rejectTarget.order_number}</span>
                <h2>Reject order</h2>
              </div>
              <button className="icon-button" onClick={() => setRejectTarget(null)}>
                <X size={17} />
              </button>
            </div>
            <div className="modal-form">
              <p>
                Rejecting the order records a distinct <strong>REJECTED</strong> outcome and customer-safe reason.
              </p>
              <label>
                Reason
                <select value={rejectCode} onChange={(e) => setRejectCode(e.target.value)}>
                  {rejectReasons.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Optional note
                <textarea
                  value={rejectNote}
                  onChange={(e) => setRejectNote(e.target.value)}
                  maxLength={500}
                  rows={4}
                  placeholder="Operational context (not shown to the customer unless designed as public)."
                />
              </label>
              <div className="modal-actions">
                <button className="button button-light" onClick={() => setRejectTarget(null)}>
                  Cancel
                </button>
                <button className="button button-primary" onClick={() => void reject()} disabled={busy}>
                  {busy ? 'Rejecting…' : 'Confirm rejection'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {counterPaymentOrder ? (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCounterPaymentOrder(null);
          }}
        >
          <div className="modal-card compact-modal">
            <div className="modal-head">
              <div>
                <span className="eyebrow">ORDER #{counterPaymentOrder.order_number}</span>
                <h2>Confirm payment received</h2>
              </div>
              <button className="icon-button" onClick={() => setCounterPaymentOrder(null)}>
                <X size={17} />
              </button>
            </div>
            <div className="modal-form">
              <div className="static-code">
                <span>Total received</span>
                <strong>₹{Number(counterPaymentOrder.total).toLocaleString('en-IN')}</strong>
              </div>
              <p>Choose how the customer paid. The order will be accepted immediately after confirmation.</p>
              <div className="button-row">
                <button className="button button-primary" onClick={() => void decideCounterPayment(true, 'CASH')} disabled={busy}>
                  <Banknote size={14} /> Cash
                </button>
                <button className="button button-light" onClick={() => void decideCounterPayment(true, 'UPI')} disabled={busy}>
                  UPI
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {settleOrder ? (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettleOrder(null);
          }}
        >
          <div className="modal-card compact-modal">
            <div className="modal-head">
              <div>
                <span className="eyebrow">ORDER #{settleOrder.order_number}</span>
                <h2>Settle payment</h2>
              </div>
              <button className="icon-button" onClick={() => setSettleOrder(null)}>
                <X size={17} />
              </button>
            </div>
            <div className="modal-form">
              <div className="static-code">
                <span>Total due</span>
                <strong>₹{Number(settleOrder.total).toLocaleString('en-IN')}</strong>
              </div>
              <div className="button-row">
                <button className="button button-primary" onClick={() => void settle('CASH')} disabled={busy}>
                  <Banknote size={14} /> Cash
                </button>
                <button className="button button-light" onClick={() => void settle('UPI')} disabled={busy}>
                  UPI
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {reopenTarget ? (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setReopenTarget(null);
          }}
        >
          <div className="modal-card compact-modal">
            <div className="modal-head">
              <div>
                <span className="eyebrow">ORDER #{reopenTarget.order_number}</span>
                <h2>Reopen order</h2>
              </div>
              <button className="icon-button" onClick={() => setReopenTarget(null)}>
                <X size={17} />
              </button>
            </div>
            <div className="modal-form">
              <p>Reopening is a controlled operational correction and is audited.</p>
              <label>
                Reason
                <textarea value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} rows={4} maxLength={500} />
              </label>
              <div className="modal-actions">
                <button className="button button-light" onClick={() => setReopenTarget(null)}>
                  Cancel
                </button>
                <button className="button button-danger" onClick={() => void reopen()} disabled={busy}>
                  Reopen
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </StudioShell>
  );
}
