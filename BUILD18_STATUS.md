# BUILD 18 — DISCOUNTS, COUPONS & CUSTOMER OFFER EXPERIENCE

Status: implemented in this workspace.

Implemented:
- Coupon model with percentage/fixed discounts, minimum order, validity windows, usage limits and promotion flag.
- Branch/product/category scoping.
- Server-side coupon validation and discount calculation.
- Existing branch charge engine integration: subtotal -> discount -> tax/charges -> total.
- Immutable coupon/discount snapshots on orders and payment attempts.
- Coupon usage records tied to orders, branches, tables/sessions and customer phone where available.
- Existing audit architecture integration for coupon administration and application events.
- Owner coupon management page with create/edit/enable/disable/usage/scope controls.
- Customer active-offer promotion on the menu, including offer application and scoped item indicators.
- Cart and checkout coupon UX with server-calculated totals and safe error states.
- PAY_AT_COUNTER and payment-first PAY_NOW integration using dedicated Build18 RPCs.
- Razorpay amount derived from the server-calculated discounted total.
- Existing subscription/order-quota enforcement remains attached to actual order creation.
- Expired PAY_NOW payment attempts are excluded from coupon usage reservations.
- Existing Build 1–17 security-sensitive RPCs are preserved.

Validation:
- Modified TS/TSX files parsed successfully using TypeScript transpilation diagnostics.
- Build18 SQL was checked for balanced PostgreSQL dollar-quote blocks, transaction markers, function definitions and corrected RPC signatures.
- Live PostgreSQL/Supabase execution and full npm build/lint require the project's external database/dependency environment and were not available in this workspace.
