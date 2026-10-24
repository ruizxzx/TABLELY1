# Build 29 implementation report

## Delivered in this source package

- Reconciliation dashboard with branch permission checks, server-side SQL aggregation and paging, filters, CSV export, mismatch flags, audit notes, and verified Razorpay lookup through the existing finalizer.
- Additive SQL foundation for equal/custom split allocations and idempotent partial counter collection, recording every collected amount in `payment_transactions`.
- Customer receipt projection that displays payment transactions, collection/outstanding amounts, restaurant branding and a print/save-PDF action.
- Authenticated customer history search/pagination and reorder checks against current item availability, variants, modifiers, add-ons and prices.
- Focused split arithmetic tests and Build 29 contract tests.

## Verification status

- `npm run typecheck`: passed.
- `npm run build`: passed; includes production compilation, type validation, and static page generation.
- Build 29 tests: passed (6 tests: paise conversion/equal allocation, migration/security contracts, receipt route authorization).
- `npm test`: 45 passed, 1 failed. The failing pre-existing migration integrity test rejects the historical filename `20260922240000_repair_approved_product_visibility.sql` because its encoded time is invalid. Other historical duplicate migration versions are also present.
- `npm run check:migrations`: fails on those historical duplicate versions and invalid filenames; Build 29 uses the unique valid version `20261024010000` and did not rename applied history.
- `npm run lint`: blocked before linting by the repository's existing ESLint/FlatCompat circular-configuration error. A temporary check with Next's documented flat config found no errors in the changed Build 29 files (four warnings) but exposed hundreds of legacy lint errors elsewhere, so the repository lint configuration was restored unchanged.
- Local Supabase database status/lint: unavailable because Docker/Podman is not installed. No remote database lint or migration was run.

## Not a complete Build 29 acceptance

This package is a staging implementation, not a complete or production-ready fulfillment of the master prompt. Item-based split allocation, online split checkout, immutable receipt snapshots/email, provider refund and settlement-feed reconciliation, gateway orphan discovery, and database-backed integration/concurrency tests remain outstanding. Apply the migration only to a disposable local database or staging, then complete these flows and review the resulting SQL/RLS behavior before production.
