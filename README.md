# TABLELY — Current Code Baseline (Builds 1–26 + Builds 27–28 source changes)

This package contains the TABLELY source baseline through Builds 1–26, with Build 27 stability changes and Build 28 Smart Onboarding & QR 2.0 source changes. Migration files are repository history; they are not proof that every migration is applied in the live Supabase project. Build 27 and Build 28 migrations must be reconciled with the target project's live migration history before deployment.

Build 29 payment reconciliation and split-billing staging work is documented in [BUILD29_GUIDE.md](BUILD29_GUIDE.md) and [BUILD29_COMPLETION_REPORT.md](BUILD29_COMPLETION_REPORT.md). Its migration is source-only and has not been applied to a live database.

## Important

- Preserve existing working behavior. Do not redesign or refactor unrelated areas.
- Live Supabase state is authoritative for database behavior.
- TABLELY supports multiple concurrent/open sessions on the same physical table.
- Do NOT reintroduce a one-active-session-per-table constraint.
- Session identity is based on the visit/session-token architecture, not table code, phone number, or device token.
- PAY_NOW uses the payment-first flow: the final restaurant order is not created merely because payment is started.
- PAY_AT_COUNTER remains supported.
- Existing checkout idempotency must remain intact.
- Build 20.1 browser cart/coupon state is namespaced by browser visit context.

## Customer browser state

Cart:
`tablely:cart:{tableCode}:{visitContextId}`

Coupon:
`tablely:coupon:{tableCode}:{visitContextId}`

Checkout idempotency:
`tablely-checkout:{tableCode}`

## Current session model

A physical table can have multiple open sessions. A genuinely new independent visit may create another session while an older unresolved session remains open.

The agreed future lifecycle is hybrid:

- Fully settled old session + genuinely new independent visit → old session may auto-close.
- Unpaid/active/unresolved old session → keep it open.
- Manager keeps a manual Close Session fallback.

Do not treat every new session as proof that an older customer has left; shared-table/concurrent-session behavior must remain possible.

## Development

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run check:migrations
npm.cmd run build
npm.cmd run dev
```

Local app: `http://localhost:3001`

Create `.env.local` from `.env.example`.

## Supabase

The canonical database history is under `supabase/migrations/`.

Do not use the removed legacy one-off setup SQL files from the old package. Do not rerun old migrations out of order.

Before applying a DB change, inspect the existing live state. Afterward, verify function signatures, indexes/constraints, and the affected runtime flow.

## Current relevant SQL functions

- `build19_resolve_session_for_write`
- `build19_resolve_session_by_hash`
- `build17_attach_order_session`
- `build17_sync_table_operational_state`
- `close_table_session`
- `create_order_for_table_v18`
- `create_payment_attempt_for_table_v18`
- `finalize_payment_attempt_v18`

See `TABLELY_CURRENT_STATE_MASTER_CONTEXT.md` for the full preservation and development rules. See `BUILD27_COMPLETION_REPORT.md` for Build 27 implementation status and verification limits. See `BUILD28_GUIDE.md` for the menu importer, onboarding, Razorpay setup and permanent QR implementation, environment configuration and validation limits. See `_qa/BUILD27_REGRESSION_TEST_MATRIX.md` for the Build 27 regression matrix.
