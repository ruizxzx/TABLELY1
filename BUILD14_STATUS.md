# TABLELY Build 14 — Subscription V2

Implemented on top of the verified Build 13.4 codebase.

## Included
- Canonical Starter/Growth/Pro pricing and limits
- Monthly and annual catalog prices
- Razorpay monthly/yearly provider-plan support
- Server-side entitlement resolver with usage and remaining capacity
- Trial lifecycle compatibility (existing TRIAL storage; API exposes TRIALING)
- Owner-only subscription checkout/plan changes/cancellation access
- Monthly/annual billing interval selection
- Provider subscription metadata and selected-price snapshots
- Server-side branch/staff/table/menu/order creation limits
- Billing-period order quota enforcement
- Subscription usage API/UI
- Platform-admin subscription overview and usage
- Platform-admin plan catalog editing and provider-plan provisioning
- Public pricing backed by the same server-side catalog, with offline/static fallback only when the catalog is unavailable
- Subscription audit-event storage and logging hooks
- Annual/monthly MRR handling
- Existing Build 13.3 payment/order and Build 13.4 realtime paths preserved

## Migration
`supabase/migrations/202609160013_build14_subscription_v2.sql`

Run after Build 13.4 migration `202609160012_build13_4_owner_notification_preferences_grant_fix.sql`.

The migration intentionally keeps existing storage status values such as `TRIAL` for backwards compatibility; the entitlement/current-subscription APIs expose the canonical `TRIALING` representation.

## Provider note
Razorpay supports `monthly` and `yearly` plan periods. Annual provider plans are therefore stored separately from monthly provider plans.

## Audit fixes applied
The original Build 14 drop failed verification. See `BUILD14_AUDIT_FIXES.md` for the
full list. Headline corrections now folded into this build:
- `subscription_resource_available_internal` was `STABLE` with `SELECT ... FOR UPDATE`, which would have made every branch/staff/table/menu insert fail at runtime.
- Provider-sync RPCs were re-granted to `authenticated`, allowing an owner to activate a paid plan with no payment. All are service-role only again.
- The order-limit trigger was never attached to `public.orders`; it now is.
- `admin_list_subscription_overview_v2` had an ambiguous column reference that aborted the platform-admin page.
- Pending plan changes were never cleared after the provider applied them.
- The migration overwrote prices of already-provisioned provider plans; it now leaves those alone.
- `max_monthly_orders` was enforced across the whole billing period, giving annual plans a yearly allowance.

## Validation
- 101/101 real `.ts`/`.tsx` files parsed successfully (generated `next-env.d.ts` excluded from parser count).
- Build 14 migration has exactly one `BEGIN;` / `COMMIT;` pair.
- Migration dollar-quoted function bodies are balanced.
- No live Supabase execution was possible in this sandbox. The migration has NOT been run against a real database.
- Full Next.js build/lint/typecheck NOT EXECUTED: npm install fails without network access (registry returns 403). Run `npm run lint`, `npm run build` and `npx tsc --noEmit` before merging.
- Repo-wide scan confirms zero non-volatile SQL functions containing `FOR UPDATE`.
- All 79 RPCs referenced from `.ts`/`.tsx` resolve to a function defined in `supabase/migrations/`.
