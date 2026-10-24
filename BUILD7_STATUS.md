# Tablely Build 7 — Payments + Billing

## Implemented
- Pay-at-counter remains available.
- On-demand online payment flow is plan-gated.
- Online payment is shown only when restaurant plan supports it and the restaurant enables it.
- Restaurant-owned Razorpay settings architecture.
- Server-side Razorpay signature verification.
- Restaurant-scoped Razorpay credentials.
- Idempotent payment transaction persistence.
- Payment/order amount reconciliation.
- Billing page at `/bills`.
- Payment settings at `/settings/payments`.
- Payment history remains in `/payments`.

## Deliberate product rule
There is no refund workflow in Tablely V1. Cancellation is handled through a customer cancellation request that the restaurant accepts or rejects.

## External requirement
Live restaurant Razorpay credentials and `TABLELY_ENCRYPTION_KEY` must be supplied before production online payments can be enabled.
