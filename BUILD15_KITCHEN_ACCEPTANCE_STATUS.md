# TABLELY — Kitchen Order Acceptance Feature

Implemented on top of Build 14 V5.

## Included

- Branch-scoped `kitchen_accept_orders` setting on `branches`.
- Branch Manager/Owner RPC to toggle the setting.
- Non-owner toggle is restricted to a Manager assigned to that branch with `BRANCH_MANAGEMENT`.
- Kitchen acceptance of `NEW -> ACCEPTED` is separately gated by `KITCHEN_ACCESS` + the branch setting.
- Existing Owner/Manager/Waiter order-accept behavior remains unchanged.
- Kitchen tab now receives `NEW` orders in realtime and shows them immediately without refresh.
- Realtime remains branch-filtered through the existing Supabase Realtime subscription.
- When acceptance is OFF, new orders remain visible but cannot be accepted by Kitchen.
- Backend rejects direct forged/unauthorized Kitchen acceptance attempts.
- Customer cancellation-request resolution is explicitly unavailable to MANAGER.
- Managers are removed from cancellation-request notifications; Owner and eligible waiter-capable staff remain recipients.
- Existing direct order cancellation permission is not changed by this feature.
- Login now exposes self-service password recovery.
- Added `/auth/reset-password` recovery page using Supabase Auth recovery sessions.
- Setting changes are recorded in the existing `admin_audit_logs` table for later consolidation by Build 21.

## Important configuration

Supabase Auth must allow the application origin plus:

`/auth/reset-password`

as a password-reset redirect URL.

## Migration

Apply:

`supabase/migrations/202609170001_build15_kitchen_acceptance.sql`

The migration is additive and defaults existing/new branch kitchen acceptance to OFF.

## Validation performed

- TypeScript/TSX syntax transpilation passed for all modified TS/TSX files.
- Migration structure and authorization paths were reviewed against the current Build 14 V5 code.
- A live Supabase migration/build was not executed in this environment.

## Files changed

- `supabase/migrations/202609170001_build15_kitchen_acceptance.sql`
- `app/kitchen/page.tsx`
- `app/staff/page.tsx`
- `components/OrderCancellationRequests.tsx`
- `app/login/page.tsx`
- `app/auth/reset-password/page.tsx`
- `app/globals.css`
