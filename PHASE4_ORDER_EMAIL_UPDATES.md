# TABLELY — Phase 4: Order status events + automatic dispatch

Phase 4 completes the automatic connection between the TABLELY order lifecycle and the Phase 3 Resend dispatcher.

## What this phase adds

- Supported order status changes automatically create the matching email notification event.
- When the customer subscription is created or re-enabled, TABLELY creates an event for the order's **current** supported status. This avoids a race where the restaurant changes status before the Phase 2 subscription write finishes.
- New events are dispatched asynchronously through `pg_net` to the existing `send-order-email` Edge Function from Phase 3.
- `pg_cron` runs a retry worker every 30 seconds.
- `SENDING` events older than 10 minutes are recovered as `FAILED` for retry.
- `dispatch_requested_at` and `pg_net_request_id` are recorded for delivery infrastructure diagnostics.
- Existing order lifecycle/status functions and existing staff notification triggers are not rewritten.

## Status mapping

| TABLELY order status | Customer email event |
| --- | --- |
| `NEW` | `ORDER_RECEIVED` |
| `ACCEPTED` | `ORDER_ACCEPTED` |
| `PREPARING` | `ORDER_PREPARING` |
| `READY` | `ORDER_READY` |
| `SERVED` | no email event in the Phase 1 model |
| `COMPLETED` | `ORDER_COMPLETED` |
| `CANCELLED` | `ORDER_CANCELLED` |
| `REJECTED` | `ORDER_REJECTED` |

The event table's unique `(order_id, event_type)` constraint remains the primary duplicate-protection mechanism.

## Automatic dispatch architecture

```text
Customer opts in
      ↓
Phase 2 saves subscription
      ↓
Phase 4 subscription trigger
      ↓
Create current-status event
      ↓
pg_net async HTTP request
      ↓
Phase 3 send-order-email Edge Function
      ↓
Resend
```

And for later status changes:

```text
orders.status changes
      ↓
Phase 4 status trigger
      ↓
Create notification event
      ↓
pg_net → send-order-email
```

`pg_net` is specifically designed for asynchronous HTTP requests from Postgres and is suitable for trigger-based external calls. Supabase also documents using `pg_cron` to schedule Edge Function requests and retry work. See:

- https://supabase.com/docs/guides/database/extensions/pg_net
- https://supabase.com/docs/guides/cron
- https://supabase.com/docs/guides/database/vault

## Required secret configuration

The Phase 4 database dispatcher reads two deployment secrets from Supabase Vault.

Create these through **Supabase Dashboard → Database → Vault** or SQL:

```sql
select vault.create_secret(
  '<YOUR_SUPABASE_PROJECT_URL>',
  'tablely_order_email_project_url',
  'Supabase project URL used to invoke the send-order-email Edge Function'
);

select vault.create_secret(
  '<YOUR_SUPABASE_SERVICE_ROLE_KEY>',
  'tablely_order_email_service_role_key',
  'Server-only key used by the database dispatcher to invoke send-order-email'
);
```

Do not place the service-role key in the repository, `.env.example`, customer browser code, or migration source.

Then configure the Phase 3 Edge Function secrets:

```text
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=TABLELY <orders@your-verified-domain>
```

Optional:

```text
RESEND_ORDER_EMAIL_FROM=TABLELY <orders@your-verified-domain>
RESEND_REPLY_TO_EMAIL=...
```

## Important deployment order

Because the user is intentionally staging the whole feature before production rollout, apply/deploy in this order:

1. Phase 1 migrations.
2. Phase 2 application code.
3. Phase 3 `send-order-email` Edge Function.
4. Phase 3 Resend secrets.
5. Phase 4 migration `202609190004_phase4_order_email_status_dispatch.sql`.
6. Phase 4 Vault secrets.
7. Run the complete feature test flow.

The Phase 4 migration creates the `tablely-order-email-dispatch` cron job.

## No changes to existing order lifecycle logic

Phase 4 listens to the existing `orders.status` changes instead of rewriting `transition_order_status`, `reject_order`, `cancel_order`, counter-payment behavior, or any payment flow.

Therefore:

- PAY_AT_COUNTER remains unchanged.
- PAY_NOW remains unchanged.
- PAY_AFTER_DELIVERY remains unchanged.
- Existing staff notifications remain unchanged.
- Existing order events remain unchanged.
- Email infrastructure failure is swallowed by the Phase 4 trigger/queue functions and cannot roll back the restaurant order/status transaction.

## Expected delivery behavior

A new event starts as `QUEUED`.

The Phase 4 dispatcher asynchronously requests the Phase 3 Edge Function.

The Edge Function owns the actual delivery state transition:

```text
QUEUED → SENDING → SENT
                     ↘
                      FAILED
```

`FAILED` events are retried by the 30-second queue worker after a minimum one-minute backoff. Queued pg_net requests that remain unresolved are retried after two minutes.

A stale `SENDING` event is recovered after ten minutes. Phase 3 uses a stable Resend idempotency key based on the notification event UUID, so recovery does not create a second logical send for the same event.

## Operational checks

Confirm the cron job:

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname = 'tablely-order-email-dispatch';
```

Inspect notification work:

```sql
select
  id,
  order_id,
  event_type,
  status,
  attempts,
  dispatch_requested_at,
  pg_net_request_id,
  last_attempt_at,
  sent_at,
  error_message
from public.order_email_notification_events
order by created_at desc
limit 50;
```

Inspect pg_net responses:

```sql
select *
from net._http_response
order by created desc
limit 50;
```

## Phase boundary

Phase 4 is the final wiring layer. It does not redesign the email template system or add customer-facing email-history UI.

Those concerns can be handled later without changing the core order-event model.
