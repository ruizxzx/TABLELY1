# TABLELY Build 35.3 — Foundation Repair Report

**Status: code changes and contract tests completed; production validation is blocked.**

This report describes the changes made to the supplied repository against the Build 35 foundation prompt. It does not certify the project as bug-free: the repository could not be installed or exercised against a live Supabase/PostgreSQL instance in this environment.

## 1. Main defects addressed

- The legacy order/table trigger still rejected a `NULL` table reference, conflicting with tableless pickup and delivery orders.
- Public delivery-zone aggregation ordering was corrected to use aggregate-local `ORDER BY`, with an empty-array fallback.
- Online ordering, pickup, delivery, automatic acceptance and delivery payment preferences are now fail-closed by default; existing branch settings are explicitly disabled pending an authorized enablement.
- Branch settings updates now merge supported JSON settings instead of reconstructing and discarding unrelated pickup/delivery options. Changes are audited.
- Public checkout validates active branch and organization, enabled fulfillment, server-calculated pricing, serviceability, and menu item availability. Draft menu items are rejected even when their UUID is submitted directly.
- Checkout now has a branch-scoped idempotency lock/fingerprint and stores a price snapshot. Coupon validation errors are not silently converted to a zero discount; the existing coupon usage ledger is written.
- Fulfillment transitions now gate pickup handoff and delivery dispatch/delivery on the appropriate order and fulfillment states. Order, fulfillment and payment statuses remain separate; COD delivery can complete before payment collection.
- Handoff codes use cryptographically secure random generation and bcrypt hashes, expiry, one-time use and a five-attempt cap. Raw codes/hashes are excluded from public tracking and staff list responses.
- Delivery assignment verifies active same-branch staff with explicit delivery permission. Rider queries are limited to assigned deliveries.
- Sensitive customer details are returned through a branch-permission-scoped RPC rather than broad direct table reads.

## 2. Database and API changes

### New migration

`supabase/migrations/20261026030000_build35_3_foundation_repair.sql`

The migration is forward-only and transaction-wrapped. It adds/updates ordering defaults, audit records, checkout idempotency/snapshot data, OTP verification metadata, grants/RLS boundaries, and the server functions/triggers needed for the repaired flow. It replaces the legacy order/table validation trigger without changing historical migrations.

Build 35.1 already makes `orders.table_id` and `payment_attempts.table_id` nullable and constrains their fulfillment types; Build 35.3 fixes the remaining legacy trigger conflict and strengthens enforcement. The existing payment provider, payment attempts, payment transactions, coupon engine and inventory lifecycle are reused rather than replaced.

### Important RPC and trigger paths

- `validate_order_table_branch`
- `get_public_storefront_context`
- `get_public_menu_for_branch`
- `preview_public_fulfillment_checkout`
- `create_public_fulfillment_order`
- `save_branch_ordering_settings`
- `get_branch_order_customer_details`
- `get_public_fulfillment_order`
- `fulfillment_assign_rider`
- `fulfillment_list_eligible_riders`
- `fulfillment_list_my_deliveries`
- `fulfillment_list_branch_orders`
- `fulfillment_dispatch_delivery`
- `fulfillment_confirm_pickup`
- `fulfillment_confirm_delivered`
- `fulfillment_collect_payment`
- `transition_order_status`

The migration also adds fulfillment audit/event handling and permission seeds for online order visibility, customer detail visibility, ordering settings, pickup, delivery, rider assignment/status, payment collection and fulfillment reporting.

## 3. UI and application changes

- `app/settings/online-ordering/page.tsx` — disabled-safe settings and RPC-based partial updates.
- `app/pickup/page.tsx` — secured pickup queue and ready/handoff state handling.
- `app/delivery/page.tsx` — dispatch readiness, eligible rider assignment, manager override reason and restricted delivery details.
- `app/delivery/my-orders/page.tsx` — assigned-delivery-only rider workspace.
- `app/orders/page.tsx` and `app/kitchen/page.tsx` — permission-scoped customer detail retrieval and table-independent fulfillment display.
- `app/staff/permissions/page.tsx`, `lib/tablely-build12.ts` and `components/StudioShell.tsx` — fulfillment permission controls and route gating.
- `components/customer/StorefrontCheckoutClient.tsx` — stable checkout idempotency key and one-time handoff-code handling.
- `components/customer/StorefrontTrackClient.tsx` — updated pickup/delivery status progression and code cleanup after handoff.
- `package.json` — includes the new Build 35.3 contract test in the full and focused test scripts.

