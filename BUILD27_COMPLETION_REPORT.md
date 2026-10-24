# TABLELY Build 27 — Completion and Verification Report

**Repository baseline:** `TABLELY1-main (1)(2).zip`
**Build:** 27 — Stability & Technical Foundation
**Source implementation date:** 2026-10-24 (final code-level pass)
**Remote deployment:** Not performed
**Remote database migration:** Not performed
**Original uploaded archive:** Preserved unchanged

## Executive summary

Build 27's repository-level implementation is in place across the six planned sub-builds. The changes correct the dashboard's bounded-order sales calculation, add server-side payment validation and atomic legacy settlement, serialize concurrent Razorpay order creation for both payment-attempt and legacy flows, rate-limit payment verification, protect the payment transaction table from direct browser-role access, and add unit tests, QA matrices and current-state documentation.

This is **not a claim of production verification**. The archive contains no live Supabase state or provider credentials. The new SQL migrations have not been applied to any database. Dependency installation timed out in this environment, so the Next.js typecheck, lint and production build could not be executed. Browser, RLS, database and Razorpay sandbox test cases remain marked blocked/not run in `_qa/BUILD27_REGRESSION_TEST_MATRIX.md`.

## A. Sub-build status

### 27.1 — Dashboard sales calculation correction

**Source implementation: Completed**

- Replaced the dashboard's client-side sales sum over the latest 50 orders with the `get_branch_dashboard_metrics` server-side summary.
- The last-50 order query now serves only as a recent activity preview.
- Financial totals use the `payment_transactions` ledger when present, with a compatibility fallback for historical paid/refunded orders that have no transaction rows.
- Exposes gross collected, refunds, net collected, outstanding, total/paid/unpaid/active/cancelled/rejected order counts.
- A legacy order marked `PAID` or `REFUNDED` uses the order total as a compatibility fallback when the ledger has no successful/refund amount, including when failed historical attempt rows exist. This avoids understated collections or negative net values caused by a failed-only transaction row.
- Business date is calculated using the branch timezone and `orders.order_business_date`.
- Recent activity preview uses the returned branch-local business date.
- RPC checks the existing branch-specific `ANALYTICS` permission.

**Still requires:** database-backed tests for ledger semantics, refunds, split/partial payments, branches and timezones.

### 27.2 — Database migration consistency

**Repository collision resolution: Completed; remote ledger validation: Blocked**

- Added `supabase/migrations/202610240001_build27_stability_foundation.sql` after the existing history.
- Kept `202609180031_fix_cross_restaurant_checkout_charges.sql` at its historical version.
- Moved the idempotent global brand settings migration to `202610240002_global_brand_logo_reconciliation.sql`.
- Added `202610240003_fix_cross_restaurant_checkout_charges_reconciliation.sql`, an idempotent replay of the historical checkout-charge function patch. This ensures the patch is applied even if the remote ledger's single `202609180031` row originally represented the global-brand migration rather than the checkout-charge migration.
- Added a migration-version preflight script and automated test. All 131 numeric migration versions are now unique in the repository, including legacy short numeric versions.

**Deployment gate:** inspect the target project's `supabase_migrations.schema_migrations` table before deployment. The new global-brand migration is deliberately idempotent; the checkout-charge reconciliation replay only rewrites a function when its old vulnerable predicate is still present. Validate all three new migrations on a disposable/staging database before production.

### 27.3 — Razorpay security and reliability

**Source implementation: Completed; provider/database verification: Blocked**

- Added safe INR-to-paise conversion and exact payment order ID, payment ID, amount and currency matching helpers.
- Checkout verification fetches the payment state and only finalizes a `CAPTURED` payment.
- Webhook signature validation continues to use the raw request body.
- Failure webhook snapshots are re-fetched from Razorpay before applying failure transitions, reducing stale-event state regression risk.
- Payment-attempt finalization continues through the existing idempotent `finalize_payment_attempt_v18` RPC.
- Legacy order-first settlement now goes through `finalize_legacy_razorpay_order`, which locks the order, checks the tracking token when present, provider order ID, INR currency, exact amount in paise, payment method and eligible state, then writes the payment transaction and marks the order paid atomically.
- Errors from payment ledger/finalization RPCs are no longer silently ignored.
- Restaurant food payments and TABLELY subscription billing remain separate.

### 27.4 — Checkout idempotency and multi-session regression

**Source implementation: Completed; browser/database regression execution: Not run**

