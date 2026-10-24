# TABLELY BUILD 12 STATUS

## Implemented

- Multi-branch management page at `/branches`
- Owner-only branch creation with `MULTI_BRANCH` entitlement and `max_branches` enforcement
- Branch edit/activate/deactivate settings with at-least-one-active-branch protection
- Safe branch switcher in the restaurant Studio header
- Non-owner branch visibility limited to branches where the staff user has an active membership
- Branch-specific staff assignment controls in `/staff`
- Advanced staff permission matrix at `/staff/permissions`
- Database-backed fine-grained permissions and owner-only permission mutation RPC
- Advanced analytics at `/analytics`
  - Historical ranges: today / 7d / 30d / 90d
  - Revenue and order volume
  - Cancellation rate
  - Peak hours
  - Top products
  - Table utilization
  - Average preparation time from order events
  - Average service-request response time
  - Cross-branch comparison for owners, separately gated by `CROSS_BRANCH_REPORTING`
- Custom branding studio at `/settings/branding`
  - Logo URL
  - Brand colors
  - Customer theme
  - Menu header
  - Live preview
  - Server-side `CUSTOM_BRANDING` entitlement enforcement
- Customer ordering shell now loads public organization branding and applies the brand color system
- Custom domain management at `/settings/domain`
  - Domain registration
  - TXT verification token
  - DNS verification API
  - Verified-domain host rewrite for customer `/table/<tableCode>` entry paths
  - Server-side `CUSTOM_DOMAIN` entitlement enforcement
- Build 12 database migration added at `supabase/migrations/202609150030_build12_multi_branch_analytics_branding_permissions.sql`

## Security boundaries added

- Branch creation and branch changes are owner-only and entitlement-gated.
- Advanced permissions are owner-managed and organization-scoped.
- Advanced analytics validates branch membership and plan entitlement in the database.
- Cross-branch analytics is owner-only and separately entitlement-gated.
- Branding changes use a security-definer RPC with owner + entitlement checks.
- Domain creation and verification are organization-scoped.
- Custom-domain host lookup only returns active, verified domains.

## Validation

- Static source integrity checks passed for all changed TypeScript/TSX files (balanced delimiters and no detected malformed markers).
- Full `npm run typecheck` / `npm run build` could not be completed in this workspace because the uploaded archive does not contain a usable dependency installation and the environment could not populate the missing packages from npm. The global TypeScript compiler reached the project config but reported missing type-definition packages (`node`, `react`, `react-dom`, `qrcode`, `phoenix`, `ws`).
- Browser-authenticated regression, live Supabase migration execution, DNS verification, and Razorpay provider tests still require the project's external environment/credentials.

## Build 12 deployment sequence

1. Apply the Build 12 migration to the linked Supabase project.
2. Run `npm ci` in the normal development/deployment environment.
3. Run `npm run typecheck` and `npm run build`.
4. Test each staff role, branch switching, cross-tenant isolation, plan gates, customer branding, and verified-domain routing.
5. Configure the custom domain at the hosting provider and publish the TXT verification record before using `/table/<tableCode>` on that host.
