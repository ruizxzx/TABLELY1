# TABLELY Build 13.2 Status

This patch fixes the live Manager permission gaps discovered after Build 13.2 audit testing and adds branch-scoped restaurant configuration.

## Fixed

- Manager can access Checkout Charges when `CHARGES` is enabled.
- Manager can access Payments when `PAYMENTS` is enabled and the restaurant has the `ONLINE_PAYMENTS` subscription feature.
- Manager can access the Subscription page when `SUBSCRIPTION_MANAGEMENT` is enabled, while subscription mutation controls remain Owner-only.
- Nested routes such as `/settings/charges`, `/settings/payments`, `/dashboard/subscription`, `/settings/domain`, and `/staff/permissions` receive path-specific authorization in the client shell in addition to server checks.
- Checkout charges support branch-specific overrides with organization-level fallback.
- Restaurant payment configuration supports branch-specific overrides with organization-level fallback.
- Customer order/payment resolution uses the authoritative order branch before resolving charges or Razorpay credentials.
- Branch-specific payment overrides inherit encrypted provider credentials server-side when first created; secrets are never sent to the browser.
- Branch managers are restricted to their assigned branch and `CHARGES`/`PAYMENTS` permissions.
- Subscription read APIs are restricted to Owner or delegated Manager access.

## Scope

Discounts are not implemented in this patch. They remain part of the planned commerce build.