- Added a 90-second database lease around Razorpay provider-order creation for both payment attempts and legacy order-first orders.
- A duplicate request receives an already-saved provider order or a retryable conflict instead of immediately creating another provider order.
- Each lease has a UUID fencing token; an expired request cannot overwrite or release a newer request's claim.
- Failed creation releases its own lease when possible; stale leases can be reclaimed.
- The current tab-specific `window.name` visit-context implementation in `lib/customer.ts` was inspected and preserved. It does not use cloned `sessionStorage` as the identity source.
- A browser verification callback arriving after the webhook finalized the payment returns the already-created order when the attempt token and stored provider order/payment IDs match.
- Added test scenarios for same-visit retry, duplicated tabs, independent customers at one table, and customer handoff.

**Still requires:** real browser and database concurrency tests. A lease reduces duplicate external order creation; it cannot guarantee zero orphaned provider orders if a provider request exceeds the lease window or the database becomes unavailable after the provider creates its order.

### 27.5 — RLS, permissions and automated test foundation

**Source implementation: Partial; runtime authorization verification: Blocked**

- Enabled RLS on `payment_transactions` and revoked direct table privileges from `anon` and `authenticated`; `service_role` remains the intended server-side access role.
- New SECURITY DEFINER RPCs use explicit `search_path` and are granted only to the required roles.
- Dashboard metrics use the existing `ANALYTICS` branch permission helper.
- Added Node's built-in test runner, payment-validation unit tests, migration integrity checks, a migration-version preflight command and staging smoke-test SQL.
- Added `supabase/verification/build27_catalog_checks.sql` to inspect role grants, RLS flags, policy catalog and security-definer function settings.

**Still requires:** run catalog checks and cross-tenant/branch RLS tests in staging with at least two test organizations and multiple staff roles. The catalog and dashboard smoke scripts are provided but have not been executed here.

### 27.6 — Documentation and build completion record

**Source implementation: Completed**

- Updated README baseline notice.
- Added the Build 27 source-state section to `TABLELY_CURRENT_STATE_MASTER_CONTEXT.md`.
- Updated `SECURITY_AUDIT.md` with Build 27 controls and remaining checks.
- Added `_qa/BUILD27_REGRESSION_TEST_MATRIX.md`.
- Added this completion report.

## B. Modified and added files

### Application and library code

- `app/dashboard/page.tsx`
- `app/api/payments/create/route.ts` (ensures existing provider orders are returned only through the locked claim RPC)
- `app/api/payments/verify/route.ts` (adds verification endpoint rate limiting)
- `app/api/payments/webhook/route.ts`
- `lib/payment-validation.mjs` (new)
- `lib/payment-validation.d.mts` (new)

### Database

- `supabase/migrations/202610240001_build27_stability_foundation.sql` (updated dashboard fallback)
- `supabase/migrations/202610240002_global_brand_logo_reconciliation.sql` (renamed/replayed idempotently)
- `supabase/migrations/202610240003_fix_cross_restaurant_checkout_charges_reconciliation.sql` (idempotent historical fix replay)
- `supabase/verification/build27_catalog_checks.sql` (new)
- `supabase/verification/build27_dashboard_metrics_smoke.sql` (new staging smoke test)
- `scripts/check-supabase-migration-versions.mjs` (new migration preflight)
- `tests/build27-migration-integrity.test.mjs` (new repository/migration checks)

### Tests and documentation

- `tests/build27-payment-validation.test.mjs` (new)
- `_qa/BUILD27_REGRESSION_TEST_MATRIX.md` (new)
- `BUILD27_COMPLETION_REPORT.md` (new)
- `README.md`
- `TABLELY_CURRENT_STATE_MASTER_CONTEXT.md`
- `SECURITY_AUDIT.md`
- `package.json` (adds `test: node --test` and `check:migrations`)

The original archive was not modified.

## C. Database changes in the new migration

`202610240001_build27_stability_foundation.sql`:

1. Enables RLS on `payment_transactions` and removes direct `anon`/`authenticated` table privileges.
2. Adds `get_branch_dashboard_metrics(uuid)` for branch-local financial and order summaries, including the failed-only-ledger compatibility fallback.
3. Adds `finalize_legacy_razorpay_order(...)` for atomic legacy PAY_NOW ledger recording and settlement.
4. Adds a lease timestamp and claim/set/release RPCs to serialize provider order creation for `payment_attempts`.
5. Adds a legacy order lease timestamp and claim/set/release RPCs for order-first PAY_NOW compatibility.
6. Adds unique-version reconciliation migrations for the historical global-brand and checkout-charge changes.
7. Uses the matching partial-index predicate when upserting by the unique provider-order index.

All three migrations are **included in the ZIP but have not been applied**. The catalog and dashboard SQL verification helpers are included but were not run against a database.

