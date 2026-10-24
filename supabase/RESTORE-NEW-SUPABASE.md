# Sellora — Fresh Supabase Restoration

This repository is the production restoration baseline for Sellora.

## Source of truth

The active migration chain is cumulative and is safe for a brand-new Supabase project:

- `20260919142522_sellora_build3_fresh_baseline.sql` — complete Build 3 schema/security baseline
- `20260919142548_sellora_build3_security_advisor_hardening.sql` — compatibility/no-op marker; hardening is included in the baseline
- `20260919142600_sellora_build3_function_execute_hardening.sql` — compatibility/no-op marker; execute hardening is included in the baseline
- `20260919153036_sellora_build4_build5_production.sql` — subscriptions, billing, dynamic plan pricing, entitlement synchronization and Build 5 hardening

`supabase/legacy_migrations/` contains the historical incremental migrations for reference only. Do not run them separately on a fresh installation.

## Restore a new project

1. Create a new Supabase project.
2. Extract this repository.
3. Run `supabase init` if `supabase/config.toml` does not exist.
4. Link the project: `supabase link --project-ref <PROJECT_REF>`.
5. Run `supabase migration list`.
6. Run `supabase db push --dry-run`.
7. Confirm the four active migrations above are the only pending migrations.
8. Run `supabase db push`.

Do not run `schema.sql` followed by `supabase db push`. Do not run legacy migrations separately.

## Production environment

Set the Supabase URL/key, server-only secret, Sellora access/encryption secrets, Sellora-owned Razorpay billing credentials, creator-connected Razorpay settings, transactional email, admin allow-list, cron secret, and monitoring variables in the deployment platform.

For live Sellora subscriptions, `SELLORA_BILLING_RAZORPAY_MODE=live` requires live Razorpay keys. Creator product-sale credentials remain creator-specific and are separate from Sellora's subscription billing credentials.
