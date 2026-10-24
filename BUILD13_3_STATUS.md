# TABLELY Build 13.3 — Order & Payment Core

## Scope implemented
- Branch/date-scoped order numbering with atomic PostgreSQL counter rows.
- Historical orders retain their existing displayed order numbers; new orders use branch/date numbering.
- Customer name and phone are captured and stored on orders.
- Failed online payment transitions the affected order to CANCELLED with `ONLINE_PAYMENT_FAILED`.
- Failed payment orders remain stored and are not actionable as normal new orders.
- Payment retry and pay-at-counter fallback create a new order with a new order number and fresh payment context.
- Manual restaurant cancellation with cancellation reason/actor/timestamp and server-side `CANCEL_ORDERS` authorization.
- Counter-payment settlement from the order page/backend for CASH and UPI.
- Completion through manual counter payment requires payment settlement first.
- Payment/order state handling remains separate.
- Payment failure and payment settlement paths are guarded against duplicate side effects and late success updates on cancelled orders.

## Files changed
- `supabase/migrations/202609160004_build13_3_order_payment_core.sql`
- `lib/customer.ts`
- `components/customer/CustomerCheckoutClient.tsx`
- `components/customer/CustomerOrderClient.tsx`
- `app/orders/page.tsx`
- `app/api/payments/create/route.ts`
- `app/api/payments/verify/route.ts`
- `app/api/payments/webhook/route.ts`
- `app/api/payments/failure/route.ts` (new)

## Validation actually performed in this environment
- Source-vs-original comparison: changed-file set inspected.
- Repository searches for order creation, payment routes, order numbering and relevant RPCs: performed.
- Static source inspection of the new migration and modified TypeScript/TSX files: performed.
- Node.js available: yes.
- TypeScript compiler in project (`node_modules/.bin/tsc`): NOT PRESENT.
- ESLint binary in project (`node_modules/.bin/eslint`): NOT PRESENT.
- `npm install`: NOT RUN.
- `npm run typecheck`: NOT RUN.
- `npm run lint`: NOT RUN.
- `npm run build`: NOT RUN.
- Live Supabase migration execution: NOT RUN.

## Important limitation
This archive has not been runtime-verified in a live Supabase environment in this workspace. The migration and application changes therefore require execution/testing in the user's actual development environment before being treated as production-ready.
