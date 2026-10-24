# Sellora V1 — Fresh Supabase Restoration

This repository is the production-oriented Sellora V1 baseline. It restores Builds 1–3 and includes the Build 4 subscription/billing layer and Build 5 hardening work.

## Active migration chain

For a brand-new Supabase project, the active migration directory contains exactly these cumulative/ordered migrations:

1. `20260919142522_sellora_build3_fresh_baseline.sql`
2. `20260919142548_sellora_build3_security_advisor_hardening.sql`
3. `20260919142600_sellora_build3_function_execute_hardening.sql`
4. `20260919153036_sellora_build4_build5_production.sql`
5. `20260919153058_sellora_build5_security_final.sql`

The historical incremental migrations are preserved under `supabase/legacy_migrations/` and must not be pushed into a fresh database separately.

## Restore

```powershell
supabase login
supabase link --project-ref YOUR_NEW_SELLORA_PROJECT_REF
supabase migration list
supabase db push --dry-run
supabase db push
```

The dry run should show the five active migrations above when the remote project is fresh.

Do not run `schema.sql` and then run `supabase db push`; choose the migration-based restore path. `supabase/schema.sql` is retained as a cumulative reference/fallback.

## Sellora V1 billing

Sellora subscriptions use a separate Sellora-owned Razorpay account. Product sales continue to use creator-connected Razorpay credentials (BYOK). These credential sets must never be mixed.

Administrators can edit paid-plan prices from **Admin → Subscriptions**. Reprovisioning creates a new immutable `sellora_plan_versions` row/provider plan, updates the public catalog price, and schedules existing active subscribers onto the new provider plan at the end of their current cycle.

## Required production configuration

Set the following server-side variables before enabling production billing:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SECRET_KEY`
- `SELLORA_ACCESS_SECRET`
- `SELLORA_PAYMENT_ENCRYPTION_KEY`
- `SELLORA_BILLING_RAZORPAY_KEY_ID`
- `SELLORA_BILLING_RAZORPAY_KEY_SECRET`
- `SELLORA_BILLING_RAZORPAY_WEBHOOK_SECRET`
- `SELLORA_BILLING_RAZORPAY_MODE`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `SELLORA_ADMIN_EMAILS` or `SELLORA_ADMIN_USER_IDS`
- `SELLORA_CRON_SECRET`

Use test Razorpay credentials while validating the complete Build 3 + Build 4 payment lifecycle; switch the billing mode and provider webhook configuration only after the test path is confirmed.
