# Tablely Builds 5–8 Status

Implemented in this release on top of the existing Build 1–4 project.

## Build 5
- Supabase Realtime Postgres Changes for orders and service requests.
- Customer order-status Broadcast channel using opaque tracking token.
- Live/reconnecting indicators.
- Realtime new-order refresh in restaurant and kitchen screens.
- Server-side order state transition RPC.
- Live order filters and action controls.
- New-order sound toggle.
- Live customer order status updates with polling fallback.

## Build 6
- Kitchen screen shows line items, modifiers, notes and elapsed order context.
- Role enforcement in the database for OWNER/MANAGER/WAITER/KITCHEN.
- Customer service requests: waiter, water, bill.
- Staff service-request workspace with acknowledge/resolve.
- Service-request rate limiting.

## Build 7
- Pay-at-counter payment confirmation through a server-side RPC.
- Payment transaction ledger.
- Razorpay server order creation.
- Razorpay Standard Checkout client integration.
- Server-side HMAC payment signature verification.
- Razorpay payment-status lookup.
- Webhook signature verification and idempotent payment upserts.
- Billing/payment history page.

## Build 8
- Persistent database rate limiting for public ordering/service requests.
- Stronger idempotent order creation.
- Stale-cart/price/availability validation remains server-side.
- Explicit RLS on new operational tables.
- Global error boundary.
- Analytics RPC and analytics screen.
- Mobile-oriented operational states and connection indicators.
- Favicon and Next.js scroll-behavior warning cleanup.

## Verification
- 49 TypeScript/TSX files were parsed with the TypeScript compiler parser: 0 parse diagnostics.
- The sandbox could not complete `npm install`, so a full Next.js production compiler/build could not be executed here.
