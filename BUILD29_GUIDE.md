# TABLELY Build 29 — Payment & Billing Intelligence

Build 29 adds branch-scoped payment investigation, paise-based equal/custom splits for counter collection, enriched customer receipts, and paginated authenticated order history with current-menu reorder checks.

## Data and authorization

- `orders` and `payment_transactions` remain the food-payment source of truth. No parallel transaction ledger was added.
- The reconciliation dashboard is calculated in PostgreSQL and paged server-side. It reports order/ledger inconsistencies as investigation issues; it does not silently repair them.
- `payment_reconciliation_notes` records notes, review markers and escalations with the authenticated actor and branch. `add_payment_reconciliation_note` checks branch `PAYMENTS` permission.
- `order_split_bills` and `order_split_participants` hold allocation state only. Each counter collection is a `payment_transactions` row. The order remains pending until all shares are collected. Split configuration checks the locked order total in integer paise; counter collection locks the participant, split and order and has a unique idempotency key.
- Customer history and receipt RPCs require the signed-in customer profile to own the order. Reordering rebuilds selections from the current menu and sends the customer to the cart to review current prices before checkout.
- Razorpay credentials stay server-side. The reconciliation action reads a stored provider payment reference, checks the provider order, amount, currency and captured status, then uses the existing protected finalizer. It does not create or refund payments.
- Subscription billing is unchanged and separate.

## Migration

Apply `supabase/migrations/20261024010000_build29_payment_reconciliation_split_foundation.sql` to a disposable local database or staging database after reviewing it. Do not apply it directly to production. It adds split allocation and reconciliation-note tables plus RPCs for dashboard queries, split configuration, counter collection, customer history pagination and receipt projection.

The migration is additive and depends on the existing Build 13 payment schema, Build 17 order events, Build 22 customer profile ownership, and Build 27 Razorpay finalizer. The live database was not changed during this implementation.

## UI

- Restaurant staff with payment access can open **Payments → Reconciliation** for date filters, payment-method/status filters, search, CSV export, gateway verification and investigation notes.
- **Split bills** is available in the restaurant navigation. Equal splits distribute leftover paise deterministically; custom shares must add up exactly to the order total. Counter collections support partial amounts by cash, UPI or card.
- Customers can search and page through their own order history, view/print a receipt, and rebuild an order from currently available menu options. The cart is shown before checkout and old coupons/payment references are not reused.

## Verification

Run `npm test`, `npm run typecheck`, `npm run check:migrations`, `npm run lint`, and `npm run build`. Reconciliation, split and receipt UI require the migration to be applied to the selected database. Database RLS and transaction behavior must be exercised against local PostgreSQL or staging before release.

## Known limitations in this delivery

- Split billing currently supports equal and custom monetary allocations. Item-quantity allocation, online participant checkout and Pay Later participant settlement are not included.
- Receipt output is a live read-only projection from historical order and transaction rows, with browser print/save-to-PDF. Immutable receipt snapshot storage, emailed receipts and formal refund adjustment documents are not included.
- Reconciliation derives issues from TABLELY's current order and transaction tables and can verify stored Razorpay payment references. It does not import the Razorpay settlement/bank-settlement feed, discover orphan gateway payments, or fetch gateway refunds. It cannot retry an attempt with no stored payment reference.
- No live Supabase migration, Razorpay live payment, production deployment, or production readiness claim was performed.
