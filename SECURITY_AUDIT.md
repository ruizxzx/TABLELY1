# Tablely Security Review Checklist

Before pilot, execute these checks in staging/production-like data:

- Tenant A cannot read or mutate Tenant B.
- Branch A cannot read Branch B unless the user is explicitly assigned to both.
- Kitchen users cannot access payment administration.
- Waiters cannot manage staff or subscriptions.
- Anonymous users can only use public QR/menu/order capabilities.
- Customer cancellation requires the matching opaque tracking token.
- Order transition RPC rejects invalid state jumps server-side.
- Payment state can only become PAID after verified server processing or authorized manual payment RPC.
- Razorpay secrets never appear in browser payloads or logs.
- Duplicate order submissions return the same idempotent result.
- Duplicate payment/webhook events do not create additional payment records.
- Realtime reconnect does not duplicate records.
- Invalid/deleted/disabled QR routes fail with safe user-facing screens.
