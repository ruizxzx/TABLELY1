# TABLELY — Stable Build 19.4 + Build 20.1 Baseline

This package is the frozen code baseline for future TABLELY development.

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

See `TABLELY_CURRENT_STATE_MASTER_CONTEXT.md` for the full preservation and development rules.
