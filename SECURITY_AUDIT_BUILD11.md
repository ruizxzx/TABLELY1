# TABLELY Build 11 Security Audit

## Required boundaries

- Restaurant food credentials are separate from Tablely SaaS billing credentials.
- Provider secrets never enter client bundles.
- Plan and price are resolved server-side.
- Subscription webhooks require signature verification.
- Webhook processing is idempotent.
- Entitlement checks are server-side.
- Critical plan rules are also protected in database/RPC paths where applicable.
- RLS is preserved; Build 11 does not disable it as a shortcut.

## Required bypass tests

- Starter → Growth page
- Starter → Growth API
- Starter → third staff member
- Starter → online payment creation
- Expired → paid API
- Suspended → paid API
- Customer → subscription API
- Anonymous → subscription API
- Restaurant A → Restaurant B subscription

## Sensitive logging

Never log passwords, service-role keys, Razorpay secrets, OAuth credentials, or complete auth tokens.
