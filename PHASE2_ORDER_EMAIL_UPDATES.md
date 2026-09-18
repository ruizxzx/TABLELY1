# TABLELY — Phase 2: Checkout Email Updates

Phase 2 adds the customer-side opt-in and email capture flow for order status notifications.

## Included

- Checkout toggle: **Get updates about your order**
- Email field appears only when the toggle is enabled.
- Client-side email validation before placing the order.
- Guest customers can use the feature; no TABLELY account is required.
- After a successful order, the app saves the notification subscription through a server-side Next.js API route.
- PAY_AT_COUNTER, PAY_AFTER_DELIVERY, and successful PAY_NOW orders all use the same subscription-save path.
- The API verifies the order using both `orderId` and the order's `tracking_token` before writing the subscription.
- Subscription writes are idempotent on `order_id`.
- No Resend integration, Edge Function, automatic notification events, or email sending is included in Phase 2.
- Email subscription storage failures do not cancel or invalidate a successfully placed restaurant order.

## Existing functionality intentionally left unchanged

- payment method behavior
- guest checkout authentication rules
- coupons
- charges/tax calculation
- restaurant/branch isolation
- order status behavior
- existing Phase 1 database migration

## Verification limitation

The repository has no installed `node_modules`. `npm run typecheck` therefore cannot perform a meaningful project typecheck in this environment, and `npm ci --ignore-scripts --prefer-offline` timed out. The code was statically inspected after modification. No claim of a full build/typecheck pass is made.