## D. Tests and command results

| Check | Status | Result |
|---|---|---|
| Uploaded ZIP integrity | PASS | Archive opened; CRC check passed |
| Baseline comparison | PASS | New archive's extracted files matched the previous supplied baseline |
| `node --test tests/build27-payment-validation.test.mjs` | PASS | 4 tests passed |
| `npm test` | PASS | Node built-in test runner; 13 tests passed |
| `npm run check:migrations` | PASS | 131 SQL files; 131 unique numeric versions; no collisions |
| `node --check` | PASS | Payment helper, migration test and migration preflight scripts pass syntax checks |
| TypeScript syntax transpilation | PASS | All four modified `.ts`/`.tsx` files transpiled without syntax diagnostics using the globally installed TypeScript compiler |
| Static migration structure scan | PASS | Transaction delimiters, balanced dollar quotes, required RPC definitions, pinned search paths and route/RPC names checked; not a semantic PostgreSQL validation |
| Full TypeScript typecheck (`npm run typecheck`) | BLOCKED | Dependency installation timed out; project modules/types (`next`, `react`, `zod`, etc.) unavailable. The command emitted missing-module/JSX-type errors across the repository, so this is not a valid full typecheck result. |
| `npm run lint` | BLOCKED | `eslint` executable unavailable because dependencies are not installed |
| `npm run build` | BLOCKED | `next` executable unavailable because dependencies are not installed |
| SQL semantic validation | BLOCKED | PostgreSQL/Supabase CLI unavailable |
| Supabase migration application | NOT RUN | No remote database action authorized or available |
| RLS/tenant isolation tests | NOT RUN | Requires staging Supabase with test identities |
| Browser session/concurrency tests | NOT RUN | Browser test runner not installed |
| Razorpay sandbox tests | NOT RUN | No test merchant credentials supplied |
| Production deployment | NOT RUN | Not authorized/performed |

## E. Preserved workflows and regression scope

The source modifications retain the existing customer visit identity model, multiple sessions per table, payment-first PAY_NOW flow, PAY_AT_COUNTER, PAY_LATER, coupon/order calculation flow, branch scope and current table state model.

The regression matrix records the scenarios that remain to be executed. Two additional static route-contract tests verify that both payment creation paths use the locked claim RPC and that verification is rate-limited before contacting Razorpay. No live customer workflow was run as part of this source-only task.

## F. Known issues and deployment prerequisites

1. **Remote migration ledger:** verify the target database records for `202609180031`. Local migration filenames are now unique and both historical changes have replay migrations, but the remote ledger must still be inspected before deployment.
2. **Database migration not applied:** all new SQL behavior remains inactive until safely applied in staging and then production.
3. **Dependencies:** `npm ci --no-audit --no-fund` timed out. Typecheck/lint/build are therefore blocked.
4. **RLS verification:** run `supabase/verification/build27_catalog_checks.sql` and the full tenant-isolation test matrix in staging.
5. **Payments:** run Razorpay test-mode checkout, webhook replay, duplicate-event, stale-failure-event and concurrency scenarios.
6. **Revenue semantics:** confirm the production data's `payment_transactions` status/amount conventions and refund representation before relying on the new totals. Current schema history shows transaction amounts are stored in major currency units (INR rupees), while Razorpay API amounts are in paise.
7. **Provider order leases:** a lease prevents ordinary simultaneous duplicate calls; network stalls beyond the lease and provider-success/database-failure cases can still leave an unreferenced Razorpay order. Reconciliation/alerting for orphan provider orders remains a later hardening opportunity.

## G. Deployment sequence

1. Back up the target database and inspect `supabase migration list` / `supabase_migrations.schema_migrations`.
2. Confirm the target ledger contains at most one row for `202609180031`; do not edit a historical migration already applied remotely.
3. Apply the current local migration chain in a disposable staging project, including the three latest reconciliation/stability migrations.
4. Run `supabase/verification/build27_catalog_checks.sql` and `supabase/verification/build27_dashboard_metrics_smoke.sql`.
5. Run two-tenant RLS and branch-permission tests.
6. Run Razorpay test-mode checkout and webhook concurrency/replay tests.
7. Validate dashboard revenue against known ledger records and refunds.
8. Only after staging verification, schedule and authorize production migration and deployment separately.

**Overall result:** Build 27 repository-level source changes and the locally executable static/unit checks are packaged. Full technical verification remains incomplete because dependencies could not be installed and PostgreSQL/Supabase, browser automation and Razorpay test credentials were unavailable. Do not treat this artifact as production-certified until the blocked checks are completed.
