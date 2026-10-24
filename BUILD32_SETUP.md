# TABLELY Build 32 setup and operations

Build 32 adds customer engagement and review operations to the existing restaurant, branch, order, customer and translation data model. The production migration is `supabase/migrations/20261024030000_build32_customer_engagement_retention.sql`.

## WhatsApp Cloud API

Each restaurant supplies its own WhatsApp Business Account ID, phone-number ID and permanent access token in **Customer Engagement → WhatsApp**. TABLELY encrypts the token with the existing `TABLELY_ENCRYPTION_KEY` before storing it, never returns the token to the browser, and sends using that restaurant's phone-number ID. Each restaurant is responsible for Meta messaging charges.

Configure these server-only values:

- `TABLELY_ENCRYPTION_KEY`: the existing base64-encoded 32-byte key used by TABLELY secret encryption.
- `META_GRAPH_API_VERSION`: a supported Graph API version.
- `META_APP_SECRET`: validates `X-Hub-Signature-256` on webhook POSTs.
- `META_WEBHOOK_VERIFY_TOKEN`: verifies the webhook GET handshake.
- `META_FEEDBACK_TEMPLATE_NAME` and `META_REVIEW_TEMPLATE_NAME`: approved templates for those message types when no per-event template is configured.
- `CRON_SECRET`: protects the engagement workers, including `POST /api/cron/customer-engagement` and `POST /api/cron/customer-engagement-email`.
- `APP_URL` or `NEXT_PUBLIC_SITE_URL`: public site origin used in invitation links.
- `RESEND_API_KEY` and `RESEND_FROM_EMAIL`: server-only credentials for consented feedback email invitations.

Register `/api/webhooks/meta-whatsapp` in Meta. Select approved utility templates for order events. The order-template body variables must be approved in this order: customer name, order number, restaurant name, status, amount. Feedback and review invitation templates use customer name followed by the invitation URL. The queue sends templates only; do not configure promotional content as utility traffic. Customers can withdraw consent with STOP, UNSUBSCRIBE or CANCEL; all WhatsApp consent purposes are withdrawn and queued messages are cancelled. Email consent remains independent. WhatsApp service, marketing and feedback choices are separate and start unchecked at checkout. No real message is sent by the automated tests.

## Loyalty

Owners configure earning rate, point value and optional expiry. Paid orders in SERVED or COMPLETED state earn `floor(order total × points_per_currency)` points once. A full refund records an equal negative ledger entry. Partial restaurant-order refunds are not currently supported by the checkout/payment schema and do not yet adjust loyalty points. The ledger is append-only by application convention and duplicate earning/reversal keys are constrained by the database. Expiry timestamps are recorded on earned entries.

An expiry processor is included in `20261024060000_build32_loyalty_expiry_processor.sql` and exposed at `POST /api/cron/loyalty-expiry`. Apply the migration in staging, then schedule a bounded caller with `Authorization: Bearer <CRON_SECRET>`. The service-role database function writes an idempotent expiry ledger entry for each expired earning lot and accounts for linked reversals. Review its behavior against the production ledger before rollout.

Signed-in customers can view restaurant-scoped points and recent ledger activity at `/customer/loyalty`. The server resolves the customer profile from the verified auth user and does not accept a client-supplied customer ID. Customers explicitly opt into each restaurant program on that page; they may withdraw later, which stops future accrual without deleting history. `20261024063127_build32_loyalty_explicit_consent.sql` adds an append-only consent event history and changes the order trigger to award points only while that consent is active. Apply this migration before enabling the enrollment UI. The wallet excludes expired earning lots before the scheduled processor records an expiry entry. It is capped at 10,000 ledger entries per customer account and returns an explicit error if that limit is exceeded. Guest visits are not merged into an authenticated wallet.

Reward redemption is not enabled because it is not yet part of the existing server-authoritative checkout and payment-attempt quote. The UI intentionally does not apply a client-side discount. Expiry forecasts and automated reconciliation metrics are still outstanding.

