'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Store,
  Bike,
  CheckCircle2,
  AlertCircle,
  Tag,
  CreditCard,
  Banknote,
  Smartphone,
  Clock,
  MapPin,
  ChevronRight,
} from 'lucide-react';
import {
  getPublicStorefrontContext,
  previewPublicFulfillmentCheckout,
  createPublicFulfillmentOrder,
  readFulfillmentCart,
  clearFulfillmentCart,
  formatMoney,
  type PublicStorefrontContext,
  type PublicFulfillmentCheckoutPreview,
  type CartItem,
} from '@/lib/customer';

async function getFulfillmentCheckoutIdempotencyKey(branchId: string, payload: unknown) {
  const storageKey = `tablely:fulfillment:checkout-key:${branchId}`;
  const serialized = JSON.stringify(payload);
  let fingerprint = serialized;
  try {
    const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
    fingerprint = Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    // The random key remains reusable for this page session if WebCrypto is unavailable.
  }
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(storageKey) ?? 'null') as { fingerprint?: string; key?: string } | null;
    if (stored?.key && stored.fingerprint === fingerprint) return stored.key;
  } catch {
    // Ignore corrupted session data and replace it with a fresh key.
  }
  const key = window.crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
  return key;
}

export default function StorefrontCheckoutClient({
  restaurantSlug,
}: {
  restaurantSlug: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const branchIdParam = searchParams.get('branchId') || '';
  const initialType = (searchParams.get('type') || 'PICKUP').toUpperCase() as 'PICKUP' | 'DELIVERY';
  const initialPin = searchParams.get('pin') || '';

  const [context, setContext] = useState<PublicStorefrontContext | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fulfillment Selection
  const [fulfillmentType, setFulfillmentType] = useState<'PICKUP' | 'DELIVERY'>(initialType);

  // Customer Contact
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [customerNote, setCustomerNote] = useState('');

  // Delivery Address
  const [house, setHouse] = useState('');
  const [street, setStreet] = useState('');
  const [landmark, setLandmark] = useState('');
  const [area, setArea] = useState('');
  const [pinCode, setPinCode] = useState(initialPin);
  const [deliveryInstructions, setDeliveryInstructions] = useState('');

  // Scheduling
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledTime, setScheduledTime] = useState('');

  // Coupon & Payment
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'UPI'>('CASH');

  // Server-side calculation preview
  const [preview, setPreview] = useState<PublicFulfillmentCheckoutPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const cashPaymentAllowed = fulfillmentType === 'PICKUP' || context?.delivery_settings?.cod_enabled === true;
  const upiPaymentAllowed = fulfillmentType === 'PICKUP' || context?.delivery_settings?.upi_on_delivery_enabled === true;

  useEffect(() => {
    if (paymentMethod === 'CASH' && cashPaymentAllowed) return;
    if (paymentMethod === 'UPI' && upiPaymentAllowed) return;
    if (cashPaymentAllowed) setPaymentMethod('CASH');
    else if (upiPaymentAllowed) setPaymentMethod('UPI');
  }, [fulfillmentType, context?.delivery_settings?.cod_enabled, context?.delivery_settings?.upi_on_delivery_enabled, cashPaymentAllowed, upiPaymentAllowed, paymentMethod]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    getPublicStorefrontContext(restaurantSlug, branchIdParam || undefined)
      .then((ctx) => {
        if (cancelled) return;
        setContext(ctx);
        const storedCart = readFulfillmentCart(ctx.branch_id);
        setCart(storedCart);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load checkout context.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [restaurantSlug, branchIdParam]);

  // Recalculate Checkout whenever cart, fulfillment type, pin code or coupon changes
  useEffect(() => {
    if (!context?.branch_id || cart.length === 0) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    setPreviewLoading(true);

    previewPublicFulfillmentCheckout({
      branchId: context.branch_id,
      fulfillmentType,
      items: cart,
      deliveryPinCode: fulfillmentType === 'DELIVERY' ? pinCode : undefined,
      couponCode: appliedCoupon || null,
      customerPhone: phone || undefined,
    })
      .then((res) => {
        if (!cancelled) {
          setPreview(res);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPreview(null);
          setError(err instanceof Error ? err.message : 'Could not calculate checkout totals.');
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [context?.branch_id, cart, fulfillmentType, pinCode, appliedCoupon, phone]);

  async function handleApplyCoupon(e: React.FormEvent) {
    e.preventDefault();
    if (!couponCode.trim()) return;
    setAppliedCoupon(couponCode.trim().toUpperCase());
  }

  function handleRemoveCoupon() {
    setCouponCode('');
    setAppliedCoupon('');
  }

  async function handlePlaceOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!context?.branch_id) return;
    if (cart.length === 0) {
      setError('Your cart is empty.');
      return;
    }
    if (!name.trim()) {
      setError('Please provide your full name.');
      return;
    }
    if (!phone.trim() || phone.trim().length !== 10) {
      setError('Please provide a valid 10-digit mobile number.');
      return;
    }
    if (fulfillmentType === 'DELIVERY' && !cashPaymentAllowed && !upiPaymentAllowed) {
      setError('This branch has not enabled cash or UPI collection on delivery. Contact the restaurant or choose Pickup.');
      return;
    }
    if ((paymentMethod === 'CASH' && !cashPaymentAllowed) || (paymentMethod === 'UPI' && !upiPaymentAllowed)) {
      setError('The selected payment method is not enabled for this fulfillment type.');
      return;
    }
    if (fulfillmentType === 'DELIVERY') {
      if (!house.trim() || !street.trim() || !pinCode.trim()) {
        setError('Complete delivery address (house/street/PIN code) is required.');
        return;
      }
      if (preview && !preview.is_serviceable) {
        setError(preview.serviceability_message || 'Address outside delivery radius.');
        return;
      }
    }

    setSubmitting(true);
    setError(null);

    try {
      const addressPayload =
        fulfillmentType === 'DELIVERY'
          ? {
              house: house.trim(),
              street: street.trim(),
              landmark: landmark.trim(),
              area: area.trim(),
              pin_code: pinCode.trim(),
            }
          : undefined;

      const resolvedPaymentMethod = paymentMethod === 'UPI' ? `${fulfillmentType}_UPI` : `${fulfillmentType}_CASH`;
      const checkoutPayload = {
        branchId: context.branch_id,
        fulfillmentType,
        items: cart,
        paymentMethod: resolvedPaymentMethod,
        customerName: name.trim(),
        customerPhone: phone.trim(),
        customerEmail: email.trim() || undefined,
        customerAddress: addressPayload,
        deliveryPinCode: fulfillmentType === 'DELIVERY' ? pinCode.trim() : undefined,
        deliveryInstructions: deliveryInstructions.trim() || undefined,
        scheduledFor: isScheduled && scheduledTime ? new Date(scheduledTime).toISOString() : null,
        couponCode: appliedCoupon || null,
        customerNote: customerNote.trim() || undefined,
      };
      const idempotencyKey = await getFulfillmentCheckoutIdempotencyKey(context.branch_id, checkoutPayload);
      const orderResult = await createPublicFulfillmentOrder({
        branchId: context.branch_id,
        fulfillmentType,
        items: cart,
        paymentMethod: resolvedPaymentMethod,
        idempotencyKey,
        customerName: name.trim(),
        customerPhone: phone.trim(),
        customerEmail: email.trim() || undefined,
        customerAddress: addressPayload,
        deliveryPinCode: fulfillmentType === 'DELIVERY' ? pinCode.trim() : undefined,
        deliveryInstructions: deliveryInstructions.trim() || undefined,
        scheduledFor: isScheduled && scheduledTime ? new Date(scheduledTime).toISOString() : null,
        couponCode: appliedCoupon || null,
        customerNote: customerNote.trim() || undefined,
      });

      const handoffCode = fulfillmentType === 'PICKUP' ? orderResult.pickup_code : orderResult.delivery_otp;
      if (handoffCode) {
        window.sessionStorage.setItem(
          `tablely:fulfillment:handoff:${orderResult.tracking_token}`,
          JSON.stringify(fulfillmentType === 'PICKUP' ? { pickup_code: handoffCode } : { delivery_otp: handoffCode }),
        );
      }
      window.sessionStorage.removeItem(`tablely:fulfillment:checkout-key:${context.branch_id}`);

      // Clear local cart
      clearFulfillmentCart(context.branch_id);

      // Redirect directly to the tracking page
      router.push(`/r/${encodeURIComponent(restaurantSlug)}/order/track/${encodeURIComponent(orderResult.tracking_token)}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not place order.');
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="storefront-loading">
        <div className="storefront-spinner" />
        <p>Loading checkout…</p>
      </div>
    );
  }

  if (!context) {
    return (
      <div className="storefront-error">
        <AlertCircle size={32} />
        <h2>Storefront Error</h2>
        <p>{error || 'Could not load ordering context.'}</p>
      </div>
    );
  }

  return (
    <div className="checkout-container">
      {/* Top Header */}
      <header className="checkout-header">
        <Link href={`/r/${encodeURIComponent(restaurantSlug)}/order`} className="back-link">
          <ArrowLeft size={18} /> Menu
        </Link>
        <div className="checkout-title">
          <h1>Complete Your Order</h1>
          <p>{context.restaurant_name} · {context.branch_name}</p>
        </div>
      </header>

      {error && (
        <div className="checkout-error-banner" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {cart.length === 0 ? (
        <div className="empty-cart-view">
          <h2>Your cart is empty</h2>
          <p>Please browse the menu and add dishes before checking out.</p>
          <Link href={`/r/${encodeURIComponent(restaurantSlug)}/order`} className="button button-primary">
            Explore Menu
          </Link>
        </div>
      ) : (
        <form onSubmit={handlePlaceOrder} className="checkout-form-grid">
          {/* Left Column: Details & Address */}
          <div className="checkout-left">
            {/* Fulfillment Selector */}
            <section className="checkout-card">
              <span className="card-kicker">STEP 1</span>
              <h2>How would you like to receive your food?</h2>

              <div className="fulfillment-options">
                {context.pickup_enabled && (
                  <button
                    type="button"
                    className={`fulfillment-choice ${fulfillmentType === 'PICKUP' ? 'selected' : ''}`}
                    onClick={() => setFulfillmentType('PICKUP')}
                  >
                    <Store size={20} />
                    <strong>Self Pickup</strong>
                    <small>Collect at counter</small>
                  </button>
                )}

                {context.delivery_enabled && (
                  <button
                    type="button"
                    className={`fulfillment-choice ${fulfillmentType === 'DELIVERY' ? 'selected' : ''}`}
                    onClick={() => setFulfillmentType('DELIVERY')}
                  >
                    <Bike size={20} />
                    <strong>Home Delivery</strong>
                    <small>Delivered by restaurant</small>
                  </button>
                )}
              </div>
            </section>

            {/* Customer Contact Details */}
            <section className="checkout-card">
              <span className="card-kicker">STEP 2</span>
              <h2>Contact Details</h2>

              <div className="form-fields">
                <label>
                  Full Name *
                  <input
                    type="text"
                    required
                    maxLength={100}
                    placeholder="Enter your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>

                <label>
                  Mobile Number (10 digits) *
                  <input
                    type="tel"
                    required
                    maxLength={10}
                    placeholder="e.g. 9876543210"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
                  />
                </label>

                <label>
                  Email Address <span className="muted">(Optional for order receipt)</span>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
              </div>
            </section>

            {/* Delivery Address (if Delivery) */}
            {fulfillmentType === 'DELIVERY' && (
              <section className="checkout-card">
                <span className="card-kicker">STEP 3</span>
                <h2>Delivery Address</h2>

                <div className="form-fields">
                  <div className="fields-row">
                    <label>
                      Flat / House / Floor *
                      <input
                        type="text"
                        required
                        placeholder="e.g. Flat 4B, Silver Oak"
                        value={house}
                        onChange={(e) => setHouse(e.target.value)}
                      />
                    </label>

                    <label>
                      PIN Code (6 digits) *
                      <input
                        type="text"
                        required
                        maxLength={6}
                        placeholder="e.g. 700120"
                        value={pinCode}
                        onChange={(e) => setPinCode(e.target.value.replace(/\D/g, ''))}
                      />
                    </label>
                  </div>

                  <label>
                    Street / Building / Area *
                    <input
                      type="text"
                      required
                      placeholder="e.g. 12 MG Road, Barrackpore"
                      value={street}
                      onChange={(e) => setStreet(e.target.value)}
                    />
                  </label>

                  <div className="fields-row">
                    <label>
                      Landmark <span className="muted">(Optional)</span>
                      <input
                        type="text"
                        placeholder="e.g. Near City Bank"
                        value={landmark}
                        onChange={(e) => setLandmark(e.target.value)}
                      />
                    </label>

                    <label>
                      Locality / Area
                      <input
                        type="text"
                        placeholder="e.g. Riverside Colony"
                        value={area}
                        onChange={(e) => setArea(e.target.value)}
                      />
                    </label>
                  </div>

                  <label>
                    Delivery Instructions
                    <input
                      type="text"
                      placeholder="e.g. Leave at security, call upon arrival"
                      value={deliveryInstructions}
                      onChange={(e) => setDeliveryInstructions(e.target.value)}
                    />
                  </label>
                </div>
              </section>
            )}

            {/* Timing / Scheduling */}
            <section className="checkout-card">
              <span className="card-kicker">STEP 4</span>
              <h2>Timing & Notes</h2>

              <div className="timing-toggle">
                <label className="radio-label">
                  <input
                    type="radio"
                    name="timing"
                    checked={!isScheduled}
                    onChange={() => setIsScheduled(false)}
                  />
                  <span>
                    <strong>ASAP</strong> ({fulfillmentType === 'PICKUP' ? `Ready in ~${context.default_prep_minutes} mins` : 'Delivery in ~30-45 mins'})
                  </span>
                </label>

                <label className="radio-label">
                  <input
                    type="radio"
                    name="timing"
                    checked={isScheduled}
                    onChange={() => setIsScheduled(true)}
                  />
                  <span>Schedule for later</span>
                </label>
              </div>

              {isScheduled && (
                <div style={{ marginTop: 12 }}>
                  <label>
                    Preferred Time
                    <input
                      type="datetime-local"
                      required={isScheduled}
                      value={scheduledTime}
                      onChange={(e) => setScheduledTime(e.target.value)}
                    />
                  </label>
                </div>
              )}

              <label style={{ marginTop: 16 }}>
                Cooking / Kitchen Note
                <input
                  type="text"
                  placeholder="e.g. Less spicy, extra cutlery requested"
                  value={customerNote}
                  onChange={(e) => setCustomerNote(e.target.value)}
                />
              </label>
            </section>

            {/* Payment Method */}
            <section className="checkout-card">
              <span className="card-kicker">STEP 5</span>
              <h2>Payment Method</h2>

              <div className="payment-options">
                {cashPaymentAllowed ? (
                  <label className="payment-card-label">
                    <input type="radio" name="payment" value="CASH" checked={paymentMethod === 'CASH'} onChange={() => setPaymentMethod('CASH')} />
                    <Banknote size={20} />
                    <div>
                      <strong>{fulfillmentType === 'PICKUP' ? 'Cash at Counter' : 'Cash on Delivery (COD)'}</strong>
                      <small>Pay with cash upon receipt</small>
                    </div>
                  </label>
                ) : null}
                {upiPaymentAllowed ? (
                  <label className="payment-card-label">
                    <input type="radio" name="payment" value="UPI" checked={paymentMethod === 'UPI'} onChange={() => setPaymentMethod('UPI')} />
                    <Smartphone size={20} />
                    <div>
                      <strong>{fulfillmentType === 'PICKUP' ? 'UPI at Counter' : 'UPI on Delivery'}</strong>
                      <small>GPay, PhonePe, Paytm upon collection</small>
                    </div>
                  </label>
                ) : null}
                {!cashPaymentAllowed && !upiPaymentAllowed ? (
                  <div className="checkout-inline-warning" role="alert">The restaurant has not enabled any payment-on-delivery method yet. Choose Pickup or contact the restaurant.</div>
                ) : null}
              </div>
            </section>
          </div>

          {/* Right Column: Order Summary & Calculation */}
          <div className="checkout-right">
            <section className="checkout-card summary-card">
              <h2>Order Summary</h2>

              {/* Items List */}
              <div className="summary-items">
                {cart.map((item, idx) => (
                  <div className="summary-item-row" key={`${item.menuItemId}-${idx}`}>
                    <div className="item-qty-name">
                      <span className="qty-badge">{item.quantity}×</span>
                      <div>
                        <strong>{item.name}</strong>
                        {item.variant && <small> · {item.variant.name}</small>}
                        {item.addons && item.addons.length > 0 && (
                          <small> · {item.addons.map((a) => a.name).join(', ')}</small>
                        )}
                      </div>
                    </div>
                    <span className="item-price">{formatMoney(item.price * item.quantity)}</span>
                  </div>
                ))}
              </div>

              {/* Coupon Box */}
              <div className="coupon-box">
                {appliedCoupon ? (
                  <div className="applied-coupon-row">
                    <div>
                      <Tag size={16} />
                      <strong>{appliedCoupon}</strong>
                      <small>Applied</small>
                    </div>
                    <button type="button" onClick={handleRemoveCoupon} className="remove-coupon-btn">
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="coupon-input-row">
                    <input
                      type="text"
                      placeholder="Promo code"
                      value={couponCode}
                      onChange={(e) => setCouponCode(e.target.value)}
                    />
                    <button type="button" onClick={handleApplyCoupon} className="apply-coupon-btn">
                      Apply
                    </button>
                  </div>
                )}
              </div>

              {/* Financial Calculation Breakdown */}
              {preview ? (
                <div className="calculation-breakdown">
                  <div className="calc-row">
                    <span>Subtotal</span>
                    <span>{formatMoney(preview.subtotal)}</span>
                  </div>

                  {preview.discount > 0 && (
                    <div className="calc-row discount-row">
                      <span>Discount ({preview.coupon_code || 'Promo'})</span>
                      <span>−{formatMoney(preview.discount)}</span>
                    </div>
                  )}

                  {preview.packaging_fee > 0 && (
                    <div className="calc-row">
                      <span>Packaging Fee</span>
                      <span>{formatMoney(preview.packaging_fee)}</span>
                    </div>
                  )}

                  {preview.delivery_fee > 0 && (
                    <div className="calc-row">
                      <span>Delivery Fee ({preview.delivery_zone_name || 'Zone'})</span>
                      <span>{formatMoney(preview.delivery_fee)}</span>
                    </div>
                  )}

                  {preview.tax > 0 && (
                    <div className="calc-row">
                      <span>Taxes & GST</span>
                      <span>{formatMoney(preview.tax)}</span>
                    </div>
                  )}

                  {preview.additional_charges > 0 && (
                    <div className="calc-row">
                      <span>Restaurant Charges</span>
                      <span>{formatMoney(preview.additional_charges)}</span>
                    </div>
                  )}

                  <div className="calc-total-row">
                    <strong>Total Payable</strong>
                    <strong>{formatMoney(preview.total)}</strong>
                  </div>

                  {!preview.is_serviceable && (
                    <div className="service-warning">
                      <AlertCircle size={16} />
                      <span>{preview.serviceability_message}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="calculating-placeholder">
                  {previewLoading ? 'Calculating verified totals…' : 'Totals will update automatically'}
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                className="place-order-btn"
                disabled={submitting || (preview !== null && !preview.is_serviceable)}
              >
                {submitting ? 'Placing Order…' : `Place Order · ${formatMoney(preview?.total ?? 0)}`}
              </button>

              <p className="order-disclaimer">
                By placing this order, you agree to restaurant terms and fulfillment policies.
              </p>
            </section>
          </div>
        </form>
      )}
    </div>
  );
}
