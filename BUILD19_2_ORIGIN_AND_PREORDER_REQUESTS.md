# BUILD 19.2 — Session origin, pre-order service requests, closure scope

Small corrections on top of Build 19.1. One new migration
(`202609170017_build19_2_origin_and_preorder_requests.sql`), additive, no
migration rewritten, nothing deleted, still one session system.

The Build 19.1 lifecycle is unchanged and was not weakened anywhere:

```
QR scan            → temporary LOCAL visit context only, zero database writes
no order           → NO persistent session
first actual order → create/resolve the persistent session, attach the order
PAY_NOW            → session + order only after verified payment
new visit          → new visit token → next order creates a new session
old session        → preserved until independently settled and closed
```

---

## 1. `origin = CUSTOMER_ORDER`

A session created because the customer actually ordered was still being stored
as `CUSTOMER_SCAN`, which is now wrong — nothing is created by a scan any more.

- `table_sessions_origin_chk` widened to
  `('STAFF','CUSTOMER_ORDER','CUSTOMER_SCAN','AUTO')`. The same existing column
  and check constraint; no parallel origin system.
- `build19_resolve_session_by_hash` — the single path that creates a customer
  session, reached only from `create_order_for_table_v18` and from
  `finalize_payment_attempt_v18` after verification — now writes
  `CUSTOMER_ORDER`.
- `CUSTOMER_SCAN` stays a legal value so the rows Build 19 wrote keep
  validating. **No historical row is rewritten**, and the column now carries a
  `comment on column` explaining each value.
- `STAFF` (Tables page seating) and `AUTO` (Build 17's fallback for a
  staff/legacy order inserted without a session) are untouched.
- TypeScript: `SESSION_ORIGINS` / `SessionOrigin` / `sessionOriginLabel()` in
  `lib/restaurant-ops.ts`; the Tables page shows the label per session
  ("Customer order", "Legacy QR scan", "Seated by staff", "Auto-created").

## 2. Same browser / same device, different customer

Already correct in 19.1 and re-verified here: `build19_resolve_session_by_hash`
adopts a session **only** on a visit-token-hash match against an open session on
that table. `device_token_hash` is stored for audit and is never a matching key;
its unique index was dropped in 19.1. Customer B on browser X cannot inherit
Customer A's session.

## 3. "Start new visit"

`startNewVisit(tableCode)` in `lib/customer.ts` — verified against the required
behaviour, no change needed:

1. removes the stored visit token and its timestamp, then generates a fresh
   24-byte random token;
2. stores it under `tablely:visit:<tableCode>`;
3. every subsequent write sends the new token, so the old one is never used
   again for new activity;
4. it is **purely local** — no RPC, no DB write, so the old session is not
   modified or closed;
5. nothing is deleted server-side; only this browser's cart and coupon are
   cleared;
6. the next order finds no open session for the new token and creates one.

The visit token also rotates automatically after 4 hours.

## 4. Name is not an identity key

Unchanged: `customer_name` / `customer_phone` are customer information captured
at checkout, validated server-side, written onto the order and onto the session
with `coalesce` so the first customer's details are never overwritten. No lookup
anywhere matches on name, and no customer account exists.

## 5–6. Service request before the first order

A guest who scans and calls a waiter without ordering must not produce a
session, and must not lose the request. `create_service_request_for_table` now:

- resolves the session with `p_create_if_missing = false` — it can adopt this
  visit's own session if one already exists, but it **never creates one** and
  never borrows another customer's;
- writes the request with the real `branch_id` and `table_id`, its type, status
  and note, and `table_session_id = NULL` (the column is nullable — no
  constraint failure, no fake session id);
- stores `visit_token_hash` (new nullable column + partial index) so the
  anonymous browser context is kept;
- scopes the "this request is already open" guard per session when one exists,
  otherwise per visit hash, otherwise per table — so two different guests at one
  table can each call a waiter before ordering, which the 19.1 per-table guard
  wrongly rejected.

The request stays visible and processable on the service requests page, and the
table's state is unaffected by it (table state is derived from sessions only).

When that *same* visit later places its first order, the newly created session
adopts that visit's still-open requests — matched on identical
`visit_token_hash` **and** `table_id` **and** `status in ('OPEN','ACKNOWLEDGED')`.
No other customer's request is ever moved, and resolved history is untouched.

## 7. Additional bug found and fixed: closure blocked by foreign requests

Not in the brief, found while tracing §5/§6. `close_table_session` inherited a
Build 19 rule that counted session-less open requests against the table's *last*
open session. With pre-order requests now being a normal occurrence, a guest who
called a waiter and left without ordering would have trapped an unrelated
customer's session in a state where it could not be closed.

`close_table_session` now blocks **only** on `r.table_session_id = <this
session>`. A request belonging to no session stays open and visible for staff to
resolve on the service requests page, but never traps someone else's session.
Everything else about closure is unchanged: one session at a time, orders must
be settled, and closing A never touches B.

