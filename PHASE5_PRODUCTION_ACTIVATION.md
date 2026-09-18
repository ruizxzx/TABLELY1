# TABLELY — Phase 5: Production Activation & End-to-End Verification

## Purpose

Phase 5 is an activation and verification phase. It does **not** redesign the order-email architecture and does **not** rewrite existing payment, order, session, staff-notification, or checkout logic.

Phase 5 validates the already-built stack:

- Phase 1 database foundation
- Phase 2 checkout email opt-in + server-side subscription capture
- Phase 3 `send-order-email` Edge Function + Resend integration
- Phase 4 status-event triggers + `pg_net` dispatch + `pg_cron` retry worker

## Frozen/regression-sensitive rule

Do not refactor or clean up unrelated TABLELY code during this phase. Existing Claude fixes and existing order/payment behavior are considered frozen unless a test demonstrates a specific regression in the email feature.

## Phase 5 status

This package adds verification tooling and the production runbook only. No existing application source file is intentionally changed by Phase 5.

## 5.1 Vault verification

The Phase 4 dispatcher requires these two Vault secret names:

- `tablely_order_email_project_url`
- `tablely_order_email_service_role_key`

The verification SQL checks only that each secret exists and is non-empty. It never prints the secret value.

## 5.2 Resend / Edge Function verification

Confirm in **Supabase → Edge Functions → send-order-email → Secrets**:

- `RESEND_API_KEY`
- `RESEND_ORDER_EMAIL_FROM`
- optional `RESEND_REPLY_TO_EMAIL`

Do not commit these values to the repository.

## 5.3 Sender-domain verification

Confirm the sender domain used by `RESEND_ORDER_EMAIL_FROM` is verified in Resend.

Example:

`TABLELY <orders@tablely.in>`

Example reply-to:

`support@tablely.in`

## 5.4 Phase 4 scheduler verification

Confirm the active cron job is exactly:

`tablely-order-email-dispatch`

The Phase 4 implementation schedules it every 30 seconds and uses it to retry queued/failed delivery work and recover stale `SENDING` events.

## 5.5 Phase 2 deployment verification

Deploy the application package containing:

- `components/customer/CustomerCheckoutClient.tsx`
- `lib/customer.ts`
- `app/api/customer/order-email-notifications/route.ts`

No database migration is required for Phase 2.

After deployment, verify the checkout UI contains the email opt-in and only requires an email address when the customer enables order updates.

## 5.6–5.14 controlled end-to-end test

Use a dedicated test table/restaurant or a low-risk test order.

1. Open a customer table QR page.
2. Add an item to the cart.
3. Select **Get updates about your order**.
4. Enter a real test inbox you control.
5. Place an order using a normal supported payment path.
6. Confirm the subscription row exists for that order.
7. Confirm `ORDER_RECEIVED` is created exactly once.
8. Confirm the email reaches the test inbox.
9. Move the order through `ACCEPTED` → `PREPARING` → `READY` → `COMPLETED`.
10. Confirm one event/email per supported status.
11. Repeat with a test order that is cancelled.
12. Repeat with a test order that is rejected, where the existing TABLELY flow allows that status transition.
13. Inspect the event table and `net._http_response` after the tests.
14. Confirm there are no duplicate event rows for the same `(order_id, event_type)`.
15. Confirm the restaurant order and payment flows still behave exactly as before.

## Expected event lifecycle

```text
QUEUED
  ↓
SENDING
  ↓
SENT
```

Failure path:

```text
QUEUED / SENDING
      ↓
    FAILED
      ↓
  retry worker
      ↓
   SENDING
      ↓
     SENT
```

The Phase 3 dispatcher uses the event UUID as its Resend idempotency key, so the same logical event is protected against duplicate logical sends during retries/recovery.

## Read-only operational queries

Use:

`supabase/verification/phase5_order_email_readiness.sql`

for infrastructure checks, and:

`supabase/verification/phase5_order_email_event_checks.sql`

for event/dispatch inspection.

## Web API smoke test

`scripts/phase5-verify-web-order-email.mjs` performs the Phase 2 subscription API call against a supplied deployment URL. It requires no privileged credential.

Example:

```powershell
node scripts/phase5-verify-web-order-email.mjs `
  --base-url https://your-tablely-domain.com `
  --order-id YOUR_ORDER_UUID `
  --tracking-token YOUR_TRACKING_TOKEN `
  --email test@example.com
```

The script does not print or store Supabase service-role keys or Resend API keys.

## Pass criteria

Phase 5 is complete when all of the following are true:

- Both Vault secret names exist and contain non-empty values.
- `pg_net` and `pg_cron` are installed.
- The Phase 4 cron job is active.
- Both Phase 4 email triggers exist.
- The event uniqueness constraint exists.
- Phase 2 API successfully saves an opted-in email subscription.
- `ORDER_RECEIVED` is created once and delivered.
- All supported status events are created and delivered once.
- `CANCELLED` and `REJECTED` work where those statuses are reachable in the existing order flow.
- A controlled failure/retry test does not create duplicate logical sends.
- Existing order/payment/session behavior remains unchanged.

## Security notes

Never expose or commit:

- `RESEND_API_KEY`
- Supabase service-role/secret keys
- Vault decrypted secret values

Phase 5 checks configuration without returning secret contents.
