# Build 34 — Smart Inventory & Recipe Costing

**Status: in progress; not ready to deploy.** This record describes the current
repository state, not a claim that the full 12-sub-build plan is complete.

## What this build gives the restaurant

This build is meant to make the restaurant run with less waste, fewer stockouts,
and clearer profit visibility. In plain English, it gives the team a working system
for:

- knowing exactly how much each ingredient costs and what each dish really contributes
- tracking stock by branch, batch, and expiry date without relying on manual spreadsheets
- preventing accidental overselling when ingredients are low
- creating purchase orders and receiving stock with proper audit trails
- seeing wastage, variance, and stock movement history in one place
- moving stock between branches without losing visibility or control
- giving managers a single place to review stock health, purchasing, and recipe cost

The technical work is ultimately a system that helps restaurants answer a few
critical questions every day: What do we have? What is it worth? What should we buy next?
How much did it really cost us to serve this dish? What is still usable?

## Current implementation

This is the work that is already in the codebase, expressed in business terms, not just schema names:

- Ingredient master and stock tracking: every ingredient has a branch-aware record, stock ledger, supplier links, and storage location.
- Recipe costing: each menu item can be tied to a versioned recipe so the system can estimate actual cost per dish.
- Purchase and receiving: the restaurant can create purchase orders, receive stock into the branch, and keep a proper trail of what was ordered, received, and still pending.
- Order-based stock checks: when an order is accepted or completed, the system can reserve stock or consume it while respecting branch stock rules.
- Wastage and stock adjustments: counts and adjustments keep track of loss, over/under counts, and inventory differences.
- Branch transfers: stock can move between branches with dispatch, approval, and receiving steps.
- Cost visibility controls: managers can see pricing and cost details where they have permission, while sensitive cost data stays restricted when not allowed.

The worktree contains database drafts for:

| Migration | Scope in the current file |
| --- | --- |
| `20261025030000_build34_1_inventory_foundation.sql` | Inventory schema, staff permissions, RLS, balance helpers, and defaults |
| `20261025040000_build34_2_inventory_item_rpcs.sql` | Item, supplier, location, settings, and overview RPCs |
| `20261025050000_build34_3_recipe_rpcs.sql` | Recipe and costing RPCs |
| `20261025060000_build34_4_purchase_grn_rpcs.sql` | Purchase order and goods receipt RPCs |
| `20261025070000_build34_5_order_consumption.sql` | Order reservation, consumption, and release hooks |
| `20261025080000_build34_6_wastage_counts_reports.sql` | Wastage, counts, transfers, and report RPCs |
| `20261025090000_build34_7_inventory_lifecycle_errors.sql` | Durable visibility for warning-mode order inventory failures |
| `20261025100000_build34_8_stock_count_privacy.sql` | Blind count and goods-receipt privacy with scoped read RPCs |
| `20261025110000_build34_9_wastage_reads.sql` | Cost-redacted wastage history, scoped ingredient choices, and paid-order food-cost reporting |
| `20261025120000_build34_10_transfer_workflow.sql` | Permission-scoped branch transfers with dispatch/receipt ledger entries |
| `20261025130000_build34_3_recipe_version_reads.sql` | Authorized read of historical recipe version ingredient snapshots |
| `20261025140000_build34_2_item_detail_reads.sql` | Scoped item detail, batches, supplier prices, and recipe usage RPCs |
| `20261025160000_build34_inventory_engine_hardening.sql` | Order preparation_status fix, item cancellation hooks, aggregated sale movements, FEFO batch allocation, base-unit protection, supplier price history, recipe coverage, sub-recipe production, smart reorders, error replay, and operational food cost |

The current changes harden the initial drafts by defaulting all nine inventory
permissions off for non-owners, correcting the item insert, limiting direct
cost reads, removing direct stock-ledger writes and staff execution of internal
balance/order helpers, and making warning-mode order inventory failures
durably visible. Inventory list/detail/overview and recipe RPCs enforce branch
permissions and feature access, redact cost-bearing fields unless the caller
has `INVENTORY_COST_VIEW`, and validate recipe ingredient organization/unit,
recipe-version ownership, and sub-recipe cycle constraints.
Purchase and goods-receipt RPCs also validate supplier/item/order/location
tenant and branch links, constrain quantities and price adjustments, preserve
existing PO lines when an update omits line changes, and use line-scoped
idempotency for GRN stock movements. PO receipts track partial quantities
under row locks, and opening-stock adjustments require an idempotency key.
Internal PO/GRN number helpers are no longer directly executable by clients.
Blind stock count lines are no longer directly selectable by authenticated
clients. Scoped RPCs mask expected quantities for blind counts, require a
complete set of non-negative item counts, snapshot expected stock under row
locks, and prevent a count submitter from approving their own adjustment
(except organization owners). Location IDs are checked against the active
branch during count creation. Goods-receipt and PO line reads now use
receive-scoped RPCs; agreed prices and pending GRN totals are returned only
with cost-view permission, and direct GRN table reads are revoked.

