# Sellora Build 9 + 10

This release builds the operational/financial and trust/security layer on top of Build 6-8.

## Database
Run once on an existing Sellora database:
`supabase/migrations/005_build_9_10.sql`

Do not rerun older migrations.

## Admin access
Set:
`SELLORA_ADMIN_EMAILS=you@example.com`
Use the same email as the authenticated Supabase account. Admin API calls require a valid Supabase session bearer token and an email in this allowlist.

## Current payout model
Sellora continues to use Razorpay Standard Checkout in the current platform-merchant/test-first setup. Razorpay Route/RazorpayX creator settlement is NOT assumed to be enabled. The platform therefore records payout requests/statuses and ledger balances but does not fake an automatic provider transfer. When an approved provider/account supports creator settlement, a provider-specific payout adapter can be added.

## New capabilities
- Financial ledger with idempotent sale/fee/net entries
- Payment fee and platform fee snapshots
- Creator balance and payout history
- Creator verification state tracking
- Super Admin console with creators, verification, products, orders, transactions, payouts, refunds, reports, disputes, domains and audit logs
- Product/creator report submission
- Moderation status controls
- Customer refund request workflow
- Provider refund through Razorpay when configured/eligible
- Dispute workflow
- Audit logging for consequential admin actions
- Custom domain registration + DNS TXT verification
- Security headers/CSP
- Basic rate limiting for public/admin mutation endpoints
- Health endpoint at `/api/health`
- Optional Sentry integration (set SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN)
- Legal policy template pages under `/legal/*`

## Environment additions
See `.env.example` for:
`SELLORA_ADMIN_EMAILS`
`SELLORA_ACCESS_SECRET`
`SENTRY_DSN`
`SENTRY_TRACES_SAMPLE_RATE`
`NEXT_PUBLIC_SENTRY_DSN`
`NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`

## Local setup
Keep `.env.local` out of source control.

Run:
`npm.cmd install`
`npm.cmd run build`
`npm.cmd run dev`

## Production notes
DNS verification is implemented at the application layer, but production routing/SSL issuance for arbitrary creator domains still depends on the hosting provider's domain API and reverse-proxy/CDN configuration. Configure that before advertising custom domains as fully automated.

Replace legal templates with final jurisdiction-specific legal/tax documents before production.


## Build 11 + 12 upgrade

Run once on an existing Sellora database:
`supabase/migrations/006_build_11_12.sql`

New:
- Admin creator detail workspace and platform settings
- Store moderation status controls
- Immutable ledger balance calculation without double-counting gross/seller-net
- Payout request flow with minimum payout and provider-settlement safety
- Provider-neutral payout adapter; unsupported until an approved settlement provider is configured
- Product sales controls: scheduled publishing, purchase/download limits, license requirements
- Product variants, versions, additional product files
- Customer download page supports additional product files through secure short-lived signed URLs

Important:
- `paid` payout state requires a provider settlement reference; Sellora does not fake creator fund transfers.
- Existing Razorpay Standard Checkout remains unchanged.
