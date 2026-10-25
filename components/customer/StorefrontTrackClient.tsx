'use client';

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Clock,
  MapPin,
  Phone,
  CheckCircle2,
  AlertCircle,
  Store,
  Bike,
  KeyRound,
  RotateCcw,
  ReceiptText,
} from 'lucide-react';
import {
  getPublicFulfillmentOrder,
  formatMoney,
  type PublicFulfillmentOrderTracking,
} from '@/lib/customer';
import { getSupabaseBrowserClient } from '@/lib/supabase';

export default function StorefrontTrackClient({
  restaurantSlug,
  trackingToken,
}: {
  restaurantSlug: string;
  trackingToken: string;
}) {
  const [order, setOrder] = useState<PublicFulfillmentOrderTracking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadOrder() {
    try {
      const data = await getPublicFulfillmentOrder(trackingToken);
      setOrder(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load order tracking.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadOrder();

    // Set up Realtime listener on orders
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const channel = supabase
      .channel(`public:track:${trackingToken}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => {
          void loadOrder();
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'order_fulfillment_details' },
        () => {
          void loadOrder();
        },
      )
      .subscribe();

    const interval = setInterval(() => {
      void loadOrder();
    }, 15000);

    return () => {
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [trackingToken]);

  // Stepper calculations
  const steps = useMemo(() => {
    if (!order) return [];

    if (order.fulfillment_type === 'PICKUP') {
      return [
        { key: 'NEW', label: 'Order Placed', desc: 'Sent to restaurant' },
        { key: 'ACCEPTED', label: 'Accepted', desc: 'Confirmed by kitchen' },
        { key: 'PREPARING', label: 'Preparing', desc: 'Fresh in the kitchen' },
        { key: 'WAITING_FOR_PICKUP', label: 'Ready for Pickup', desc: 'Waiting at counter' },
        { key: 'PICKED_UP', label: 'Collected', desc: 'Enjoy your meal!' },
      ];
    } else {
      return [
        { key: 'NEW', label: 'Order Placed', desc: 'Sent to restaurant' },
        { key: 'ACCEPTED', label: 'Accepted', desc: 'Confirmed by kitchen' },
        { key: 'PREPARING', label: 'Preparing', desc: 'Cooking your dishes' },
        { key: 'OUT_FOR_DELIVERY', label: 'Out for Delivery', desc: 'Rider is on the way' },
        { key: 'DELIVERED', label: 'Delivered', desc: 'Delivered successfully' },
      ];
    }
  }, [order]);

  const currentStepIndex = useMemo(() => {
    if (!order) return 0;

    if (order.status === 'CANCELLED' || order.status === 'REJECTED') return -1;

    if (order.fulfillment_type === 'PICKUP') {
      if (order.fulfillment_status === 'PICKED_UP' || order.status === 'COMPLETED') return 4;
      if (order.fulfillment_status === 'WAITING_FOR_PICKUP' || order.status === 'READY') return 3;
      if (order.status === 'PREPARING') return 2;
      if (order.status === 'ACCEPTED') return 1;
      return 0;
    } else {
      if (order.fulfillment_status === 'DELIVERED' || order.status === 'COMPLETED') return 4;
      if (order.fulfillment_status === 'OUT_FOR_DELIVERY') return 3;
      if (order.status === 'PREPARING' || order.status === 'READY') return 2;
      if (order.status === 'ACCEPTED' || order.fulfillment_status === 'ASSIGNED') return 1;
      return 0;
    }
  }, [order]);

  if (loading) {
    return (
      <div className="track-container">
        <div className="storefront-spinner" />
        <p>Loading your order details…</p>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="track-container track-error">
        <AlertCircle size={36} />
        <h2>Order Not Found</h2>
        <p>{error || 'This tracking link is invalid or expired.'}</p>
        <Link href={`/r/${encodeURIComponent(restaurantSlug)}/order`} className="button button-primary">
          Back to Restaurant
        </Link>
      </div>
    );
  }

  return (
    <div className="track-container">
      {/* Top Banner */}
      <header className="track-header">
        <div className="track-brand">
          <h1>{order.restaurant_name}</h1>
          <p>{order.branch_name} · {order.branch_address}</p>
        </div>
        <div className="order-number-tag">
          Order #{order.order_number}
        </div>
      </header>

      {/* Rejection / Cancellation Notice */}
      {order.status === 'REJECTED' || order.status === 'CANCELLED' ? (
        <div className="track-cancelled-card">
          <AlertCircle size={28} />
          <div>
            <h3>Order {order.status === 'REJECTED' ? 'Declined' : 'Cancelled'}</h3>
            <p>{order.rejection_reason || 'The restaurant was unable to fulfill this order at this time.'}</p>
          </div>
        </div>
      ) : (
        /* Status Stepper Card */
        <section className="track-stepper-card">
          <div className="stepper-title-row">
            <div>
              <span className="card-kicker">LIVE STATUS</span>
              <h2>{steps[currentStepIndex]?.label || 'In Progress'}</h2>
            </div>
            <div className="fulfillment-badge">
              {order.fulfillment_type === 'PICKUP' ? (
                <>
                  <Store size={16} /> Self Pickup
                </>
              ) : (
                <>
                  <Bike size={16} /> Home Delivery
                </>
              )}
            </div>
          </div>

          <div className="stepper-timeline">
            {steps.map((step, idx) => {
              const isDone = idx < currentStepIndex;
              const isCurrent = idx === currentStepIndex;

              return (
                <div
                  className={`timeline-step ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}`}
                  key={step.key}
                >
                  <div className="step-marker">
                    {isDone ? <CheckCircle2 size={16} /> : <span>{idx + 1}</span>}
                  </div>
                  <div className="step-content">
                    <strong>{step.label}</strong>
                    <small>{step.desc}</small>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Verification Code Box (Pickup Code or Delivery OTP) */}
          {order.fulfillment_type === 'PICKUP' && order.pickup_code && order.fulfillment_status !== 'PICKED_UP' && (
            <div className="verification-code-card">
              <KeyRound size={24} />
              <div>
                <span>YOUR PICKUP CODE</span>
                <strong className="code-display">{order.pickup_code}</strong>
                <small>Show this code to restaurant staff to collect your order</small>
              </div>
            </div>
          )}

          {order.fulfillment_type === 'DELIVERY' && order.delivery_otp && order.fulfillment_status !== 'DELIVERED' && (
            <div className="verification-code-card">
              <KeyRound size={24} />
              <div>
                <span>YOUR DELIVERY OTP</span>
                <strong className="code-display">{order.delivery_otp}</strong>
                <small>Share this 4-digit OTP with your rider upon parcel handover</small>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ETA & Contact Section */}
      <section className="track-meta-card">
        {order.promised_ready_at && order.fulfillment_type === 'PICKUP' && (
          <div className="meta-row">
            <Clock size={16} />
            <div>
              <span>Estimated Ready Time:</span>
              <strong>{new Date(order.promised_ready_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>
            </div>
          </div>
        )}

        {order.promised_delivery_at && order.fulfillment_type === 'DELIVERY' && (
          <div className="meta-row">
            <Clock size={16} />
            <div>
              <span>Estimated Delivery:</span>
              <strong>{new Date(order.promised_delivery_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong>
            </div>
          </div>
        )}

        {order.delivery_address && (
          <div className="meta-row">
            <MapPin size={16} />
            <div>
              <span>Delivery Address:</span>
              <strong>
                {order.delivery_address.house}, {order.delivery_address.street}
                {order.delivery_address.landmark ? ` (Near ${order.delivery_address.landmark})` : ''} · PIN {order.delivery_address.pin_code}
              </strong>
            </div>
          </div>
        )}

        {order.branch_phone && (
          <div className="meta-row">
            <Phone size={16} />
            <div>
              <span>Restaurant Phone:</span>
              <a href={`tel:${order.branch_phone}`}><strong>{order.branch_phone}</strong></a>
            </div>
          </div>
        )}
      </section>

      {/* Items & Financial Receipt */}
      <section className="track-receipt-card">
        <div className="receipt-head">
          <ReceiptText size={18} />
          <h3>Order Items</h3>
        </div>

        <div className="receipt-items">
          {order.items.map((item) => (
            <div className="receipt-item-row" key={item.id}>
              <span>{item.quantity}× {item.name}</span>
              <strong>{formatMoney(Number(item.line_total))}</strong>
            </div>
          ))}
        </div>

        <div className="receipt-totals">
          <div className="totals-row">
            <span>Subtotal</span>
            <span>{formatMoney(Number(order.subtotal))}</span>
          </div>

          {Number(order.discount) > 0 && (
            <div className="totals-row discount">
              <span>Discount</span>
              <span>−{formatMoney(Number(order.discount))}</span>
            </div>
          )}

          {Number(order.additional_charges) > 0 && (
            <div className="totals-row">
              <span>Fees & Taxes</span>
              <span>{formatMoney(Number(order.additional_charges))}</span>
            </div>
          )}

          <div className="totals-final">
            <strong>Total Paid / Due</strong>
            <strong>{formatMoney(Number(order.total))}</strong>
          </div>

          <div className="payment-status-badge">
            Payment: <b>{order.payment_method?.replaceAll('_', ' ')}</b> ·{' '}
            <span className={order.payment_status === 'PAID' ? 'paid-text' : 'pending-text'}>
              {order.payment_status}
            </span>
          </div>
        </div>
      </section>

      <footer className="track-footer">
        <Link href={`/r/${encodeURIComponent(restaurantSlug)}/order`} className="button button-light">
          Order More Food
        </Link>
      </footer>
    </div>
  );
}
