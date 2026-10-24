# Tablely V1 Status — Builds 3 + 4

## Completed

- Build 1 foundation and UI system
- Build 2 authentication, restaurant onboarding and tenant RLS
- Build 3 persistent menu categories/items
- Build 3 persistent tables with stable codes
- Build 3 QR generation and printable customer links
- Build 4 public QR/table validation
- Build 4 customer menu/search/categories
- Build 4 product detail and add-ons
- Build 4 local cart persistence
- Build 4 server-side order creation with price revalidation
- Build 4 idempotency key support
- Build 4 order number + tracking token
- Build 4 public order tracking
- Restaurant dashboard/orders/kitchen now use persistent Supabase data (polling/refresh in this stage)

## Not yet in this release

- Supabase Realtime subscriptions (Build 5)
- WhatsApp/SMS notifications
- Razorpay order creation, signature verification and webhooks (Build 7)
- Advanced rate limiting and full hardening pass (Build 8)
- Super Admin (Build 9)
- Production deployment (Build 10)

## Verification performed in the build environment

- 33 TS/TSX source files parsed with TypeScript syntax diagnostics: 0 syntax errors
- package.json parses successfully
- New customer routes and Build 3/4 source are present

A full Next.js compiler build was not available in this sandbox because npm dependency installation timed out. Run `npm.cmd run typecheck` and `npm.cmd run build` locally before merging.

## Build 3 + 4 security notes

- Anonymous browser access is limited to four security-definer RPCs for public table/menu/order data.
- Direct anonymous access to tenant tables is revoked.
- Customer order totals are recomputed from current database prices and validated add-ons inside the database function.
- Cross-branch category/table/order-item references are rejected by database triggers.
- Order creation is idempotent when a checkout key is reused.
