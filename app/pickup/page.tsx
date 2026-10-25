'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import {
  ShoppingBag,
  Bike,
  Clock,
  Phone,
  User,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  X,
  Search,
  Filter,
  ArrowRight,
  ShieldCheck,
  Check,
  Package,
} from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { formatMoney } from '@/lib/customer';

type PickupOrder = {
  order_id: string;
  order_number: number;
  customer_name: string;
  customer_phone: string;
  fulfillment_type: string;
  fulfillment_status: string;
  order_status: string;
  payment_status: string;
  payment_method: string | null;
  total: number;
  pickup_code: string | null;
  promised_ready_at: string | null;
  created_at: string;
  items_count: number;
  items?: Array<{
    id: string;
    item_name_snapshot: string;
    quantity: number;
    unit_price: number;
  }>;
};

export default function PickupManagementPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [orders, setOrders] = useState<PickupOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'ALL' | 'READY' | 'PREPARING' | 'NEW' | 'COMPLETED'>('ALL');

  // Pickup Handover Modal
  const [handoverTarget, setHandoverTarget] = useState<PickupOrder | null>(null);
  const [enteredCode, setEnteredCode] = useState('');
  const [managerOverride, setManagerOverride] = useState(false);
  const [submittingHandover, setSubmittingHandover] = useState(false);
  const [handoverError, setHandoverError] = useState<string | null>(null);

  async function loadData() {
    if (!supabase) return;
    setLoading(true);
    setError(null);

    try {
      const context = await getCurrentRestaurantContext(supabase);
      if (!context.data) throw new Error('Restaurant workspace not found.');
      const bId = context.data.branch.id;
      setBranchId(bId);
      setBranchName(context.data.branch.name);

      // Try RPC first
      const ordersRes = await supabase.rpc('fulfillment_list_branch_orders', {
        p_branch_id: bId,
        p_type: 'PICKUP',
      });

      let fetchedOrders: PickupOrder[] = [];
      if (!ordersRes.error && ordersRes.data) {
        fetchedOrders = ordersRes.data as PickupOrder[];
      } else {
        // Fallback to direct query
        const { data: directOrders, error: dErr } = await supabase
          .from('orders')
          .select('id,order_number,customer_name,customer_phone,fulfillment_type,status,payment_status,payment_method,total,created_at')
          .eq('branch_id', bId)
          .eq('fulfillment_type', 'PICKUP')
          .order('created_at', { ascending: false })
          .limit(100);

        if (!dErr && directOrders) {
          const orderIds = directOrders.map((o) => o.id);
          const { data: ofdList } = await supabase
            .from('order_fulfillment_details')
            .select('*')
            .in('order_id', orderIds);

          const ofdMap = new Map((ofdList ?? []).map((f) => [f.order_id, f]));

          fetchedOrders = directOrders.map((o) => {
            const f = ofdMap.get(o.id);
            return {
              order_id: o.id,
              order_number: o.order_number,
              customer_name: f?.customer_name_snapshot || o.customer_name || 'Customer',
              customer_phone: f?.customer_phone_snapshot || o.customer_phone || '—',
              fulfillment_type: o.fulfillment_type || 'PICKUP',
              fulfillment_status: f?.fulfillment_status || 'WAITING_FOR_PICKUP',
              order_status: o.status,
              payment_status: o.payment_status,
              payment_method: o.payment_method,
              total: Number(o.total),
              pickup_code: f?.pickup_code_display ?? null,
              promised_ready_at: f?.promised_ready_at ?? null,
              created_at: o.created_at,
              items_count: 0,
            };
          });
        } else if (ordersRes.error) {
          throw ordersRes.error;
        }
      }

      // Fetch items for displayed orders
      if (fetchedOrders.length > 0) {
        const orderIds = fetchedOrders.map((o) => o.order_id);
        const { data: itemsData } = await supabase
          .from('order_items')
          .select('id,order_id,item_name_snapshot,quantity,unit_price')
          .in('order_id', orderIds);

        if (itemsData) {
          const itemsByOrder: Record<string, PickupOrder['items']> = {};
          for (const it of itemsData) {
            (itemsByOrder[it.order_id] ??= []).push(it);
          }
          fetchedOrders = fetchedOrders.map((o) => ({
            ...o,
            items: itemsByOrder[o.order_id] ?? [],
            items_count: itemsByOrder[o.order_id]?.length ?? o.items_count,
          }));
        }
      }

      setOrders(fetchedOrders);
    } catch (err: unknown) {
      const msg =
        (err as { message?: string })?.message ??
        (err instanceof Error ? err.message : 'Could not load pickup orders.');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();

    if (!supabase) return;
    const channel = supabase
      .channel('pickup-management-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        void loadData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_fulfillment_details' }, () => {
        void loadData();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  // Filter orders
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const q = search.trim().toLowerCase();
      const matchesSearch =
        !q ||
        o.order_number.toString().includes(q) ||
        o.customer_name.toLowerCase().includes(q) ||
        o.customer_phone.includes(q) ||
        (o.pickup_code && o.pickup_code.toLowerCase().includes(q));

      let matchesTab = true;
      if (activeTab === 'READY') {
        matchesTab = o.order_status === 'READY';
      } else if (activeTab === 'PREPARING') {
        matchesTab = o.order_status === 'PREPARING' || o.order_status === 'ACCEPTED';
      } else if (activeTab === 'NEW') {
        matchesTab = o.order_status === 'NEW';
      } else if (activeTab === 'COMPLETED') {
        matchesTab = o.order_status === 'COMPLETED' || o.fulfillment_status === 'PICKED_UP';
      }

      return matchesSearch && matchesTab;
    });
  }, [orders, search, activeTab]);

  // Advance order status
  async function handleAdvanceStatus(order: PickupOrder, targetStatus: string) {
    if (!supabase) return;
    setError(null);
    try {
      const { error: tErr } = await supabase.rpc('transition_order_status', {
        p_order_id: order.order_id,
        p_new_status: targetStatus,
      });
      if (tErr) throw tErr;
      void loadData();
    } catch (err: unknown) {
      alert((err as { message?: string })?.message ?? 'Could not advance order status.');
    }
  }

  // Confirm Handover with Code
  async function handleConfirmHandover(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !handoverTarget) return;
    setSubmittingHandover(true);
    setHandoverError(null);

    try {
      const { error: cErr } = await supabase.rpc('fulfillment_confirm_pickup', {
        p_order_id: handoverTarget.order_id,
        p_pickup_code: managerOverride ? null : enteredCode.trim(),
        p_manager_override: managerOverride,
      });

      if (cErr) throw cErr;

      setHandoverTarget(null);
      setEnteredCode('');
      setManagerOverride(false);
      void loadData();
    } catch (err: unknown) {
      const msg =
        (err as { message?: string })?.message ??
        (err instanceof Error ? err.message : 'Invalid pickup code. Please check and try again.');
      setHandoverError(msg);
    } finally {
      setSubmittingHandover(false);
    }
  }

  // Summary counts
  const readyCount = orders.filter((o) => o.order_status === 'READY').length;
  const preparingCount = orders.filter((o) => o.order_status === 'PREPARING' || o.order_status === 'ACCEPTED').length;
  const newCount = orders.filter((o) => o.order_status === 'NEW').length;
  const completedToday = orders.filter((o) => o.order_status === 'COMPLETED').length;

  if (loading) {
    return (
      <StudioShell>
        <div className="setup-loading">Loading self pickup orders…</div>
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="OPERATIONS · SELF PICKUP"
        title="Self Pickup System"
        description={`Manage customer takeaway orders, collection codes, and order handover for ${branchName}.`}
        action={
          <div className="button-row">
            <button
              type="button"
              className="button button-light"
              onClick={() => void loadData()}
              disabled={loading}
            >
              <RefreshCw size={15} /> Refresh
            </button>
            <Link href="/settings/online-ordering" className="button button-primary">
              Pickup Settings
            </Link>
          </div>
        }
      />

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      {/* Fulfillment Mode Switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Link
          href="/pickup"
          className="button button-primary compact"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}
        >
          <ShoppingBag size={14} /> Self Pickup System ({orders.length})
        </Link>
        <Link
          href="/delivery"
          className="button button-light compact"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Bike size={14} /> Home Delivery Dispatch
        </Link>
        <Link
          href="/orders"
          className="button button-light compact"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          📋 Live Orders Board
        </Link>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <div className="surface-card" style={{ padding: '14px 16px', borderLeft: '4px solid #10b981' }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>Ready for Collection</span>
          <strong style={{ fontSize: 24, display: 'block', color: '#059669', marginTop: 4 }}>{readyCount}</strong>
        </div>
        <div className="surface-card" style={{ padding: '14px 16px', borderLeft: '4px solid #3b82f6' }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>In Kitchen / Prep</span>
          <strong style={{ fontSize: 24, display: 'block', color: '#2563eb', marginTop: 4 }}>{preparingCount}</strong>
        </div>
        <div className="surface-card" style={{ padding: '14px 16px', borderLeft: '4px solid #f59e0b' }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>New Awaiting Accept</span>
          <strong style={{ fontSize: 24, display: 'block', color: '#d97706', marginTop: 4 }}>{newCount}</strong>
        </div>
        <div className="surface-card" style={{ padding: '14px 16px', borderLeft: '4px solid #6b7280' }}>
          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>Handed Over</span>
          <strong style={{ fontSize: 24, display: 'block', color: '#374151', marginTop: 4 }}>{completedToday}</strong>
        </div>
      </div>

      {/* Tabs & Search */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`button ${activeTab === 'ALL' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('ALL')}
          >
            All Pickups ({orders.length})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'READY' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('READY')}
          >
            Ready for Pickup ({readyCount})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'PREPARING' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('PREPARING')}
          >
            Preparing ({preparingCount})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'NEW' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('NEW')}
          >
            New ({newCount})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'COMPLETED' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('COMPLETED')}
          >
            Collected ({completedToday})
          </button>
        </div>

        <div style={{ position: 'relative', flex: 1, minWidth: 220, maxWidth: 360 }}>
          <Search size={15} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            type="text"
            placeholder="Search code, name, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%', paddingLeft: 32, height: 36, borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
          />
        </div>
      </div>

      {/* Orders Grid */}
      {filteredOrders.length === 0 ? (
        <div className="empty-wide" style={{ padding: 40, textAlign: 'center' }}>
          <ShoppingBag size={40} style={{ color: '#9ca3af', marginBottom: 12 }} />
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>No pickup orders in this view</h3>
          <p style={{ color: '#6b7280', margin: 0, fontSize: 13 }}>
            New takeaway and self-pickup orders appear here automatically in real time.
          </p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {filteredOrders.map((o) => {
            const isReady = o.order_status === 'READY';
            const isCompleted = o.order_status === 'COMPLETED' || o.fulfillment_status === 'PICKED_UP';

            return (
              <div
                key={o.order_id}
                className="surface-card"
                style={{
                  padding: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  borderTop: isReady ? '3px solid #10b981' : isCompleted ? '3px solid #6b7280' : '3px solid #3b82f6',
                }}
              >
                {/* Header with Pickup Code Badge */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div>
                    <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>ORDER #{o.order_number}</span>
                    <h3 style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 700 }}>{o.customer_name}</h3>
                    <a
                      href={`tel:${o.customer_phone}`}
                      style={{ fontSize: 12, color: '#2563eb', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none', marginTop: 2 }}
                    >
                      <Phone size={11} /> {o.customer_phone}
                    </a>
                  </div>

                  {/* Prominent Pickup Code Badge */}
                  {o.pickup_code && (
                    <div
                      style={{
                        background: '#ecfdf5',
                        border: '1.5px solid #10b981',
                        borderRadius: 6,
                        padding: '4px 10px',
                        textAlign: 'center',
                      }}
                    >
                      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', color: '#065f46', textTransform: 'uppercase' }}>
                        Pickup Code
                      </span>
                      <strong style={{ display: 'block', fontSize: 18, color: '#047857', fontFamily: 'monospace', letterSpacing: '0.1em' }}>
                        #{o.pickup_code}
                      </strong>
                    </div>
                  )}
                </div>

                {/* Items Preview */}
                <div style={{ background: '#f9fafb', borderRadius: 6, padding: '8px 12px', fontSize: 12 }}>
                  <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                    Items ({o.items?.length ?? o.items_count}):
                  </div>
                  {(o.items ?? []).slice(0, 3).map((it) => (
                    <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', color: '#4b5563', lineHeight: 1.4 }}>
                      <span>{it.quantity} × {it.item_name_snapshot}</span>
                      <span>{formatMoney(Number(it.unit_price) * it.quantity)}</span>
                    </div>
                  ))}
                  {(o.items?.length ?? 0) > 3 && (
                    <span style={{ color: '#9ca3af', fontSize: 11 }}>+ {(o.items?.length ?? 0) - 3} more items</span>
                  )}
                </div>

                {/* Meta details */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                  <div>
                    <span style={{ color: '#6b7280' }}>Total: </span>
                    <strong style={{ fontSize: 14 }}>{formatMoney(o.total)}</strong>
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: o.payment_status === 'PAID' ? '#dcfce7' : '#fef3c7',
                        color: o.payment_status === 'PAID' ? '#15803d' : '#b45309',
                      }}
                    >
                      {o.payment_status === 'PAID' ? 'PAID' : 'PAY AT COUNTER'}
                    </span>
                  </div>

                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: isReady ? '#d1fae5' : isCompleted ? '#f3f4f6' : '#dbeafe',
                      color: isReady ? '#065f46' : isCompleted ? '#4b5563' : '#1e40af',
                    }}
                  >
                    {isCompleted ? 'COLLECTED' : o.order_status}
                  </span>
                </div>

                {/* Actions Footer */}
                <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 8, borderTop: '1px solid #f3f4f6' }}>
                  {o.order_status === 'NEW' && (
                    <button
                      type="button"
                      className="button button-primary compact"
                      style={{ width: '100%' }}
                      onClick={() => void handleAdvanceStatus(o, 'ACCEPTED')}
                    >
                      Accept Order
                    </button>
                  )}

                  {o.order_status === 'ACCEPTED' && (
                    <button
                      type="button"
                      className="button button-light compact"
                      style={{ width: '100%' }}
                      onClick={() => void handleAdvanceStatus(o, 'PREPARING')}
                    >
                      Start Preparing
                    </button>
                  )}

                  {o.order_status === 'PREPARING' && (
                    <button
                      type="button"
                      className="button button-primary compact"
                      style={{ width: '100%', background: '#059669', borderColor: '#059669' }}
                      onClick={() => void handleAdvanceStatus(o, 'READY')}
                    >
                      Mark Ready for Pickup
                    </button>
                  )}

                  {isReady && (
                    <button
                      type="button"
                      className="button button-primary compact"
                      style={{ width: '100%', background: '#047857', borderColor: '#047857', fontWeight: 700 }}
                      onClick={() => {
                        setHandoverTarget(o);
                        setEnteredCode('');
                        setManagerOverride(false);
                        setHandoverError(null);
                      }}
                    >
                      <Check size={14} /> Verify Code & Hand Over
                    </button>
                  )}

                  {isCompleted && (
                    <div style={{ width: '100%', textAlign: 'center', fontSize: 12, color: '#059669', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                      <CheckCircle2 size={14} /> Handover Completed
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pickup Code Verification Modal */}
      {handoverTarget && (
        <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setHandoverTarget(null); }}>
          <div className="modal-card compact-modal" style={{ maxWidth: 420 }}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">ORDER #{handoverTarget.order_number}</span>
                <h2>Verify Pickup Handover</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setHandoverTarget(null)}>
                <X size={17} />
              </button>
            </div>

            <form onSubmit={handleConfirmHandover} className="modal-form">
              <p style={{ margin: '0 0 12px', fontSize: 13, color: '#4b5563' }}>
                Ask <strong>{handoverTarget.customer_name}</strong> for their 4-digit Pickup Code shown on their mobile screen.
              </p>

              {handoverError && <div className="notice notice-error" style={{ marginBottom: 12 }}>{handoverError}</div>}

              {!managerOverride ? (
                <label>
                  Enter Customer 4-digit Pickup Code
                  <input
                    type="text"
                    maxLength={4}
                    value={enteredCode}
                    onChange={(e) => setEnteredCode(e.target.value.replace(/\D/g, ''))}
                    placeholder="e.g. 4821"
                    required={!managerOverride}
                    autoFocus
                    style={{ fontSize: 22, letterSpacing: '0.2em', textAlign: 'center', height: 48, fontWeight: 700 }}
                  />
                </label>
              ) : (
                <div style={{ background: '#fef3c7', padding: 12, borderRadius: 6, fontSize: 13, color: '#92400e', marginBottom: 12 }}>
                  <strong>Manager Override:</strong> Confirming handover without customer code. This will be audited in fulfillment events.
                </div>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={managerOverride}
                  onChange={(e) => setManagerOverride(e.target.checked)}
                />
                <span>Customer phone dead / Manager Override</span>
              </label>

              <div className="modal-actions" style={{ marginTop: 16 }}>
                <button type="button" className="button button-light" onClick={() => setHandoverTarget(null)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="button button-primary"
                  disabled={submittingHandover || (!managerOverride && enteredCode.length !== 4)}
                >
                  {submittingHandover ? 'Verifying…' : 'Confirm Handover'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </StudioShell>
  );
}
