import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261024010000_build29_payment_reconciliation_split_foundation.sql', import.meta.url), 'utf8');
const reconciliationApi = await readFile(new URL('../app/api/reconciliation/route.ts', import.meta.url), 'utf8');
const splitApi = await readFile(new URL('../app/api/split-bills/route.ts', import.meta.url), 'utf8');
const receiptRoute = await readFile(new URL('../app/api/customer/orders/[orderId]/receipt/route.ts', import.meta.url), 'utf8');

test('Build 29 migration extends existing order/payment ledger and guards split settlement', () => {
  assert.match(migration, /public\.payment_transactions/);
  assert.match(migration, /for update/);
  assert.match(migration, /Split allocations must equal the current order total in paise/);
  assert.match(migration, /Payment exceeds this participant allocation/);
  assert.match(migration, /payment_transactions_split_idempotency_uidx/);
  assert.match(migration, /current_user_has_permission_for_branch/);
  assert.match(migration, /enable row level security/i);
});

test('reconciliation read, gateway verification and split actions stay server authorized', () => {
  assert.match(reconciliationApi, /permission: 'PAYMENTS'/);
  assert.match(reconciliationApi, /fetchRazorpayPayment/);
  assert.match(reconciliationApi, /matchesRazorpayPayment/);
  assert.match(reconciliationApi, /finalize_legacy_razorpay_order/);
  assert.match(splitApi, /configure_order_split/);
  assert.match(splitApi, /collect_split_counter_payment/);
});

test('receipt route uses customer-scoped receipt projection', () => {
  assert.match(receiptRoute, /get_my_customer_receipt_v29/);
  assert.match(receiptRoute, /auth\.getUser/);
});