## 8–10. Preserved without change

- **Handoff:** A orders → Session A → PAY_AT_COUNTER → settling at the counter;
  B scans (no session) → B orders → Session B. B never overwrites A, and A's
  pending settlement blocks nothing.
- **Payment-first:** `create_payment_attempt_for_table_v18` stores only the
  visit-token hash; the session, order, payment transaction and coupon usage are
  all created by `finalize_payment_attempt_v18`, which runs only after signature
  verification or a verified webhook. A cancelled or failed attempt leaves no
  order and no session.
- **Table state:** `0` open sessions → `AVAILABLE`; `≥1` → `OCCUPIED`. A scan
  creates nothing, and a service request creates nothing, so neither can occupy
  a table. Only a real order does.
- **Build 18:** untouched. Coupon validation stays branch-scoped;
  `coupon_usages.table_session_id` records the ordering customer's own session,
  so B's discount cannot reach A's snapshot.

## 11. Every persistent session creation path (full repo audit)

Live paths after this migration, i.e. the latest definition of each function:

| Path | Trigger | Origin |
| --- | --- | --- |
| `build19_resolve_session_by_hash` | customer's first order (`create_order_for_table_v18`) or verified PAY_NOW (`finalize_payment_attempt_v18`) | `CUSTOMER_ORDER` |
| `build17_attach_order_session` fallback | a staff/legacy order inserted with no session context | `AUTO` |
| `open_table_session` | staff "Seat" on the Tables page | `STAFF` |

Superseded and no longer reachable: the Build 19 body of
`build19_resolve_session_for_write` (now delegates), and
`resolve_public_table_session` (dropped in 19.1). There is **no** trigger on
`service_requests` or `payment_attempts` that creates a session, and no client
code path that creates one — `lib/customer.ts` holds no session RPC at all, and
`CustomerLayout` only calls the local `getOrCreateVisitToken`.

## 12–13. Compatibility and database safety

Existing Build 19 / 19.1 records stay usable: `CUSTOMER_SCAN` remains a valid
origin, no session is deleted, no order or payment relationship is rewritten,
and the new columns are nullable with no backfill of historical rows. The
migration is additive, keeps `security definer` + `set search_path = public` on
every function, replaces functions only at identical signatures (no duplicate or
ambiguous overloads), qualifies identifiers, and uses no ambiguous bare `id`.

## Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/202609170017_build19_2_origin_and_preorder_requests.sql` | **New**: origin constraint + comments, `service_requests.visit_token_hash` + index, `build19_resolve_session_by_hash` (CUSTOMER_ORDER + same-visit request adoption), `create_service_request_for_table` (visit-scoped guard, never creates a session), `close_table_session` (own requests only). |
| `lib/restaurant-ops.ts` | `SESSION_ORIGINS`, `SessionOrigin`, `sessionOriginLabel()`. |
| `app/tables/page.tsx` | Session card shows the origin label; `origin` typed. |
| `BUILD19_2_ORIGIN_AND_PREORDER_REQUESTS.md` | This changelog. |

## 14–15. Tests

**No runtime test was executed. Nothing here is verified against a running
system.** This container has no network access, so `npm ci` fails with a 403
from the npm registry and there is no Postgres binary; `npm run typecheck`,
`npm run lint`, `npm run build` and the migration itself were **not run**, and
none of TEST A–J was executed.

What was actually done:

- Repository-wide audit of every persistent session creation path (table above),
  confirming a QR scan and a service request each create nothing.
- Read of the current `create_order_for_table_v18`,
  `create_payment_attempt_for_table_v18`, `finalize_payment_attempt_v18`,
  `build17_attach_order_session`, `close_table_session` and the customer client
  before editing.
- Structural review of the new migration: balanced `$$` (6, even), balanced
  parentheses (66/66), single `begin;`/`commit;`, no dangling variables after
  the `close_table_session` edit, identifiers qualified, functions replaced at
  identical signatures.

Please run before shipping — these are the acceptance gate:

- `npm ci && npm run typecheck && npm run lint && npm run build`.
- Apply `202609170017` to a staging copy, then TEST A–J, in particular:
  **B** (waiter request with no order: request exists, `table_session_id` is
  null, table still `AVAILABLE`), **C** (`select origin from table_sessions` is
  `CUSTOMER_ORDER`), **E** (same browser, second customer, no inheritance),
  **F** (Start new visit → new session on next order, Session A untouched), and
  **J** (cancelled Razorpay → no order, no session).
- Also worth checking: a pre-order waiter request followed by that same visit's
  first order — the request should move onto the new session — and a pre-order
  request from a guest who never orders, which must no longer block another
  session from closing.
- Browser console and realtime behaviour on the Tables page with two live
  sessions on one table.

This build is reviewed, not verified. It is not claimed to be bug-free.