## Feedback and languages

Private feedback is available to customers through invitation URLs and can be triaged by staff with settings access for the selected branch. Owners can select overall rating, food quality, service quality, cleanliness, waiting time, value for money and written-comment questions. The overall experience rating is always required and uses a neutral 1–5 scale. The server validates answers against the enabled questions. Every feedback recipient sees the same voluntary Google review link regardless of private rating; the choices are not filtered by sentiment. Configure a delay and choose in-app, WhatsApp or email. WhatsApp and email feedback invitations require separate, unchecked checkout consent. The email worker rechecks paid/completed order state, invitation state and current consent before sending through Resend; retries are bounded. Every feedback email includes a signed link to withdraw future email consent. Apply `20261024064200_build32_feedback_email_delivery.sql` before selecting email delivery and schedule the protected email worker. Restaurant default/enabled locale settings now control the public menu language selector. Translation entry is manual and reviewed; AI/bulk translation generation is not available.

## Google Business Profile

Manual Google review link and QR mode works without API access. Automated synchronization and replies require approved Google Business Profile API access, OAuth client ID/secret, and a verified location mapping for every branch. Owners connect via OAuth, map a location, synchronize reviews and explicitly approve each reply before publication. Review invitations do not create reviews, filter by sentiment, or offer incentives.

## Database, access and deployment

The Build 32 migration creates tenant-keyed configuration, queue, loyalty, feedback and Google review records. Engagement dashboard access requires owner/settings permission, and private records and triage updates are scoped to the selected branch. `20261024070000_build32_metrics_language_phone_hardening.sql` adds exact branch aggregates, an anonymous-contact unique key, and the public table language-settings function. Apply this additive migration after the existing Build 32 migrations. New tables have RLS enabled and browser-role grants revoked; server routes resolve restaurant membership before using the service client. Order-side work is idempotent and asynchronous notifications do not block checkout. The Build 30 partner migration is `20261024020000_build30_referral_partner_management.sql`.

Apply migrations in timestamp order using the Supabase migration workflow. Configure a scheduled caller for `/api/cron/customer-engagement` with `Authorization: Bearer $CRON_SECRET`. Set provider credentials only in server-side deployment secrets; never commit `.env.local`.

The email feedback migration is `supabase/migrations/20261024064200_build32_feedback_email_delivery.sql`. After validating and applying it, schedule `POST /api/cron/customer-engagement-email` with the cron authorization, and configure `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and an HTTPS `APP_URL` (or `NEXT_PUBLIC_SITE_URL`). The worker sends only for active, explicit feedback-email consent and rechecks the paid/completed order before delivery.

## Troubleshooting

- WhatsApp messages stay queued: check the restaurant connection state, customer consent, event toggle, approved template name/language, cron secret and Graph API version.
- WhatsApp connection test fails: verify the token has the required WhatsApp permissions and the phone-number ID belongs to that restaurant's business account.
- Google OAuth fails: verify redirect URI and approved Business Profile API access; Google may require project approval before calls work.
- Google reviews are absent: reconnect if authorization was revoked and verify the mapped branch location.
- Engagement page returns a database configuration error: confirm Build 32 migration is present and `TABLELY_ENCRYPTION_KEY` matches the key used to encrypt stored credentials.
- AI translation is not available: use the existing reviewed translation editor.

## Build 32 remediation release gates

Repository migration preflight currently fails on historical duplicate and invalid migration filenames. Do not rename files that may already be recorded in a deployed migration ledger. Reconcile the staging ledger against the actual database first, then apply and verify the pending additive migrations, including `20261024070000_build32_metrics_language_phone_hardening.sql`. These migrations were not applied to staging during this remediation.

Engagement metrics are now exact and branch-scoped. Static contract tests cover authorization, branch filters, WhatsApp withdrawal/status ordering, and locale selection, but live provider and browser verification still require authorized Meta, Google, Resend, and staging environments.
