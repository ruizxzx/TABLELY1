/** Convert a major-currency amount to integer paise without floating-point leakage. */
export function toRazorpayPaise(amount) {
  if (typeof amount !== 'number' && typeof amount !== 'string') return null;
  if (typeof amount === 'string' && amount.trim() === '') return null;

  const value = typeof amount === 'number' ? amount : Number(amount.trim());
  if (!Number.isFinite(value) || value <= 0) return null;

  const paise = Math.round((value + Number.EPSILON) * 100);
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

/** Validate the signed/fetched Razorpay payment entity against our server-side expectation. */
export function matchesRazorpayPayment(payment, expected) {
  if (!payment || typeof payment !== 'object' || !expected || typeof expected !== 'object') return false;
  if (typeof expected.orderId !== 'string' || expected.orderId.trim() === '') return false;
  if (!Number.isSafeInteger(expected.amountInPaise) || expected.amountInPaise <= 0) return false;

  const amount = Number(payment.amount);
  return String(payment.order_id ?? '') === expected.orderId
    && (!expected.paymentId || String(payment.id ?? '') === expected.paymentId)
    && Number.isSafeInteger(amount)
    && amount === expected.amountInPaise
    && String(payment.currency ?? '').toUpperCase() === String(expected.currency ?? 'INR').toUpperCase();
}

export function isRazorpayPaymentCaptured(payment) {
  return String(payment?.status ?? '').toUpperCase() === 'CAPTURED';
}
