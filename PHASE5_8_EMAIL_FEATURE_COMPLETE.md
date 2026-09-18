# TABLELY Order Email — Phases 5–8 Completion

## Scope
This package completes the remaining application-side work for the TABLELY customer order email feature without rewriting existing order, payment, session, coupon, or staff-notification logic.

### Phase 5 — Email templates
Completed in `supabase/functions/send-order-email/index.ts`.

- Branded transactional HTML email layout.
- Per-status titles and status badge.
- Restaurant name, order number, table number, and total.
- Cancellation/rejection reason when available.
- Plain-text fallback.
- Stable subject format.
- Transactional footer.
- `View order` CTA.

### Phase 6 — Retry / idempotency / error handling
Already implemented in the live Phase 3/4 architecture and preserved unchanged.

- `QUEUED → SENDING → SENT` lifecycle.
- Failures become `FAILED`.
- Attempt counter and attempt timestamps.
- Phase 4 queue worker retries failed work.
- Stale `SENDING` rows are recovered.
- Atomic status claim prevents concurrent duplicate processing.
- Stable Resend `Idempotency-Key: tablely-order-email/<event-id>`.
- Duplicate database events prevented by `(order_id, event_type)` uniqueness.

No new retry migration is added because this functionality is already present in the live Phase 4 database.

### Phase 7 — Secure View order link
Completed using the existing TABLELY `tracking_token` as the order's bearer secret.

The email links directly to:

`https://www.tablely.in/r/<restaurant-slug>/table/<table-code>/order/<tracking-token>`

Properties:

- No order UUID is exposed in the email link.
- The tracking token is already generated as a high-entropy random order secret.
- The existing customer order page verifies restaurant/table context and loads the order using the tracking token.
- No new database token table or migration is required.
- `TABLELY_PUBLIC_APP_URL` may override the default public host in the Edge Function environment.

### Phase 8 — Full testing
Added read-only QA/inspection material. Production delivery testing still requires a real customer order and a real Resend inbox because those are external side effects.

The QA checklist covers:

- guest checkout
- Pay at Counter
- Pay Now / Razorpay
- Pay After Delivery
- cancellation
- rejection
- repeated status updates
- duplicate event protection
- retry/recovery inspection
- multiple restaurants / branches
- email link correctness
- no regression in order/payment flows

## Deployment changes

- Supabase Edge Function `send-order-email` updated for the final templates and order link.
- No database schema migration is required for Phases 5–8.
- The Vercel root TypeScript configuration must exclude `supabase/functions` because those files target the Supabase Deno runtime, not the Next.js runtime.

## Required Edge Function secret / environment

Recommended:

`TABLELY_PUBLIC_APP_URL=https://www.tablely.in`

The function currently falls back to `https://www.tablely.in` when this value is absent.

Existing required secrets remain:

- `RESEND_API_KEY`
- `RESEND_ORDER_EMAIL_FROM` (or `RESEND_FROM_EMAIL`)
- `RESEND_REPLY_TO_EMAIL` (optional)

## Live status

- Phase 1 DB: live.
- Phase 3 Edge Function: live and updated by this release.
- Phase 4 DB wiring: live.
- Phase 5 template code: included and deployed with the Edge Function update.
- Phase 6 retry/idempotency: already live through Phase 3/4 and preserved.
- Phase 7 link: included in the Edge Function template.
- Phase 8 production side-effect tests: must be executed against a controlled real order/inbox.