The prompt explicitly deferred the complete customer storefront and advanced delivery features. No GPS tracking, smart rider assignment or replacement payment system was added.

## 4. Tests and validation

| Check | Result | Notes |
|---|---:|---|
| Build 35 fulfillment + repair contract tests | **31/31 passed** | Node test runner; static/schema contract coverage, not a live database test |
| Inventory suite | **32/32 passed** | Existing inventory regression tests |
| Full repository suite | **160/168 passed** | 8 failures remain; details below |
| Supabase migration preflight | **Failed** | Existing duplicate and malformed legacy migration filenames |
| `npm ci` | **Blocked** | npm registry DNS failure (`EAI_AGAIN registry.npmjs.org`) |
| TypeScript typecheck | **Not verifiable** | Project dependencies/types are absent; global `tsc` reports unresolved Next/React modules and cascading type errors |
| ESLint | **Not run** | `eslint` executable unavailable without dependencies |
| Next.js production build | **Not run** | `next` executable unavailable without dependencies |
| SQL parse / migration apply / RLS integration | **Not run** | No PostgreSQL server, `psql`, or Supabase CLI/runtime available |

### Full-suite failures

The eight failures are the existing repository contract/migration checks, not newly added Build 35 tests:

1. Migration numeric versions are unique and valid.
2. Onboarding menu/QR route-back contract.
3. Separate restaurant/platform support interfaces contract.
4. Live restaurant chat branch-authorization contract.
5. Orders session grouping contract.
6. Hindi/Bengali customer-language persistence contract.
7. WhatsApp STOP consent-revocation contract.
8. Engagement dashboard AI-translation-toggle contract.

The Build 35 focused suite passes. The full suite is not fully green.

## 5. Migration history blocker

The preflight detects five duplicate version groups:

- `202609160013`
- `202609170015`
- `202609170016`
- `202609170018`
- `202609180031`

It also detects four malformed legacy filenames:

- `20260922240000_repair_approved_product_visibility.sql`
- `20260922250000_grant_billing_service_role.sql`
- `20260922251000_build21_analytics_event_dedup.sql`
- `RUN_THIS_NOW_hotfix_202609170018.sql`

These historical files were not renamed or rewritten. Before deployment, compare the exact SQL already applied in each environment with `supabase_migrations.schema_migrations`, reconcile the duplicate-version histories deliberately, and test the resulting migration sequence against a database clone. Do not run `supabase db push` until this is resolved.

## 6. Remaining limitations and manual release steps

