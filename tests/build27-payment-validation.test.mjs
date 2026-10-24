import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRazorpayPaymentCaptured,
  matchesRazorpayPayment,
  toRazorpayPaise,
} from '../lib/payment-validation.mjs';

test('converts valid INR amounts to integer paise', () => {
  assert.equal(toRazorpayPaise(100), 10000);
  assert.equal(toRazorpayPaise('12.34'), 1234);
  assert.equal(toRazorpayPaise(0.01), 1);
  assert.equal(toRazorpayPaise(0.1 + 0.2), 30);
});

test('rejects invalid or unsafe payment amounts', () => {
  for (const amount of [0, -1, NaN, Infinity, -Infinity, 'not-money', '', '   ', null, undefined, true, false, Number.MAX_SAFE_INTEGER]) {
    assert.equal(toRazorpayPaise(amount), null, `expected ${String(amount)} to be rejected`);
  }
});

test('matches a payment only when order, paise amount and currency agree', () => {
  const payment = { id: 'pay_12345', order_id: 'order_12345', amount: 12345, currency: 'INR', status: 'captured' };
  assert.equal(matchesRazorpayPayment(payment, { orderId: 'order_12345', paymentId: 'pay_12345', amountInPaise: 12345, currency: 'INR' }), true);
  assert.equal(matchesRazorpayPayment(payment, { orderId: 'order_other', paymentId: 'pay_12345', amountInPaise: 12345, currency: 'INR' }), false);
  assert.equal(matchesRazorpayPayment(payment, { orderId: 'order_12345', paymentId: 'pay_12345', amountInPaise: 12344, currency: 'INR' }), false);
  assert.equal(matchesRazorpayPayment(payment, { orderId: 'order_12345', paymentId: 'pay_other', amountInPaise: 12345, currency: 'INR' }), false);
  assert.equal(matchesRazorpayPayment({ ...payment, currency: 'USD' }, { orderId: 'order_12345', paymentId: 'pay_12345', amountInPaise: 12345, currency: 'INR' }), false);
  assert.equal(matchesRazorpayPayment({ ...payment, amount: 1.2 }, { orderId: 'order_12345', paymentId: 'pay_12345', amountInPaise: 1.2, currency: 'INR' }), false);
  assert.equal(matchesRazorpayPayment(null, { orderId: 'order_12345', paymentId: 'pay_12345', amountInPaise: 12345, currency: 'INR' }), false);
  assert.equal(matchesRazorpayPayment(payment, { orderId: 'order_12345', paymentId: 'pay_12345', amountInPaise: Number.MAX_SAFE_INTEGER + 1, currency: 'INR' }), false);
  assert.equal(matchesRazorpayPayment(payment, { orderId: '', paymentId: 'pay_12345', amountInPaise: 12345, currency: 'INR' }), false);
});

test('requires the authoritative captured payment status', () => {
  assert.equal(isRazorpayPaymentCaptured({ status: 'captured' }), true);
  assert.equal(isRazorpayPaymentCaptured({ status: 'authorized', captured: true }), false);
  assert.equal(isRazorpayPaymentCaptured({ status: 'failed', captured: false }), false);
  assert.equal(isRazorpayPaymentCaptured(null), false);
});
