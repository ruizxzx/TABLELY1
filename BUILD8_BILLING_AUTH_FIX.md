# Build 8 — Billing/Auth 500 & 403 Fix

## Root causes fixed

1. The server admin Supabase client was receiving a modern `sb_secret_*` key through the default bearer-token header path. The admin client now sends that secret key through `apikey` and does not use it as `Authorization: Bearer <secret>`.
2. User JWT verification was incorrectly coupled to the privileged admin client. User access tokens are now verified with the public/publishable Supabase key.
3. `StudioShell` was making direct browser reads against protected `stores` and `creator_plans` and was calling a service-only reconciliation RPC. It now uses a server context endpoint.
4. The database migration restores only the RLS-backed table grants required by existing browser/public storefront and creator workspace flows. Sensitive Sellora billing/content tables remain service-only.
5. The public_products view keeps the base products table protected from anonymous SELECT while using its explicitly filtered/column-restricted public projection for storefront reads.

## Expected result

- `/api/billing/me` authenticates the current user and reads billing data server-side.
- `/api/admin?section=subscriptions` authenticates the platform admin and reads the subscription catalog server-side.
- The creator workspace no longer calls the blocked `sellora_reconcile_my_plan` RPC from the browser.
- Existing RLS policies remain the authorization boundary for direct browser/public operations.

## Verification note

The live Supabase project has the corresponding migration applied. A full Next.js production build was not run in this environment because dependency installation could not complete within the execution environment.