1. **Live SQL validation is mandatory.** Apply the migration to a restored staging database after the history blocker has been reconciled. Run migration, RLS, RPC, payment and inventory integration tests before production.
2. **Install dependencies in a network-enabled environment.** Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:inventory` and `npm run build`.
3. **Verify OTP delivery UX.** The handoff code is only returned on initial order creation; an idempotent retry intentionally does not reveal it again. If the initial response is lost, staff need to use the audited manager override. Existing plaintext handoff values are invalidated/expired by the migration and require a fresh manager-assisted handoff.
4. **Rate limiting scope.** OTP verification is attempt-limited per order and expires, but a separate edge/IP-level request throttler and notification delivery integration were not proven in this environment.
5. **Prepaid fulfillment checkout.** This build prepares the tableless payment-attempt foundation but intentionally leaves the full prepaid checkout workflow for the next build, as the supplied prompt requested.
6. **Legacy migration ledger.** Resolve per-environment history before applying the new migration; this package does not silently rewrite deployed history.

## 7. Readiness assessment

The repository contains the Build 35.3 repair code and its focused contract tests. It is **not yet production-certified or confirmed ready for deployment** because migration history is invalid and runtime SQL, RLS integration, typecheck, lint and production build could not be completed here. It is suitable for the next engineering review/staging-validation step once those blockers are addressed.

## 8. Build 35.5 schema reconciliation

The public storefront and fulfillment SQL referenced `branches.active`, but the established branch status column is `branches.is_active`. The online ordering settings and rider list RPCs were also reported missing from the PostgREST schema cache. The forward-only migration `supabase/migrations/20261026050000_build35_5_schema_reconciliation.sql` adds a generated compatibility column backed by `is_active` and restores the reported RPCs with their existing permission checks. Build 35.6 (`supabase/migrations/20261026060000_build35_6_storefront_zone_ordering.sql`) replaces the storefront context function with aggregate-local delivery-zone ordering, uses the canonical `is_active` field, and requests a PostgREST schema reload. Build 35.7 (`supabase/migrations/20261026070000_build35_7_storefront_cover_compatibility.sql`) preserves the optional storefront `cover_url` return field as `NULL` because organizations do not have a cover-image column. Build 35.8 (`supabase/migrations/20261026080000_build35_8_menu_modifier_schema.sql`) replaces the public menu RPC to use the established Build 16 modifier relations and fields. Build 35.9 (`supabase/migrations/20261026090000_build35_9_menu_modifier_result_types.sql`) recreates that RPC with `jsonb` result types matching the actual `menu_items` columns. Build 35.10 (`supabase/migrations/20261026100000_build35_10_tracking_order_id_qualification.sql`) qualifies the fulfillment-detail lookup in public tracking to avoid ambiguity with the RPC's `order_id` output column. Build 35.11 (`supabase/migrations/20261026110000_build35_11_orders_rpc_recovery.sql`) restores the branch-scoped customer details and pickup handoff RPCs after live PostgREST 404s, and `/orders` now surfaces structured query errors and fails visibly on fulfillment-detail load failures. Build 35.12 (`supabase/migrations/20261026120000_build35_12_pickup_schema_recovery.sql`) restores the pickup OTP/hash columns and reconciles READY fulfillment states for existing READY orders. The pickup modal now maps missing-schema and permission errors to actionable messages without exposing raw database details. Build 35.13 (`supabase/migrations/20261026130000_build35_13_atomic_pickup_payment.sql`) performs code verification, cash/UPI collection, pickup handoff, and order completion atomically; both Orders and Self Pickup collect the method and UPI reference at handover. Build 35.14 (`supabase/migrations/20261026140000_build35_14_cash_payment_reference_fix.sql`) normalizes an omitted reference source to SQL `NULL`, allowing Cash settlement while preserving validation for populated UPI references. Build 35.15 (`supabase/migrations/20261026150000_build35_15_rider_assignment_profile_fallback.sql`) replaces a stale deployed rider assignment function that referenced nonexistent `staff.full_name` with the supported `display_name` and profile fallback. Build 35.16 (`supabase/migrations/20261026160000_build35_16_delivery_retry_reassignment.sql`) clears stale rider assignment on failed-delivery retry, records the previous rider in the retry event, and allows assigning the same rider when an order is waiting for a new driver. Build 35.17 (`supabase/migrations/20261026170000_build35_17_delivery_confirmation_rpc_recovery.sql`) restores the exact delivery confirmation RPC signature used by the UI with OTP-attempt limits, assigned-rider authorization, audited manager override, and a PostgREST schema reload.

This migration has contract-test coverage only; it has not been applied to a database. Reconcile the existing migration ledger before applying it to a restored staging database. The existing migration-history blocker above still prevents recommending an unreviewed `supabase db push`.

## 9. Build 35.18 delivery payment and readiness

`supabase/migrations/20261026180000_build35_18_delivery_payment_and_readiness.sql` removes the collection-time COD/UPI toggle recheck for existing orders; checkout remains the eligibility gate, and collection still validates payment permission, exact order total, payment method, and UPI reference. It also repairs delivery orders already READY while a rider is assigned, recording the `READY_FOR_DISPATCH` transition. The Delivery Board now shows the assigned/waiting-for-kitchen state and offers reassignment, and the collection dialog passes a UPI reference and displays actionable safe errors.
