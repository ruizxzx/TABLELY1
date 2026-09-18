# TABLELY — Phase 3: Server-side Resend infrastructure

Phase 3 adds the server-side transactional email dispatcher for the Phase 1/2 order email feature.

## Included

- Supabase Edge Function: `send-order-email`
- Resend Email API via server-side `fetch()` (no Resend npm dependency)
- Resend `Idempotency-Key` based on the notification event UUID
- Atomic event claim: `QUEUED`/`FAILED` -> `SENDING`
- Successful delivery: `SENDING` -> `SENT`
- Failed delivery: `SENDING` -> `FAILED`
- Attempt counter and timestamps are recorded in the Phase 1 event table
- Recipient comes from the server-side notification event/subscription data
- Order/branch/restaurant information is loaded server-side
- HTML is escaped before rendering
- `RESEND_ORDER_EMAIL_FROM` with fallback to `RESEND_FROM_EMAIL`
- Optional `RESEND_REPLY_TO_EMAIL`
- JWT verification enabled on the Edge Function
- Additional `service_role` claim check prevents normal customers/staff from invoking the dispatcher

## Production secrets

Set these in Supabase Edge Function secrets:

```text
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=TABLELY <orders@your-verified-domain>
```

Optional:

```text
RESEND_ORDER_EMAIL_FROM=TABLELY <orders@your-verified-domain>
RESEND_REPLY_TO_EMAIL=...
```

Supabase makes production Edge Function secrets available through environment variables and they can be changed without redeploying the function.

## Invocation

POST JSON:

```json
{
  "event_id": "<notification-event-uuid>"
}
```

The dispatcher expects an existing notification event in `QUEUED` or `FAILED` state. A `SENT` event is treated idempotently.

The Resend request uses:

```text
Idempotency-Key: tablely-order-email/<event-id>
```

This gives the same logical notification a stable Resend idempotency key across retries.

## Phase boundary

Phase 3 does not create notification events automatically, hook into order status changes, add a scheduler/cron, or change checkout/payment behavior. Phase 4 will connect TABLELY order status transitions to the notification event queue and dispatcher.

A small generic transactional renderer is included so the dispatcher is operational; Phase 5 can replace it with the final branded email templates.
