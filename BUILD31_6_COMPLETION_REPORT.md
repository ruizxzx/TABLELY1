# TABLELY Build 31.6 Completion Report

## Included implementation

- Restaurant-to-TABLELY support tickets, platform admin inbox, private internal notes, and audit records.
- Customer-to-restaurant text chat from the public table ordering page.
- Private Supabase Realtime Broadcast topics for each customer visit and authorized restaurant branch inbox.
- PostgreSQL-backed messages, idempotent client message IDs, visit-token authorization, branch-scoped staff access, and catch-up after connection recovery/page resume.
- Customer chat does not create a persistent table session. Starting a new visit resets the local chat identity.
- Customer message support is separated from the existing platform support ticket tables and APIs.

The current customer chat does not yet include typing indicators, Presence, read receipts, attachments, or email/WhatsApp notifications. These features are not reported as complete.

## Verification results

| Check | Result | Evidence |
| --- | --- | --- |
| Dependency installation from lockfile | NOT RUN | Dependencies were already present; PowerShell blocked `npm` execution with an AuthorizationManager error. |
| TypeScript typecheck | PASS | `node .\\node_modules\\typescript\\bin\\tsc --noEmit` |
| ESLint on changed files | FAIL | ESLint 9.39.5 failed while loading the existing configuration with a circular-structure `TypeError`. |
| Focused Build 31.6 tests | PASS | `node --experimental-strip-types --test .\\tests\\build31_6-support.test.mjs` (6 tests). |
| Migration filename preflight | FAIL (baseline issues) | Existing duplicate migration versions and malformed historical filenames reported by `scripts/check-supabase-migration-versions.mjs`; the new migration uses version `20261024090000`. |
| Migration execution / RLS-Realtime integration | NOT RUN | No staging database was used; migration was not applied. |
| Customer browser / WebSocket end-to-end tests | BLOCKED | Requires a staging Supabase project and separate browser contexts. |
| Attachment security tests | NOT RUN | Attachments are not implemented. |
| Full regression suite | FAIL | 66 of 69 passed. Failures were in historical migration filename integrity and Build 32 contract expectations, outside the new chat tests. |
| Next.js production build | BLOCKED | Compilation and TypeScript completed; prerendering then failed with `EPERM` creating a nested directory under `.next\\server\\app\\bento-preview.segments`. |
| ZIP archive readability | PASS | Archive listing was checked with `tar -tf`. |

## Delivery

The source ZIP is `TABLELY_BUILD_31_6_COMPLETE.zip`. It excludes local dependencies, build caches, and `.env.local`; it includes application source, migrations, tests, lockfile, configuration templates, and this report.

## Staging requirements

Before deployment, apply the additive customer-chat migration to a development/staging Supabase project, enable private Realtime Broadcast, then verify channel authorization, multiple visits on one table, reconnect catch-up, and staff branch permissions with separate browser contexts. The migration has not been applied to production.
