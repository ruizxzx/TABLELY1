# TABLELY BUILD 13 — Authorization Core & Security Hardening

## Scope

Build 13 upgrades the current Build 12 codebase without introducing the later Build 14+ product features.

Authorization is centralized conceptually as:

`user → organization membership → branch membership → role → staff permission → subscription entitlement → operation`

## Implemented in this archive

- Removed the unused fake `app/api/orders/route.ts` demo endpoint.
- Added unified branch/permission helpers for server-side authorization.
- Wired fine-grained permissions into branch, menu, storage, order, payment and analytics paths.
- Restricted `staff_permissions` administration to authorized owners on plans that expose advanced permissions.
- Prevented changing permissions for OWNER staff rows.
- Restricted non-owner branch visibility to the branch the staff member is assigned to; owners retain organization-wide branch visibility.
- Hardened Branch Manager authorization for delegated branch operations.
- Centralized owner staff-to-branch assignment through `assign_staff_to_branch()`.
- Fixed basic-vs-advanced analytics gating: basic analytics uses `ANALYTICS`, advanced analytics uses `ADVANCED_ANALYTICS`, and cross-branch reporting uses `CROSS_BRANCH_REPORTING`.
- Preserved the full Build 12 advanced analytics calculations, including preparation time, service response time and table utilization.
- Corrected cross-branch AOV to use the same paid/non-cancelled population as revenue.
- Added explicit subscription state resolution through a VOLATILE `resolve_subscription_state()` path and kept read-only subscription context functions read-only.
- Removed anonymous execution access to the generic `organization_has_feature()` RPC while preserving the narrow public payment-options RPC.
- Protected custom-domain verification-token reads from non-owners.
- Preserved public customer payment visibility and ordering flows.
- Fixed the custom-domain settings page state bug for DNS verification progress.
- Kept the existing Build 12 staff, branch, analytics, billing, branding, domain and customer flows intact.

## Validation performed

- TypeScript/TSX syntax parsing across the repository: PASS.
- Build 13 SQL structural checks: PASS (balanced parentheses, balanced dollar-quoted function bodies, balanced migration transaction, valid 5-character ERRCODE values in Build 13 migration).
- Static checks for removal of the demo order endpoint and anonymous generic entitlement execution: PASS.
- Static check for direct browser-side staff branch assignment: PASS; application now calls `assign_staff_to_branch()`.

## Environment limitation

A complete `npm run typecheck` / `npm run build` could not be executed in this environment because the uploaded archive does not contain a complete `node_modules` installation and dependency installation could not complete within the available network/runtime window. Live Supabase migration execution was also unavailable because no Supabase CLI/PostgreSQL server is available in the execution environment.

This status therefore distinguishes verified static/syntax checks from runtime checks that require the project's actual Supabase environment and a completed dependency install.
