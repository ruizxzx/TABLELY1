# SELLORA Build 6 — Resend + Customer Accounts

Implemented on the production baseline:

- All application transactional emails route through the server-side Resend API.
- Supabase Auth remains the identity provider; its confirmation/recovery/magic-link delivery is intended to use Resend SMTP once configured in Supabase Auth.
- Checkout requires an email address.
- Authenticated checkout sends the Supabase access token to the server and associates the order with the authenticated profile.
- Guest orders are retained by email and are automatically linked to the account when that email later signs up.
- Customer account page: `/account`.
- Customer order history API: `/api/account/orders`.
- Password login, magic-link login and forgot-password UI are available.
- Auth callback: `/auth/callback`.
- Password reset page: `/reset-password`.
- Purchase emails contain direct secure download links for each purchased order item.
- Uploaded files continue to use short-lived Supabase Storage signed URLs.
- External delivery links continue through the authorized Sellora download endpoint.
- Download entitlement, expiry, revocation and download limits remain enforced server-side.
- `sellora_email_events` provides email audit/idempotency state and provider message IDs.
- Failed email events can be retried by `/api/cron/email`; Vercel cron is configured hourly.
- Resend API calls include an idempotency key.

## Operator setup still required

### Vercel/server environment

```text
RESEND_API_KEY=<Resend sending API key>
RESEND_FROM_EMAIL=<verified sender, e.g. SELLORA <noreply@yourdomain.com>>
RESEND_REPLY_TO=<optional support address>
NEXT_PUBLIC_APP_URL=https://<production-domain>
SELLORA_CRON_SECRET=<strong random secret>
```

Keep `RESEND_API_KEY` server-side only.

### Supabase Auth → Resend SMTP

Use the Supabase Auth SMTP settings for the same Resend account/domain:

- SMTP host: `smtp.resend.com`
- SMTP port: `465` (SSL) or `587` (STARTTLS)
- SMTP username: `resend`
- SMTP password: the Resend API key
- Sender email: the verified SELLORA sender
- Sender name: `SELLORA`

### Domain

Put the domain on Cloudflare and add the exact DNS records Resend provides for domain verification. Cloudflare Email Routing is for inbound/forwarding mail; Resend remains the outbound sender.

### Supabase Auth URLs

Set the production Site URL and allow the production callback URL:

```text
https://<production-domain>/auth/callback
```

Password recovery returns through:

```text
https://<production-domain>/auth/callback?next=/reset-password
```

### Security

Enable Supabase leaked-password protection before public launch.

## E2E verification checklist

1. Sign up → confirmation email arrives via Resend.
2. Confirm email → callback → onboarding.
3. Password login → account page.
4. Magic link → callback → account page.
5. Forgot password → reset email → new password.
6. Guest purchase → order stored with email.
7. Later account creation with same email → guest order linked.
8. Authenticated purchase → order has `customer_id`.
9. Purchase confirmation email arrives via Resend.
10. Purchase email has a direct download button.
11. Download respects expiry, revocation and limits.
12. Account order history remains after logout/login and on another device.
13. Resend failure does not roll back a successful payment/order.
14. Failed email appears in `sellora_email_events` and is retried by cron.
