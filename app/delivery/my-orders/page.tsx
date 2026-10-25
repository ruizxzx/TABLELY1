'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Bike,
  Phone,
  Navigation,
  CheckCircle2,
  AlertCircle,
  Clock,
  MapPin,
  RefreshCw,
  X,
  CreditCard,
  Banknote,
  Smartphone,
  ChevronRight,
  ArrowLeft,
} from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { formatMoney } from '@/lib/customer';

type RiderDelivery = {
  order_id: string;
  order_number: number;
  customer_name: string;
  customer_phone: string;
  address_snapshot: {
    house?: string;
    street?: string;
    landmark?: string;
    area?: string;
    pin_code?: string;
  } | null;
  delivery_instructions: string | null;
  fulfillment_status: string;
  payment_status: string;
  payment_method: string | null;
  total: number;
  delivery_fee: number;
  promised_delivery_at: string | null;
  created_at: string;
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    unit_price: number;
    special_instructions?: string | null;
  }>;
};

export default function RiderWorkspacePage() {
  const supabase = getSupabaseBrowserClient();
  const [deliveries, setDeliveries] = useState<RiderDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // OTP modal
  const [otpTarget, setOtpTarget] = useState<RiderDelivery | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [submittingOtp, setSubmittingOtp] = useState(false);

  // Payment collection modal
  const [paymentTarget, setPaymentTarget] = useState<RiderDelivery | null>(null);
  const [payMethod, setPayMethod] = useState<'CASH' | 'UPI'>('CASH');
  const [payAmount, setPayAmount] = useState<number>(0);
  const [submittingPay, setSubmittingPay] = useState(false);

  async function loadMyDeliveries() {
    if (!supabase) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase.rpc('fulfillment_list_my_deliveries');
      if (err) throw err;
      setDeliveries((data ?? []) as RiderDelivery[]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not load your deliveries.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMyDeliveries();

    if (!supabase) return;
    const channel = supabase
      .channel('rider-workspace-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_fulfillment_details' }, () => {
        void loadMyDeliveries();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  async function handleStartDelivery(orderId: string) {
    if (!supabase) return;
    try {
      const { error: err } = await supabase.rpc('fulfillment_dispatch_delivery', {
        p_order_id: orderId,
      });
      if (err) throw err;
      void loadMyDeliveries();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Could not start delivery.');
    }
  }

  async function handleConfirmWithOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !otpTarget || !otpInput.trim()) return;
    setSubmittingOtp(true);
    try {
      const { error: err } = await supabase.rpc('fulfillment_confirm_delivered', {
        p_order_id: otpTarget.order_id,
        p_delivery_otp: otpInput.trim(),
        p_manager_override: false,
      });
      if (err) throw err;
      setOtpTarget(null);
      void loadMyDeliveries();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Invalid OTP or confirmation error.');
    } finally {
      setSubmittingOtp(false);
    }
  }

  async function handleCollectPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !paymentTarget) return;
    setSubmittingPay(true);
    try {
      const { error: err } = await supabase.rpc('fulfillment_collect_payment', {
        p_order_id: paymentTarget.order_id,
        p_method: payMethod,
        p_amount: payAmount,
      });
      if (err) throw err;
      setPaymentTarget(null);
      void loadMyDeliveries();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : 'Payment collection error.');
    } finally {
      setSubmittingPay(false);
    }
  }

  const activeDeliveries = deliveries.filter(
    (d) => d.fulfillment_status === 'ASSIGNED' || d.fulfillment_status === 'READY_FOR_DISPATCH' || d.fulfillment_status === 'OUT_FOR_DELIVERY',
  );
  const completedDeliveries = deliveries.filter((d) => d.fulfillment_status === 'DELIVERED');

  if (loading) {
    return (
      <StudioShell>
        <div className="setup-loading">Loading your assigned deliveries…</div>
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Link href="/delivery" className="button button-light compact">
            <ArrowLeft size={14} /> Dispatch Board
          </Link>
          <button type="button" className="button button-light compact" onClick={() => void loadMyDeliveries()}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        <SectionHeader
          eyebrow="RIDER WORKSPACE"
          title="My Deliveries"
          description="Your active assigned runs, navigation shortcuts, OTP verification, and COD collection."
        />

        {error && <div className="notice notice-error" role="alert">{error}</div>}

        {/* Active Deliveries List */}
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '20px 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Bike size={18} /> Current Assigned Deliveries ({activeDeliveries.length})
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {activeDeliveries.map((d) => {
            const addressText = d.address_snapshot
              ? `${d.address_snapshot.house || ''}, ${d.address_snapshot.street || ''}, ${d.address_snapshot.area || ''} PIN ${d.address_snapshot.pin_code || ''}`
              : 'Address not recorded';

            const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressText)}`;

            return (
              <article
                className="surface-card"
                style={{
                  padding: 18,
                  borderRadius: 14,
                  border: '2px solid #0f766e',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
                key={d.order_id}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontSize: 17, color: '#0f766e' }}>Order #{d.order_number}</strong>
                  <span
                    style={{
                      padding: '4px 10px',
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: 700,
                      background: d.fulfillment_status === 'OUT_FOR_DELIVERY' ? '#e0f2fe' : '#fef3c7',
                      color: d.fulfillment_status === 'OUT_FOR_DELIVERY' ? '#0369a1' : '#92400e',
                    }}
                  >
                    {d.fulfillment_status.replaceAll('_', ' ')}
                  </span>
                </div>

                {/* Customer and Contact */}
                <div>
                  <h3 style={{ fontSize: 15, margin: '0 0 4px' }}>{d.customer_name}</h3>
                  <a
                    href={`tel:${d.customer_phone}`}
                    className="button button-light"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', fontSize: 13 }}
                  >
                    <Phone size={14} /> Call {d.customer_phone}
                  </a>
                </div>

                {/* Delivery Location & Map Link */}
                <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: 10, fontSize: 13 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 8 }}>
                    <MapPin size={16} style={{ flexShrink: 0, marginTop: 2, color: '#64748b' }} />
                    <span>{addressText}</span>
                  </div>
                  {d.address_snapshot?.landmark && (
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
                      Landmark: {d.address_snapshot.landmark}
                    </div>
                  )}
                  {d.delivery_instructions && (
                    <div style={{ fontSize: 12, color: '#0369a1', background: '#f0f9ff', padding: '4px 8px', borderRadius: 6, marginBottom: 8 }}>
                      Note: {d.delivery_instructions}
                    </div>
                  )}
                  <a
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="button button-primary compact"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    <Navigation size={13} /> Open in Google Maps
                  </a>
                </div>

                {/* Items & Payment Due */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #e2e8f0', paddingTop: 10, fontSize: 13 }}>
                  <span>{d.items.length} items to hand over</span>
                  <div>
                    <strong>Total Due: {formatMoney(Number(d.total))}</strong>
                    <div style={{ fontSize: 11, fontWeight: 700, color: d.payment_status === 'PAID' ? '#166534' : '#b45309', textAlign: 'right' }}>
                      {d.payment_status === 'PAID' ? 'PAID (No collection due)' : 'COLLECT CASH / UPI'}
                    </div>
                  </div>
                </div>

                {/* Operational Action Buttons */}
                <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                  {d.fulfillment_status === 'READY_FOR_DISPATCH' && (
                    <button
                      type="button"
                      className="button button-primary"
                      style={{ flex: 1, padding: 12 }}
                      onClick={() => void handleStartDelivery(d.order_id)}
                    >
                      <Bike size={16} /> Start Delivery (Out)
                    </button>
                  )}

                  {d.fulfillment_status === 'OUT_FOR_DELIVERY' && (
                    <>
                      <button
                        type="button"
                        className="button button-primary"
                        style={{ flex: 1.2, padding: 12 }}
                        onClick={() => {
                          setOtpTarget(d);
                          setOtpInput('');
                        }}
                      >
                        <CheckCircle2 size={16} /> Enter OTP to Deliver
                      </button>

                      {d.payment_status !== 'PAID' && (
                        <button
                          type="button"
                          className="button button-light"
                          style={{ flex: 1, padding: 12 }}
                          onClick={() => {
                            setPaymentTarget(d);
                            setPayAmount(Number(d.total));
                            setPayMethod('CASH');
                          }}
                        >
                          <Banknote size={16} /> Record Cash
                        </button>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}

          {activeDeliveries.length === 0 && (
            <div className="surface-card" style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>
              <p>No active deliveries currently assigned to you. Stand by for orders!</p>
            </div>
          )}
        </div>

        {/* Completed Deliveries */}
        {completedDeliveries.length > 0 && (
          <div style={{ marginTop: 30 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#475569', marginBottom: 10 }}>
              Completed Today ({completedDeliveries.length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {completedDeliveries.slice(0, 5).map((d) => (
                <div
                  key={d.order_id}
                  className="surface-card"
                  style={{
                    padding: 12,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 13,
                  }}
                >
                  <div>
                    <strong>Order #{d.order_number}</strong> · {d.customer_name}
                    <small style={{ display: 'block', color: '#64748b' }}>
                      Delivered {d.promised_delivery_at ? new Date(d.promised_delivery_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently'}
                    </small>
                  </div>
                  <span style={{ color: '#166534', fontWeight: 700 }}>
                    {formatMoney(Number(d.total))} · Delivered
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Enter OTP Modal */}
        {otpTarget && (
          <div className="modal-backdrop" onClick={() => setOtpTarget(null)}>
            <div className="modal-card compact-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h2>Customer Delivery OTP</h2>
                <button type="button" className="icon-button" onClick={() => setOtpTarget(null)}>
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleConfirmWithOtp} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <p style={{ fontSize: 13, color: '#475569', margin: 0 }}>
                  Ask the customer for their 4-digit OTP from their order tracking page or SMS:
                </p>

                <input
                  type="text"
                  required
                  maxLength={4}
                  placeholder="e.g. 7194"
                  value={otpInput}
                  onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, ''))}
                  style={{
                    padding: '12px',
                    borderRadius: 10,
                    border: '2px solid #0f766e',
                    fontSize: 24,
                    letterSpacing: '0.25em',
                    textAlign: 'center',
                    fontWeight: 700,
                  }}
                />

                <div className="modal-actions" style={{ marginTop: 12 }}>
                  <button type="button" className="button button-light" onClick={() => setOtpTarget(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="button button-primary" disabled={submittingOtp || otpInput.length !== 4}>
                    {submittingOtp ? 'Verifying…' : 'Confirm Delivery'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Record Payment Modal */}
        {paymentTarget && (
          <div className="modal-backdrop" onClick={() => setPaymentTarget(null)}>
            <div className="modal-card compact-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h2>Record Payment for Order #{paymentTarget.order_number}</h2>
                <button type="button" className="icon-button" onClick={() => setPaymentTarget(null)}>
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleCollectPayment} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', background: '#f8fafc', borderRadius: 8 }}>
                  <span>Total Amount Due:</span>
                  <strong>{formatMoney(Number(paymentTarget.total))}</strong>
                </div>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  Payment Method:
                  <select
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value as 'CASH' | 'UPI')}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                  >
                    <option value="CASH">Cash collected in hand</option>
                    <option value="UPI">UPI transferred (GPay / PhonePe / QR)</option>
                  </select>
                </label>

                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  Amount Received (₹):
                  <input
                    type="number"
                    required
                    min={paymentTarget.total}
                    value={payAmount}
                    onChange={(e) => setPayAmount(Number(e.target.value))}
                    style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}
                  />
                </label>

                <div className="modal-actions" style={{ marginTop: 12 }}>
                  <button type="button" className="button button-light" onClick={() => setPaymentTarget(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="button button-primary" disabled={submittingPay}>
                    {submittingPay ? 'Saving…' : 'Confirm Payment'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </StudioShell>
  );
}
