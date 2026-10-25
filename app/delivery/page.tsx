'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Bike,
  Clock,
  MapPin,
  Phone,
  User,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  X,
  Search,
  Filter,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { formatMoney } from '@/lib/customer';

type DeliveryOrder = {
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
  delivery_fee: number;
  address_snapshot: {
    house?: string;
    street?: string;
    landmark?: string;
    area?: string;
    pin_code?: string;
  } | null;
  delivery_instructions: string | null;
  pickup_code: string | null;
  delivery_otp: string | null;
  assigned_staff_id: string | null;
  assigned_staff_name: string | null;
  promised_ready_at: string | null;
  promised_delivery_at: string | null;
  created_at: string;
  items_count: number;
};

type BranchStaff = {
  id: string;
  full_name: string;
  role: string;
};

export default function DeliveryDispatchPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [orders, setOrders] = useState<DeliveryOrder[]>([]);
  const [staffList, setStaffList] = useState<BranchStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'ALL' | 'UNASSIGNED' | 'ASSIGNED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'FAILED'>('ALL');

  // Rider assignment modal
  const [assignTarget, setAssignTarget] = useState<DeliveryOrder | null>(null);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [assigning, setAssigning] = useState(false);

  // Delivery confirmation modal
  const [confirmTarget, setConfirmTarget] = useState<DeliveryOrder | null>(null);
  const [enteredOtp, setEnteredOtp] = useState('');
  const [isManagerOverride, setIsManagerOverride] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Failed delivery modal
  const [failTarget, setFailTarget] = useState<DeliveryOrder | null>(null);
  const [failReason, setFailReason] = useState('Customer unreachable');
  const [failing, setFailing] = useState(false);

  // Payment collection modal
  const [collectTarget, setCollectTarget] = useState<DeliveryOrder | null>(null);
  const [collectMethod, setCollectMethod] = useState<'CASH' | 'UPI'>('CASH');
  const [collectAmount, setCollectAmount] = useState<number>(0);
  const [collecting, setCollecting] = useState(false);

  async function loadData() {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const context = await getCurrentRestaurantContext(supabase);
      if (!context.data) throw new Error('Restaurant context not found.');
      const bId = context.data.branch.id;
      setBranchId(bId);
      setBranchName(context.data.branch.name);

      const [ordersRes, staffRes] = await Promise.all([
        supabase.rpc('fulfillment_list_branch_orders', {
          p_branch_id: bId,
          p_type: 'DELIVERY',
        }),
        supabase.from('staff').select('id,full_name,role').eq('branch_id', bId).eq('active', true),
      ]);

      let fetchedOrders: DeliveryOrder[] = [];
      if (!ordersRes.error && ordersRes.data) {
        fetchedOrders = ordersRes.data as DeliveryOrder[];
      } else {
        // Resilient fallback to direct orders query if RPC is pending migration
        const { data: directOrders, error: dErr } = await supabase
          .from('orders')
          .select('id,order_number,customer_name,customer_phone,fulfillment_type,status,payment_status,payment_method,total,created_at')
          .eq('branch_id', bId)
          .eq('fulfillment_type', 'DELIVERY')
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
              fulfillment_type: o.fulfillment_type || 'DELIVERY',
              fulfillment_status: f?.fulfillment_status || 'WAITING_FOR_DRIVER',
              order_status: o.status,
              payment_status: o.payment_status,
              payment_method: o.payment_method,
              total: Number(o.total),
              delivery_fee: Number(f?.delivery_fee_snapshot ?? 0),
              address_snapshot: f?.address_snapshot ?? null,
              delivery_instructions: f?.delivery_instructions ?? null,
              pickup_code: f?.pickup_code_display ?? null,
              delivery_otp: f?.delivery_otp_display ?? null,
              assigned_staff_id: f?.assigned_staff_id ?? null,
              assigned_staff_name: null,
              promised_ready_at: f?.promised_ready_at ?? null,
              promised_delivery_at: f?.promised_delivery_at ?? null,
              created_at: o.created_at,
              items_count: 0,
            };
          });
        } else if (ordersRes.error) {
          throw ordersRes.error;
        }
      }

      setOrders(fetchedOrders);
      if (staffRes.data) {
        setStaffList(staffRes.data as BranchStaff[]);
      }
    } catch (err: unknown) {
      const msg =
        (err as { message?: string })?.message ??
        (err instanceof Error ? err.message : 'Could not load delivery orders.');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadData();

    if (!supabase) return;
    const channel = supabase
      .channel('delivery-dispatch-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_fulfillment_details' }, () => {
        void loadData();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        void loadData();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  // Filtered orders
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const matchesSearch =
        !search.trim() ||
        o.order_number.toString().includes(search.trim()) ||
        o.customer_name.toLowerCase().includes(search.toLowerCase().trim()) ||
        o.customer_phone.includes(search.trim());

      let matchesTab = true;
      if (activeTab === 'UNASSIGNED') {
        matchesTab = o.fulfillment_status === 'WAITING_FOR_DRIVER';
      } else if (activeTab === 'ASSIGNED') {
        matchesTab = o.fulfillment_status === 'ASSIGNED';
      } else if (activeTab === 'OUT_FOR_DELIVERY') {
        matchesTab = o.fulfillment_status === 'OUT_FOR_DELIVERY';
      } else if (activeTab === 'DELIVERED') {
        matchesTab = o.fulfillment_status === 'DELIVERED';
      } else if (activeTab === 'FAILED') {
        matchesTab = o.fulfillment_status === 'DELIVERY_FAILED' || o.fulfillment_status === 'RETURNED_TO_RESTAURANT';
      }

      return matchesSearch && matchesTab;
    });
  }, [orders, search, activeTab]);

  // Actions
  async function handleAssignRider(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !assignTarget || !selectedStaffId) return;
    setAssigning(true);
    try {
      const { error: err } = await supabase.rpc('fulfillment_assign_rider', {
        p_order_id: assignTarget.order_id,
        p_staff_id: selectedStaffId,
      });
      if (err) throw err;
      setAssignTarget(null);
      void loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not assign rider.');
    } finally {
      setAssigning(false);
    }
  }

  async function handleDispatch(orderId: string) {
    if (!supabase) return;
    try {
      const { error: err } = await supabase.rpc('fulfillment_dispatch_delivery', {
        p_order_id: orderId,
      });
      if (err) throw err;
      void loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not dispatch delivery.');
    }
  }

  async function handleConfirmDelivered(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !confirmTarget) return;
    setConfirming(true);
    try {
      const { error: err } = await supabase.rpc('fulfillment_confirm_delivered', {
        p_order_id: confirmTarget.order_id,
        p_delivery_otp: isManagerOverride ? null : enteredOtp.trim(),
        p_manager_override: isManagerOverride,
      });
      if (err) throw err;
      setConfirmTarget(null);
      void loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not confirm delivery.');
    } finally {
      setConfirming(false);
    }
  }

  async function handleRecordFailed(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !failTarget) return;
    setFailing(true);
    try {
      const { error: err } = await supabase.rpc('fulfillment_record_failed_delivery', {
        p_order_id: failTarget.order_id,
        p_reason: failReason,
      });
      if (err) throw err;
      setFailTarget(null);
      void loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not record failed delivery.');
    } finally {
      setFailing(false);
    }
  }

  async function handleCollectPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !collectTarget) return;
    setCollecting(true);
    try {
      const { error: err } = await supabase.rpc('fulfillment_collect_payment', {
        p_order_id: collectTarget.order_id,
        p_method: collectMethod,
        p_amount: collectAmount,
      });
      if (err) throw err;
      setCollectTarget(null);
      void loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Could not record payment collection.');
    } finally {
      setCollecting(false);
    }
  }

  if (loading) {
    return (
      <StudioShell>
        <div className="setup-loading">Loading delivery dispatch operations…</div>
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="OPERATIONS · DELIVERY"
        title="Delivery Dispatch Board"
        description={`Manage rider assignments, live transit, and order deliveries for ${branchName}.`}
        action={
          <div className="button-row">
            <Link href="/delivery/my-orders" className="button button-light">
              <User size={15} /> Rider Workspace
            </Link>
            <button
              type="button"
              className="button button-light"
              onClick={() => void loadData()}
              disabled={loading}
            >
              <RefreshCw size={15} /> Refresh
            </button>
            <Link href="/settings/online-ordering" className="button button-primary">
              Delivery Settings
            </Link>
          </div>
        }
      />

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      {/* Fulfillment Mode Switcher */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Link
          href="/delivery"
          className="button button-primary compact"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700 }}
        >
          <Bike size={14} /> Home Delivery ({orders.length})
        </Link>
        <Link
          href="/pickup"
          className="button button-light compact"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          🥡 Self Pickup System
        </Link>
        <Link
          href="/orders"
          className="button button-light compact"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          📋 Live Orders Board
        </Link>
      </div>

      {/* Status Filter Tabs & Search */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`button ${activeTab === 'ALL' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('ALL')}
          >
            All Deliveries ({orders.length})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'UNASSIGNED' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('UNASSIGNED')}
          >
            Awaiting Rider ({orders.filter((o) => o.fulfillment_status === 'WAITING_FOR_DRIVER').length})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'ASSIGNED' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('ASSIGNED')}
          >
            Assigned ({orders.filter((o) => o.fulfillment_status === 'ASSIGNED').length})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'OUT_FOR_DELIVERY' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('OUT_FOR_DELIVERY')}
          >
            Out for Delivery ({orders.filter((o) => o.fulfillment_status === 'OUT_FOR_DELIVERY').length})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'DELIVERED' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('DELIVERED')}
          >
            Delivered ({orders.filter((o) => o.fulfillment_status === 'DELIVERED').length})
          </button>
          <button
            type="button"
            className={`button ${activeTab === 'FAILED' ? 'button-primary' : 'button-light'} compact`}
            onClick={() => setActiveTab('FAILED')}
          >
            Failed ({orders.filter((o) => o.fulfillment_status === 'DELIVERY_FAILED').length})
          </button>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="search"
            placeholder="Search order #, customer, phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 13 }}
          />
        </div>
      </div>

      {/* Orders Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
        {filteredOrders.map((o) => (
          <article className="surface-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }} key={o.order_id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <strong style={{ fontSize: 16 }}>Order #{o.order_number}</strong>
                <span style={{ fontSize: 13, color: '#64748b', display: 'block' }}>
                  Placed: {new Date(o.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <span
                style={{
                  padding: '3px 8px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  background:
                    o.fulfillment_status === 'DELIVERED'
                      ? '#dcfce7'
                      : o.fulfillment_status === 'OUT_FOR_DELIVERY'
                      ? '#e0f2fe'
                      : o.fulfillment_status === 'DELIVERY_FAILED'
                      ? '#fee2e2'
                      : '#fef3c7',
                  color:
                    o.fulfillment_status === 'DELIVERED'
                      ? '#166534'
                      : o.fulfillment_status === 'OUT_FOR_DELIVERY'
                      ? '#0369a1'
                      : o.fulfillment_status === 'DELIVERY_FAILED'
                      ? '#991b1b'
                      : '#92400e',
                }}
              >
                {o.fulfillment_status.replaceAll('_', ' ')}
              </span>
            </div>

            {/* Customer & Address Details */}
            <div style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div>
                <strong>{o.customer_name}</strong> · <a href={`tel:${o.customer_phone}`}>{o.customer_phone}</a>
              </div>
              {o.address_snapshot && (
                <div style={{ color: '#475569', display: 'flex', gap: 6 }}>
                  <MapPin size={15} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>
                    {o.address_snapshot.house}, {o.address_snapshot.street}
                    {o.address_snapshot.landmark ? ` (Near ${o.address_snapshot.landmark})` : ''} · PIN {o.address_snapshot.pin_code}
                  </span>
                </div>
              )}
              {o.delivery_instructions && (
                <div style={{ fontSize: 12, color: '#0369a1', background: '#f0f9ff', padding: '4px 8px', borderRadius: 6 }}>
                  Note: {o.delivery_instructions}
                </div>
              )}
            </div>

            {/* Financial Summary */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>
              <span>{o.items_count} items</span>
              <strong>{formatMoney(Number(o.total))}</strong>
              <span style={{ fontSize: 11, fontWeight: 600, color: o.payment_status === 'PAID' ? '#166534' : '#b45309' }}>
                {o.payment_status === 'PAID' ? 'PAID ONLINE' : 'COLLECT CASH / UPI'}
              </span>
            </div>

            {/* Rider Information */}
            <div style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
              <span>
                Rider: <b>{o.assigned_staff_name || 'Unassigned'}</b>
              </span>
              {o.delivery_otp && (
                <span style={{ fontSize: 11, color: '#64748b' }} title="Customer will provide this code on delivery">
                  OTP: ****
                </span>
              )}
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
              {o.fulfillment_status === 'WAITING_FOR_DRIVER' && (
                <button
                  type="button"
                  className="button button-primary compact"
                  onClick={() => {
                    setAssignTarget(o);
                    setSelectedStaffId(staffList[0]?.id || '');
                  }}
                >
                  <User size={13} /> Assign Rider
                </button>
              )}

              {o.fulfillment_status === 'ASSIGNED' && (
                <>
                  <button
                    type="button"
                    className="button button-primary compact"
                    onClick={() => void handleDispatch(o.order_id)}
                  >
                    <Bike size={13} /> Dispatch (Out for Delivery)
                  </button>
                  <button
                    type="button"
                    className="button button-light compact"
                    onClick={() => {
                      setAssignTarget(o);
                      setSelectedStaffId(o.assigned_staff_id || staffList[0]?.id || '');
                    }}
                  >
                    Reassign
                  </button>
                </>
              )}

              {o.fulfillment_status === 'OUT_FOR_DELIVERY' && (
                <>
                  <button
                    type="button"
                    className="button button-primary compact"
                    onClick={() => {
                      setConfirmTarget(o);
                      setEnteredOtp('');
                      setIsManagerOverride(false);
                    }}
                  >
                    <CheckCircle2 size={13} /> Confirm Delivered
                  </button>
                  <button
                    type="button"
                    className="button button-light compact danger-button"
                    onClick={() => {
                      setFailTarget(o);
                      setFailReason('Customer unreachable');
                    }}
                  >
                    <AlertCircle size={13} /> Failed
                  </button>
                </>
              )}

              {o.fulfillment_status === 'DELIVERED' && o.payment_status !== 'PAID' && (
                <button
                  type="button"
                  className="button button-primary compact"
                  onClick={() => {
                    setCollectTarget(o);
                    setCollectAmount(Number(o.total));
                    setCollectMethod('CASH');
                  }}
                >
                  Collect Payment (₹{o.total})
                </button>
              )}
            </div>
          </article>
        ))}

        {filteredOrders.length === 0 && (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '40px', color: '#64748b' }}>
            No delivery orders found matching this filter.
          </div>
        )}
      </div>

      {/* Assign Rider Modal */}
      {assignTarget && (
        <div className="modal-backdrop" onClick={() => setAssignTarget(null)}>
          <div className="modal-card compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Assign Delivery Rider</h2>
              <button type="button" className="icon-button" onClick={() => setAssignTarget(null)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleAssignRider} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: 13, color: '#475569', margin: 0 }}>
                Order #{assignTarget.order_number} · {assignTarget.customer_name} ({assignTarget.customer_phone})
              </p>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                Select Delivery Employee:
                <select
                  required
                  value={selectedStaffId}
                  onChange={(e) => setSelectedStaffId(e.target.value)}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                >
                  {staffList.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.full_name} ({st.role})
                    </option>
                  ))}
                </select>
              </label>

              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button type="button" className="button button-light" onClick={() => setAssignTarget(null)}>
                  Cancel
                </button>
                <button type="submit" className="button button-primary" disabled={assigning}>
                  {assigning ? 'Assigning…' : 'Confirm Assignment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Confirm Delivered Modal */}
      {confirmTarget && (
        <div className="modal-backdrop" onClick={() => setConfirmTarget(null)}>
          <div className="modal-card compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Confirm Order Delivered</h2>
              <button type="button" className="icon-button" onClick={() => setConfirmTarget(null)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleConfirmDelivered} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: 13, color: '#475569', margin: 0 }}>
                Order #{confirmTarget.order_number} · Enter customer delivery OTP or use manager override.
              </p>

              {!isManagerOverride ? (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  Customer 4-Digit Delivery OTP:
                  <input
                    type="text"
                    required={!isManagerOverride}
                    maxLength={4}
                    placeholder="e.g. 7194"
                    value={enteredOtp}
                    onChange={(e) => setEnteredOtp(e.target.value)}
                    style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 18, letterSpacing: '0.2em', textAlign: 'center' }}
                  />
                </label>
              ) : (
                <div style={{ background: '#fef3c7', padding: '10px 14px', borderRadius: 8, color: '#92400e', fontSize: 13 }}>
                  <ShieldAlert size={16} style={{ display: 'inline', marginRight: 6 }} />
                  Manager override: This delivery will be confirmed without customer OTP and will be audited.
                </div>
              )}

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={isManagerOverride}
                  onChange={(e) => setIsManagerOverride(e.target.checked)}
                />
                <span>Manager Override (Customer phone unavailable)</span>
              </label>

              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button type="button" className="button button-light" onClick={() => setConfirmTarget(null)}>
                  Cancel
                </button>
                <button type="submit" className="button button-primary" disabled={confirming}>
                  {confirming ? 'Confirming…' : 'Complete Delivery'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Failed Delivery Modal */}
      {failTarget && (
        <div className="modal-backdrop" onClick={() => setFailTarget(null)}>
          <div className="modal-card compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Record Failed Delivery</h2>
              <button type="button" className="icon-button" onClick={() => setFailTarget(null)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleRecordFailed} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                Reason for Delivery Failure:
                <select
                  value={failReason}
                  onChange={(e) => setFailReason(e.target.value)}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                >
                  <option value="Customer unreachable">Customer unreachable / Phone switched off</option>
                  <option value="Incorrect address">Incorrect address / Door locked</option>
                  <option value="Customer refused parcel">Customer refused parcel</option>
                  <option value="Rider unable to complete">Rider unable to reach location</option>
                  <option value="Returned to restaurant">Parcel returned to restaurant</option>
                </select>
              </label>

              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button type="button" className="button button-light" onClick={() => setFailTarget(null)}>
                  Cancel
                </button>
                <button type="submit" className="button button-danger" disabled={failing}>
                  {failing ? 'Recording…' : 'Record Failure'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Payment Collection Modal */}
      {collectTarget && (
        <div className="modal-backdrop" onClick={() => setCollectTarget(null)}>
          <div className="modal-card compact-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Collect Payment for Order #{collectTarget.order_number}</h2>
              <button type="button" className="icon-button" onClick={() => setCollectTarget(null)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCollectPayment} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', background: '#f8fafc', borderRadius: 8 }}>
                <span>Total Due:</span>
                <strong>{formatMoney(Number(collectTarget.total))}</strong>
              </div>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                Payment Method:
                <select
                  value={collectMethod}
                  onChange={(e) => setCollectMethod(e.target.value as 'CASH' | 'UPI')}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                >
                  <option value="CASH">Cash collected</option>
                  <option value="UPI">UPI received (GPay / PhonePe / QR)</option>
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                Amount Collected (₹):
                <input
                  type="number"
                  required
                  min={collectTarget.total}
                  value={collectAmount}
                  onChange={(e) => setCollectAmount(Number(e.target.value))}
                  style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                />
              </label>

              <div className="modal-actions" style={{ marginTop: 12 }}>
                <button type="button" className="button button-light" onClick={() => setCollectTarget(null)}>
                  Cancel
                </button>
                <button type="submit" className="button button-primary" disabled={collecting}>
                  {collecting ? 'Recording…' : 'Confirm Payment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </StudioShell>
  );
}
