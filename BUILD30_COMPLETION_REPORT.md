# TABLELY Build 30 — Referral & Partner Management

## Implemented

- Public partner registration at `/partners`, with required contact and location fields, category, agreement acceptance, email confirmation, and phone OTP verification.
- Partner-specific referral links at `/join?ref=...`, click logging, and first-party 30-day first-click attribution.
- Restaurant onboarding attribution, duplicate/self-referral checks, a business verification queue, and restaurant/account cross-checking in the admin panel.
- Plan-level commission rules and partner/plan overrides. Commission ledger rows snapshot the qualifying subscription payment, plan, and rate.
- Billing-event commission handling and refund/chargeback adjustments with idempotency protection.
- Partner dashboard at `/partners/dashboard` with referral link/QR, referral and earnings history, and payout detail submission.
- Admin partner management at `/admin/partners`, including applications, restaurant verification, tracking, commission settings, payout approvals, transfer references, private proof uploads, reports, and audit history.
- Partner payout details are encrypted server-side. Payout evidence uses a private Supabase Storage bucket.

## Database migration

The migration is `supabase/migrations/20261024020000_build30_referral_partner_management.sql`. It is a local project file and **has not been applied to Supabase**. Review it and apply it with the normal Supabase migration workflow after confirming the target project.

`npm run check:migrations` currently reports existing migration history problems: duplicate versions `202609160013`, `202609170015`, `202609170016`, `202609170018`, `202609180031`, plus older invalid filenames (`20260922240000`, `20260922250000`, `20260922251000`, and `RUN_THIS_NOW_hotfix_202609170018.sql`). The new Build 30 migration has a valid, unique 14-digit version. Resolve the historical naming conflicts before relying on the repository-wide migration preflight or pushing all pending migrations.

## Configuration and activation

- Configure Supabase Auth email confirmation and an SMS provider that supports phone OTP. Add the production `/auth/callback` URL to the Supabase Auth redirect allowlist.
- Set `TABLELY_PARTNER_ENCRYPTION_KEY` to a strong server-only secret of at least 24 characters (or use the existing `TABLELY_ENCRYPTION_KEY` fallback). Do not expose it to browser code.
- Apply the Build 30 migration before using partner registration, dashboards, attribution, or admin tools.
- The database migration seeds illustrative commission rates for known plans; admins can change them in Partner management → Settings.

## Verification

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `npm run check:migrations` — blocked by the pre-existing filename/version conflicts listed above.
- No tests or live Supabase migration were run.
