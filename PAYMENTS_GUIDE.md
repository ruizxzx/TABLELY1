# TABLELY Payments Guide — Build 11

## Two payment systems

### Restaurant food payments
Customer → Tablely → Restaurant's own Razorpay → Restaurant bank.

Restaurant Razorpay credentials remain in the existing restaurant payment settings and are encrypted at rest.

### Tablely SaaS subscriptions
Restaurant → Tablely subscription → Tablely billing Razorpay.

These credentials, provider records and webhooks are separate from restaurant food payments.

## Environment

Restaurant payment variables remain the existing `RAZORPAY_*` variables.

SaaS billing variables are:

```text
TABLELY_RAZORPAY_KEY_ID
TABLELY_RAZORPAY_KEY_SECRET
TABLELY_RAZORPAY_WEBHOOK_SECRET
TABLELY_RAZORPAY_ENVIRONMENT
```

Never expose the secret variables to client code.

## Checkout safety

The server resolves the plan and amount. The client does not choose authoritative price data.

Paid entitlement is granted only after server-side verification.

## Idempotency

Subscription creation, payment recording and webhook processing are duplicate-safe. Webhook events are keyed by provider event ID.

## Failure behavior

Do not treat frontend success alone as payment success. Provider or verification failures must not grant paid entitlement.

## Test/live boundary

Use Razorpay Test Mode during development. Configure production credentials and production webhooks separately. Never silently fall back between environments.
