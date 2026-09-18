# TABLELY Subscription Guide — Build 11

## Plans

- Starter: ₹499/month
- Growth: ₹999/month
- Pro: ₹1,999/month
- Default trial: 14 days

## Billing separation

Restaurant food payments use each restaurant's own Razorpay account. Tablely SaaS subscriptions use a separate Tablely billing Razorpay account. Never reuse restaurant secrets for SaaS billing.

## Current architecture

Authenticated user → organization → subscription → plan → entitlements → allowed operation.

The browser is not authoritative for plan, price, subscription status, entitlement, payment success, or organization ownership.

## Subscription states

TRIAL, ACTIVE, PAST_DUE, CANCELLED, EXPIRED, SUSPENDED.

TRIAL uses the selected plan's entitlements. EXPIRED and SUSPENDED remove paid feature access while retaining restaurant data. CANCELLED keeps access through the current paid period when the provider supports cancel-at-cycle-end.

## Historical pricing

Build 11 stores `price_monthly_snapshot` on each subscription. Existing subscriptions are backfilled from the catalog at migration time; new or administratively changed subscriptions use the current catalog price. Changing the plan catalog price does not rewrite old subscription snapshots.

## Entitlements

Central features include ONLINE_PAYMENTS, UNLIMITED_STAFF, SERVICE_REQUESTS, ANALYTICS, PAYMENT_TRACKING, CUSTOM_BRANDING, MULTI_BRANCH, ADVANCED_ANALYTICS, CROSS_BRANCH_REPORTING, ADVANCED_PERMISSIONS and CUSTOM_DOMAIN.

Critical feature checks are enforced server-side and, where appropriate, by database triggers/RPCs.

## Razorpay SaaS setup

1. Add TABLELY_RAZORPAY_KEY_ID and TABLELY_RAZORPAY_KEY_SECRET to the server environment.
2. Keep TABLELY_RAZORPAY_WEBHOOK_SECRET server-side.
3. Run the Build 11 database migration.
4. Open Super Admin → Manage plans.
5. Provision each active plan to create/link its Razorpay plan ID.
6. Configure the Razorpay subscription webhook endpoint as `/api/subscriptions/webhook` on the deployed Tablely origin.
7. Test the subscription authentication/checkout in Razorpay Test Mode before switching to Live Mode.

## Notes

Razorpay subscription checkout creates a provider subscription, then passes the returned `subscription_id` to Standard Checkout. Successful checkout data is verified server-side before paid entitlement is activated.

A true cancelled Razorpay subscription is not restarted by a local "resume" button. Future resume support should use provider pause/update semantics only where the provider supports them.
