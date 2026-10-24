# TABLELY Production Runbook

Legacy database object names and selected environment-variable prefixes are retained for deployed compatibility. Do not rename them without a coordinated migration and deployment update.

## Deployment order

1. Push the application and active Supabase migrations.
2. Configure environment variables.
3. Enable Supabase Auth leaked-password protection.
4. Configure Resend sender/domain and verify transactional email.
5. Configure TABLELY-owned Razorpay subscription credentials.
6. Configure creator-connected Razorpay webhooks for product sales.
7. Configure `/api/webhooks/razorpay-billing` for TABLELY subscription webhooks.
8. Configure Vercel Cron with `SELLORA_CRON_SECRET`/`CRON_SECRET`. The Vercel Hobby/free-compatible schedule runs `/api/cron/daily` once per day; the email and billing routes remain available for authorized manual runs.
9. Configure production domain/HTTPS.
10. Run the Build 3/4/5 acceptance matrix.

## Razorpay separation

There are two credential planes:

- Creator product sales: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (creator-connected BYOK).
- TABLELY SaaS billing: `SELLORA_BILLING_RAZORPAY_*` (legacy variable prefix; TABLELY-owned merchant account).

Never put either secret in a `NEXT_PUBLIC_*` variable or client bundle.

## Admin pricing reprovisioning

Use Admin → Subscriptions. Change the rupee price and press `Save & Reprovision`. The server creates a new Razorpay plan version, retires the previous version, updates TABLELY's current catalog price, and schedules existing subscribers on that plan to move at cycle end. Historical subscription rows retain their provider plan version.

A paid plan cannot be set to ₹0; Free remains ₹0. Reprovisioning requires valid TABLELY billing Razorpay credentials in the deployment environment.

## Build 5 acceptance

### Commerce

Test success, failure, cancel, timeout, duplicate checkout, duplicate webhook, delayed webhook, full refund, partial refund, creator credential disconnect/replacement, archived product, and existing buyer access.

### Subscriptions

Test new subscription, renewal, failed renewal, halt/grace period, cancellation, upgrade, downgrade, price reprovisioning, scheduled provider-plan changes, admin trial/grant precedence, and grant revocation.

### Delivery

Test upload delivery, external-link delivery, signed-url expiry, download limits, refunded orders, revoked delivery and access after product archival.

### Operations

Verify webhook logs, audit logs, health endpoint, admin access, error monitoring, backups, email delivery, domain/HTTPS, and secret rotation procedure.

## Customer accounts + Resend email delivery (Build 6)

### What is implemented
- Application transactional email is centralized through Resend from the server only.
- Email delivery events are recorded in `public.sellora_email_events` with idempotency, provider message ID, status, attempts and failure details.
- Failed email events can be retried by `/api/cron/email`; Vercel cron is configured hourly.
- Customer email is required at checkout.
- Authenticated purchases are linked to `public.orders.customer_id`.
- Guest purchases made with the same email are automatically linked when that email later creates an account.
- Customers can access `/account` to see persistent order history and authorized downloads.
- Purchase emails include direct secure download links for purchased digital products.
- Existing signed-download checks, download limits, expiry and revocation remain server-side.
- Login supports password, magic link and password recovery UI.
- Supabase Auth remains responsible for identity/session/token issuance.

### Required production configuration by the operator
1. Create a Resend account and create an API key. Store it only as `RESEND_API_KEY` in the server/Vercel environment.
2. Configure the registered TABLELY production domain.
3. Put the domain's DNS on Cloudflare.
4. Add the exact DNS records shown by Resend for domain verification (SPF/DKIM and any additional records Resend requests). Do not invent values.
5. Set `RESEND_FROM_EMAIL` to a sender on the verified domain, for example `TABLELY <noreply@yourdomain.com>`.
6. Optionally set `RESEND_REPLY_TO` to the support address.
7. Set `NEXT_PUBLIC_APP_URL` to the production HTTPS URL. This is used in authentication links and purchase/download emails.
8. Set `SELLORA_CRON_SECRET` in Vercel. The email retry cron uses the same secret.
9. Configure Supabase Auth email delivery separately so verification, password-reset and magic-link messages are delivered through the Resend SMTP integration. The application code cannot securely replace Supabase Auth's managed delivery path by exposing a Resend API key to the browser.
10. Set the Supabase Auth Site URL and redirect URLs to include the production callback, e.g. `/auth/callback`, and the password-reset destination `/reset-password`.
11. Enable Supabase leaked-password protection before public launch.

### Important Cloudflare distinction
Cloudflare DNS is used to publish the Resend authentication records. Cloudflare Email Routing is for receiving/forwarding mail and is not the outbound transactional email provider. Resend remains responsible for sending TABLELY mail.

### Final E2E tests
- Signup verification email arrives through the verified domain.
- Password reset email arrives and changes the password.
- Magic-link email signs the customer in and opens the account page.
- Guest checkout stores the purchase email.
- Authenticated checkout links the order to the account.
- Guest purchase becomes visible after later account creation with the same email.
- Successful purchase email contains a working direct download button.
- Download link enforces entitlement, expiry, revocation and download limits.
- Customer order history persists after logout/login and on another device.
- Resend failures do not fail a successful payment/order.
- Failed emails appear in `sellora_email_events` and retry through the hourly cron.
