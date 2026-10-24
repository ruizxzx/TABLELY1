# TABLELY Build 32 implementation and release report

**Release status: Partial implementation; not ready to describe as a complete production Build 32.** The repository contains functioning foundations for all five sub-builds and the changes listed below. Several required product paths and external-provider checks remain unfinished or unavailable. Do not deploy as a complete Build 32 without closing the release gates in [BUILD32_KNOWN_ISSUES.md](./BUILD32_KNOWN_ISSUES.md).

## Feature status

| Sub-build | Status | Implemented in this source tree | Outstanding |
|---|---|---|---|
| 32.1 WhatsApp notifications | Partial | Official Meta Cloud API template sending; restaurant-specific encrypted tokens; per-event settings; separated service/marketing/feedback consent; bounded send retries; signed delivery webhook and opt-out handling. | Embedded Signup, template approval synchronization, verified phone ownership, usage/cost reporting, and full concurrency/rate-limit validation. Live delivery was not tested. |
| 32.2 Loyalty and rewards | Partial | Idempotent paid/completed-order earning; full-refund reversal ledger; configurable earning and expiry; service-role expiry processor; authenticated, restaurant-scoped wallet/history and explicit enrollment/withdrawal at `/customer/loyalty`; order earning requires active recorded customer consent. | Redemption is not part of authoritative checkout/payment quotes; expiry forecasts are not implemented; earning rules do not yet support all required exclusions, caps or partial refunds. |
| 32.3 Automated feedback | Partial | Configurable neutral 1–5 rating and text questions; server-side answer validation; private-feedback triage; the same voluntary Google review link is exposed regardless of rating; separate WhatsApp and email consent; bounded Resend email outbox worker with eligibility/consent rechecks and retries. | Apply the email-delivery migration and configure the cron/Resend secrets before activation; live delivery and submission-concurrency testing, full invitation-frequency/branch controls remain outstanding. |
| 32.4 Multilingual menus | Partial | Existing English/Hindi/Bengali translation tables, editor, language selector and cart-preserving switch are reused; restaurant locale settings and fallback are present. | AI/bulk translation and review workflow are not implemented; all menu subcomponents and client journeys need broader regression tests. |
| 32.5 Google review growth | Partial | Manual Google link/QR mode; OAuth connection; location mapping; paginated sync; review drafts and explicit owner reply publication. | Google API approval and live OAuth/sync/reply testing. OAuth tokens and policy behavior need an authorized provider test environment. |

## Changes included in this delivery

- Completed paid orders can retrieve customer-safe follow-up links using the order tracking token; the customer order page shows private feedback and Google review links as voluntary, independent choices.
- Added a bounded, idempotent loyalty expiry database processor and a `CRON_SECRET`-protected endpoint.
- Added a signed-in customer loyalty wallet/history, resolving the profile from the verified auth user and calculating restaurant-specific balances from that customer's ledger only.
- Added explicit restaurant-scoped loyalty enrollment and withdrawal consent; the follow-up migration prevents orders from silently enrolling customers or earning points without recorded consent.
- Added configurable, neutral feedback survey questions, server-side answer validation and equal Google review access independent of private ratings.
- Added an independent, unchecked email-feedback consent at checkout, distinct from order updates and marketing consent; the order-token-verified API records the consent, supports completed orders, and email invitations include a signed opt-out link.
- Added a scheduled email worker that verifies payment/order state, current customer consent, invitation state and feedback settings before sending through Resend, with bounded retries and stale-claim recovery.
- Added a shared, responsive premium visual layer across marketing, restaurant dashboard, admin, authentication, legal, and customer ordering surfaces, with reduced-motion, reduced-transparency, and high-contrast preferences respected.
- Added contract tests for expiry, loyalty consent, survey questions, neutral review links and feedback email consent/delivery.

## Database and migration status

- `supabase/migrations/20261024020000_build30_referral_partner_management.sql` — existing partner attribution and management schema.
- `supabase/migrations/20261024030000_build32_customer_engagement_retention.sql` — existing Build 32 tenant-keyed engagement schema, RLS, ledger and lifecycle hooks.
- `supabase/migrations/20261024050000_partner_email_only_auth.sql` — existing partner email-only registration change.
- `supabase/migrations/20261024060000_build32_loyalty_expiry_processor.sql` — adds idempotent expired-point ledger entries; callable only by `service_role`.
- `supabase/migrations/20261024063127_build32_loyalty_explicit_consent.sql` — records explicit enrollment/withdrawal consent and gates future point accrual on active consent.
- `supabase/migrations/20261024064200_build32_feedback_email_delivery.sql` — adds separate feedback-email consent fields, permits EMAIL delivery settings, and queues consented completed-order invitations.

The repository's prior Build 32 report says its original Build 30 and Build 32 migrations were applied to the project's Supabase database. That assertion was not independently revalidated in this delivery. The new `20261024060000` expiry, `20261024063127` loyalty-consent and `20261024064200` feedback-email migrations are included but were **not applied to any database**. Do not apply production migrations as part of this ZIP-only delivery; validate and apply them through the project's staging/release process first.

## Verification results for this delivery

- Dependency install: **NOT RUN**; project dependencies were already installed, and no package manifests or lockfiles changed.
- TypeScript (`npm run typecheck`): **PASS**.
- Next.js production build (`npm run build`): **PASS**.
- Build 32 focused contract tests: **PASS** (13/13).
- Full test suite: **FAIL** with 58/59 passing on the existing migration-integrity check; the repository has historical duplicate versions and invalid migration timestamps, including `20260922240000_repair_approved_product_visibility.sql`.
- Migration preflight: **FAIL** on pre-existing duplicate/invalid migration filenames. The added migration's timestamp is unique and ordered after the existing `20261024050000` migration.
- ESLint: **FAIL before source linting** due to the repository's existing ESLint 9 legacy-config circular-structure error.
- Live Meta WhatsApp, Google OAuth/API, real message delivery, and external review publication: **NOT RUN**; no authorized provider credentials/test accounts were supplied.
- Production database migration, RLS integration checks, and full end-to-end/regression suite: **NOT RUN**.
- ZIP content and archive integrity: **PASS**; the refreshed 742-entry archive includes the checkout consent UI/API, Resend feedback worker, signed email opt-out route, email-delivery migration, survey editor, tests, shared premium UI theme, and updated report. Archive checks found no duplicate entries, `.env.local`, dependency directories, build output, or excluded cache entries.

Focused Build 32 tests:

```powershell
node --experimental-strip-types --test tests\build32-contract.test.mjs
```

## Security notes

The current implementation stores restaurant provider credentials encrypted and omits full tokens from browser responses. Build 32 tables use RLS with browser-role grants revoked, and application routes resolve restaurant context before privileged access. Customer communication consent purposes remain separate. Static contracts do not substitute for RLS penetration/integration testing. The existing Supabase security advisor finding for `public.rate_limit_buckets` with RLS disabled remains a separate release concern.

See [BUILD32_SETUP.md](./BUILD32_SETUP.md) for setup and deployment notes, and [BUILD32_KNOWN_ISSUES.md](./BUILD32_KNOWN_ISSUES.md) for remaining work.
