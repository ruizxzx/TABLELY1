# Tablely Security Review Checklist

Before pilot, execute these checks in staging/production-like data:

- Tenant A cannot read or mutate Tenant B.
- Branch A cannot read Branch B unless the user is explicitly assigned to both.
- Kitchen users cannot access payment administration.
- Waiters cannot manage staff or subscriptions.
- Anonymous users can only use public QR/menu/order capabilities.
- Customer cancellation requires the matching opaque tracking token.
- Order transition RPC rejects invalid state jumps server-side.
- Payment state can only become PAID after verified server processing or authorized manual payment RPC.
- Razorpay secrets never appear in browser payloads or logs.
- Duplicate order submissions return the same idempotent result.
- Duplicate payment/webhook events do not create additional payment records.
- Realtime reconnect does not duplicate records.
- Invalid/deleted/disabled QR routes fail with safe user-facing screens.

## Build 27 source changes (not yet applied remotely)

- `payment_transactions` is now protected by RLS and direct `anon`/`authenticated` table privileges are revoked in `202610240001_build27_stability_foundation.sql`. Application write access is intended to remain through server-role operations and controlled SECURITY DEFINER functions; confirm this in a disposable Supabase database before deployment.
- New dashboard summary RPC checks the existing per-branch `ANALYTICS` permission instead of trusting the dashboard UI.
- New online payment finalization RPC locks the legacy order and validates tracking token (when supplied), Razorpay order ID, INR currency, exact paise amount, payment method and allowed order/payment state before writing the payment ledger and marking paid.
- New order-creation lease RPCs serialize concurrent Razorpay order creation for both payment-attempt and legacy order-first flows.
- The SQL catalog verification queries are in `supabase/verification/build27_catalog_checks.sql`.

Still required before pilot: execute the complete tenant/branch/RLS and payment/webhook regression matrix in a staging Supabase project with isolated test tenants and Razorpay test credentials. This repository-only task did not access a live database or payment account.

For Build 27, run `supabase/verification/build27_catalog_checks.sql` against a disposable/staging Supabase database after migration. It checks the new financial table's direct browser-role privileges, new RPC grants and provides catalog inventories for the wider RLS/SECURITY DEFINER review. The dynamic tenant-isolation cases remain in `_qa/BUILD27_REGRESSION_TEST_MATRIX.md` and require two or more real test tenants.


## Build 27 verification status

- Repository-level migration timestamp collisions are resolved through idempotent reconciliation migrations `202610240002` and `202610240003`; the remote migration ledger still needs inspection.
- Run `supabase/verification/build27_catalog_checks.sql` and `supabase/verification/build27_dashboard_metrics_smoke.sql` in staging before production.
- Razorpay sandbox, cross-tenant RLS, browser concurrency, full typecheck, lint and production build have not been verified in this environment.
