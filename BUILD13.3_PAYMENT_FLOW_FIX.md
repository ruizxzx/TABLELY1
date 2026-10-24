# TABLELY Build 13.3 — Payment Flow Fix

## Root cause
PAY_NOW orders were being created as `NEW` + `PENDING`, and the restaurant-side order transition was not rejecting that combination. This made unpaid online orders appear actionable.

## Fixed behavior
- PAY_NOW remains represented in the existing enum as `NEW` + `PENDING`, but is treated as a derived **AWAITING_PAYMENT** state.
- Restaurant-side status mutations reject PAY_NOW + PENDING orders.
- Successful Razorpay confirmation changes the pending order to `PAID` and leaves it as `NEW`, making it actionable.
- Definitive online payment failure immediately cancels the order with `ONLINE_PAYMENT_FAILED`.
- Pending PAY_NOW orders receive a server-side one-hour expiry and are cancelled with `ONLINE_PAYMENT_TIMEOUT` if unresolved.
- Expiry is idempotent and late payment success cannot resurrect a cancelled order.
- Customer public order reads lazily expire an expired pending order, while pg_cron is scheduled every minute when available for authoritative background expiry.
- Retries create new orders and receive a fresh payment window.
- Restaurant and customer UIs distinguish awaiting payment from normal NEW orders.
- Customer cancellation messaging distinguishes payment failure from payment timeout.

## Files changed
- `supabase/migrations/202609160005_build13_3_payment_state_fix.sql`
- `app/api/payments/create/route.ts`
- `app/api/payments/verify/route.ts`
- `app/api/payments/webhook/route.ts`
- `app/orders/page.tsx`
- `components/StatusBadge.tsx`
- `components/customer/CustomerOrderClient.tsx`
- `lib/customer.ts`
- `BUILD13.3_PAYMENT_FLOW_FIX.md`

## Verification limitations
- Static feature/consistency checks: run.
- TypeScript syntax parsing: run using the installed TypeScript compiler API.
- Full npm build/lint/typecheck: not run because dependencies were not available locally and `npm ci` timed out in the sandbox.
- Live Supabase/Razorpay/database runtime tests: not run because no project credentials/network-backed database were available in the sandbox.