The initial restaurant UI includes an inventory overview, ingredient creation,
stock settings, locations/categories, recipe building for branch-linked menu
dishes, and blind/non-blind stock count creation, submission, and approval.
The ingredient detail screen supports editing safe metadata, supplier
relationships, batch and movement history, and current recipe usage; stock
units remain immutable through this editor to avoid invalidating historical
quantities.
Purchasing includes supplier creation, PO drafting, server-backed totals,
validated submission/approval/sent/cancel transitions, and GRN draft creation
and approval into stock. Authorized cost viewers
can calculate recipe cost and inspect line-level ingredient costs. Cost
calculations use per-serving ingredient quantities and current branch inventory
cost, with preferred supplier prices as a fallback.
Recipe owners can edit supported ingredient-only recipes to create a new
version, and staff can inspect saved ingredient snapshots by version.
Wastage now has a branch-scoped recording and history screen; item choices are
available only to wastage-authorized staff, and per-record costs are redacted
unless cost-view permission is present. The reporting screen provides
food-cost totals, top-consumed ingredients, recipe-based theoretical-versus-
actual variance, and CSV export. Its paid-sales total includes only completed,
paid orders. The variance view clearly identifies that historical recipe
snapshots are not yet used for its theoretical baseline.
The overview also lists active branch alerts and supports authorized manual
generation and dismissal. No scheduled alert job is configured yet.
Branch transfers require transfer permission on both endpoints for requests;
destination staff approve and receive, while source staff dispatch and mark
transit. Dispatch and accepted receipt quantities write ledger movements,
damaged-in-transit quantities are reconciled explicitly, and batch-linked
transfers preserve source expiry metadata. Direct writes to transfer records
and transfer-line reads are restricted to the authorized RPC workflow.

## Remaining work

- Complete a full review of the fourteen SQL drafts and validate them against a
  real local PostgreSQL/Supabase schema.
- Complete broader report coverage and configure alert scheduling/integration.
- Add price-change recalculation for cached recipe costs; recipe versions are
  recalculated when saved or explicitly costed, but inventory/supplier price
  changes do not yet refresh every cached menu cost.
- Implement and verify missing alert scheduling, sub-recipe production, and
  invoice/reorder AI.
- Add runtime database tests for tenant/branch isolation, stock-mode behavior,
  concurrent reservations, idempotency, and failure rollback.
- Reconcile migration versions against the deployment ledger before release.

No migration has been applied to a database. No production database, provider,
or customer-facing integration was contacted.

## Validation record

- `npm.cmd run test:inventory` — PASS (32 of 32 contract and engine tests pass).

- `npm.cmd run typecheck` — PASS (0 errors across entire Next.js codebase).

- `npm.cmd run build` — PASS after alert, wastage, and reporting changes;
  Next.js compiled successfully and generated all 181 static pages, with the
  eight current inventory routes included.
- `npm.cmd exec eslint -- app\\inventory\\page.tsx app\\inventory\\recipes\\page.tsx`
  — FAIL before lint analysis because the repository's ESLint 9 legacy config
  formatter threw a circular-structure `TypeError`.
- `git diff --check` — PASS (existing line-ending conversion warnings only).
- `npm.cmd run check:migrations` — FAIL due to pre-existing duplicate and
  malformed migration filenames elsewhere in the repository; the Build 34
  migration versions pass the focused Build 34 contract.
- `npm.cmd test` — FAIL (105/111). The six failures are the repository-wide
  migration-integrity, onboarding, support-interface, menu-translation,
  WhatsApp-consent, and engagement-dashboard contracts; the new Build 34 tests
  pass independently.
- SQL parser/runtime validation — BLOCKED: `psql` is unavailable, and the
  earlier Supabase CLI lint attempt was denied when the sandbox blocked its
  telemetry write under the user profile.
- Database execution and RLS integration tests — NOT RUN.

Do not treat the migrations as deployable until SQL lint and runtime database
tests pass and the migration ledger is reconciled.
