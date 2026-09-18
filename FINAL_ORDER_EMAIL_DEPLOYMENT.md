# TABLELY Order Email — Final Phases 5–8 Deployment

## Completed by this release

- Phase 5 final email templates implemented in `send-order-email`.
- Phase 6 retry/idempotency/error handling preserved and audited; already present in live Phase 3/4.
- Phase 7 tokenized `View order` link implemented using the existing high-entropy `orders.tracking_token`.
- Phase 8 QA matrix and read-only production inspection SQL added.
- Root Next.js `tsconfig.json` excludes `supabase/functions` so Vercel does not type-check Deno Edge Functions.
- Live Supabase Edge Function `send-order-email` updated to version 5.

## Required external actions

1. In Supabase Edge Functions > `send-order-email` > Secrets, ensure:
   - `RESEND_API_KEY`
   - `RESEND_ORDER_EMAIL_FROM` (or `RESEND_FROM_EMAIL`)
   - optional `RESEND_REPLY_TO_EMAIL`
2. Ensure the Resend sender domain is verified.
3. Push this repository to GitHub and deploy to Vercel. The `tsconfig.json` change fixes the previously observed Vercel failure where Deno files were incorrectly type-checked.
4. Create one controlled customer order using a test inbox and enable "Get updates about your order".
5. Verify the event sequence and the View order link.

## No new DB migration

Phases 5–8 require no new production schema migration. Phase 4 already provides the event triggers, dispatcher, retry worker, `pg_net`, `pg_cron`, and uniqueness protection.

## Final live test sequence

NEW → ACCEPTED → PREPARING → READY → COMPLETED

Then repeat once for CANCELLED and once for REJECTED where the existing order flow supports those states.

Use `supabase/verification/phase5_8_order_email_qa.sql` after each test batch.
