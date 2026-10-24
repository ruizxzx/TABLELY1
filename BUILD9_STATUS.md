# Tablely Build 9 — Super Admin

Implemented secure platform-admin foundations.

## Included
- `/admin` control center.
- Separate `platform_admins` authorization model.
- Platform overview metrics.
- Restaurant listing.
- Restaurant activate/suspend control.
- Subscription plan management for Starter/Growth/Pro.
- Trial/subscription tracking.
- Admin audit log.
- Restaurant and payment secrets are not exposed through admin views.

## Activation
A production operator must insert the intended Tablely administrator user into `public.platform_admins` after the production auth account exists.
