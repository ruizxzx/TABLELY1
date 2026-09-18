# BUILD 19.1 — Session is created by the first real order, not by a QR scan

Correction pass on Build 19. Additive and surgical: Builds 1–18 untouched, one
new migration, no migration rewritten, no rows deleted, still exactly one
session system (`public.table_sessions`).

---

## 1. Why session creation moved from QR scan to the first actual order

Build 19's `resolve_public_table_session()` inserted a persistent
`table_sessions` row the moment the customer app mounted. Consequences:

- a scan alone flipped the table to `OCCUPIED`;
- anyone who scanned and walked away left a stray open session that a manager
  had to close by hand;
- table availability stopped describing reality.

A scan is not a commitment; an order is. So the persistent session is now
created at the only moment TABLELY actually knows a guest is using the table:

```
QR scan → resolve restaurant/branch/table + LOCAL visit context  (no DB write)
        → menu → cart
first real order → resolve or CREATE persistent session → create order → attach
```

`NO ORDER → NO SESSION`. The stray-session problem disappears by construction,
so no scheduler or expiry job was added (and none is needed).

## 2. How the temporary QR / visit context works

Two anonymous values, both **local to the browser**, both only ever sent to the
server as parameters on a write the customer explicitly performs:

| Value | Storage key | Purpose |
| --- | --- | --- |
| Visit token | `tablely:visit:<tableCode>` (+ `tablely:visit-started:<tableCode>`) | Identifies one visit to one table. 24 random bytes from `crypto.getRandomValues`, rotated after 4 hours. |
| Device token | `tablely:device` | Stable per browser. **Informational only** (see §10). |

`getOrCreateVisitToken()` and `startNewVisit()` touch `localStorage` only — no
RPC, no network call, no row. The server stores only SHA-256 hashes
(`build19_hash_token`), so neither token is recoverable from the database, and
a visit token is never treated as proof that a session exists.

`resolve_public_table_session()` — the Build 19 scan RPC — has been **dropped**.

## 3. How name + phone are stored

The Build 18 checkout already requires both and validates them server-side
(10-digit Indian mobile, `6-9` leading digit, `+91` stripped). On the first
order of a session they are written to the order **and** onto the session:

```sql
update public.table_sessions
set customer_name  = coalesce(customer_name,  <checkout name>),
    customer_phone = coalesce(customer_phone, <checkout phone>)
where id = <this order's session>;
```

`coalesce` means the first customer's details are never overwritten — by a later
order in the same session or by anyone else. Values come from the RPC
parameters, not from frontend state: the server is authoritative. No customer
account is created, and name is never used as an identity key.

## 4. How multiple sessions coexist

Unchanged from Build 19 and still the core of the design: Build 17's
`table_sessions_one_active_per_table_uidx` is gone, so one `table_id` can carry
several open sessions. Each keeps its own id, customer, orders, payments,
coupon usages, service requests, timestamps and status. Build 19.1 additionally
drops `table_sessions_open_device_uidx`, which would have stopped a second
customer on the same browser from getting a second session, and replaces the
global unique index on the visit-token hash with a partial one restricted to
`ACTIVE`/`SETTLING` — so a visit token owns at most one *open* session, and the
same browser is free to start a fresh session once the old one closes.

## 5. How old sessions are preserved

A new session is only ever `INSERT`ed. No code path updates another session's
`table_id`, customer, orders, payments or status, and nothing is auto-closed
because someone else scanned or ordered. `close_table_session(p_session_id)`
closes exactly one session, and only that session's own service requests block
it. Existing Build 19 sessions with real activity are left exactly as they are.

The one data change: sessions that Build 19 created **from a scan alone** and
that can be *proven* empty — `origin = 'CUSTOMER_SCAN'`, zero declared
occupancy, no orders of any status, no service requests, no coupon usages, no
occupied seats — are set to `CLOSED` so they stop blocking table availability.
They are not deleted, so they remain queryable as history. Any session with a
single order, request or payment is untouched.

## 6. How PAY_AT_COUNTER handoff works

```
A scans Table 5                 → no session, table AVAILABLE
A places Order #101             → Session A created, order attached, table OCCUPIED
A chooses PAY_AT_COUNTER, walks to the counter, manager has not completed it
                                → Session A = SETTLING (unpaid, nothing left in the kitchen)
B scans the same Table 5        → still no session for B
B places Order #102             → Session B created (new visit token), Order #102 → Session B
```

Session A's pending counter settlement blocks nothing. `SETTLING` is derived
automatically by `build19_refresh_session_status()` and reverts to `ACTIVE` if
that session orders again; it is never turned into `CLOSED` automatically.

## 7. How PAY_NOW remains payment-first

`create_payment_attempt_for_table_v18` no longer creates or references a
session. It stores `visit_token_hash` / `device_token_hash` on the attempt and
nothing else changes. `finalize_payment_attempt_v18` — which only runs after
signature verification (`/api/payments/verify`) or a verified webhook — is what
resolves-or-creates the session, creates the order, records the payment
transaction and the coupon usage, in one transaction.

So an abandoned or failed Razorpay attempt leaves **no restaurant-visible order
and no session**. Idempotency (`idempotency_key`, `payment-attempt:<id>` order
key, `provider_order_id` conflict handling), amount verification, expiry and the
webhook path are all unchanged. Legacy Build 19 attempts that still carry a
`table_session_id` are honoured if that session is still open on that table.

## 8. How table availability is derived

`build17_sync_table_operational_state(p_table_id)` counts open (`ACTIVE` or
`SETTLING`) sessions:

- `0` → `AVAILABLE`, occupancy `0`;
- `≥1` → occupied, with the exact state (`BILL_REQUESTED` / `PAYMENT_PENDING` /
  `PREPARING` / `ORDERING` / `COMPLETED` / `OCCUPIED`) derived from the orders of
  **all** open sessions, using Build 17's precedence.

Closing A while B is active leaves the table `OCCUPIED`; it returns to
`AVAILABLE` only after the last open session closes. Since a scan creates
nothing, a scan can no longer occupy a table.

## 9. How seat capacity is enforced across sessions

New in 19.1, and only when `tables.seat_tracking_enabled` is true (with seat
tracking off, Build 17/19 behaviour is preserved verbatim):

```
SUM(occupancy_count of all other open sessions) + requested  ≤  tables.seats
```

Enforced server-side in `open_table_session` and
`update_table_session_occupancy` via `build19_open_seat_usage(table, exclude)`.
Both take `select ... for update` on the `tables` row **before** the check, so
two concurrent seatings of the same table serialize and the second is rejected
("Combined occupancy of open sessions (3 + 2) exceeds table capacity of 4").
Individual seat rows are still claimed only from seats that are free or
unowned — one session can no longer steal another's seats.

## 10. How same-device / new-customer cases are handled

- **Same guest reloading or navigating** → same visit token → their existing
  open session on that table is adopted. No duplicate sessions.
- **New guest, new phone** → different visit token → new session.
- **Same browser, different guest** → the device token is deliberately *not* a
  matching key any more. `build19_resolve_session_by_hash` adopts a session only
  on a visit-token match; `device_token_hash` is stored for audit only, and its
  unique index is dropped. For the explicit case there is a **Start new visit**
  action in the customer "Table services" panel that rotates the visit token and
  clears the local cart/coupon without touching anything on the server.
- **Stale visit token whose session already closed** → no open session matches →
  a new session is created. The old one stays closed and intact.
- **Two writes racing on one visit** → the partial unique index turns the loser
  into a `unique_violation`, which is caught and the winning session adopted.

---

## 11. Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/202609170016_build19_1_session_on_first_order.sql` | **New** migration (everything above). |
| `lib/customer.ts` | Removed `resolvePublicTableSession` / `ensureSessionToken` / `ensureFreshSession` and the session-token storage; added local `getOrCreateVisitToken`, `readVisitToken`, `startNewVisit`, `randomToken`; all three public writes now send the visit token. |
| `components/customer/CustomerLayout.tsx` | Mount effect no longer calls any RPC — it only establishes the local visit context; added the "Start new visit" action. |
| `BUILD19_1_SESSION_ON_FIRST_ORDER.md` | This changelog. |
| `BUILD19_MULTI_SESSION_HANDOFF.md` | Marked the old stray-session trade-off as superseded. |

`app/tables/page.tsx`, `app/globals.css` and the Build 19 migration are
unchanged — the multi-session staff UI (per-session **Close session**, no
"close the whole table" action) already matches the requirement.

## 12. Migrations added

One: `supabase/migrations/202609170016_build19_1_session_on_first_order.sql`.

- drops `table_sessions_open_device_uidx` and the global
  `table_sessions_session_token_uidx`; adds partial
  `table_sessions_open_visit_token_uidx`;
- adds `payment_attempts.visit_token_hash`, `payment_attempts.device_token_hash`
  (both nullable);
- drops `resolve_public_table_session(text,text,text)`;
- adds `build19_resolve_session_by_hash(uuid,uuid,text,text,boolean)` and
  `build19_open_seat_usage(uuid,uuid)`;
- `create or replace`, at identical signatures (so no duplicate/ambiguous
  overloads): `build19_resolve_session_for_write`,
  `create_service_request_for_table`, `create_payment_attempt_for_table_v18`,
  `finalize_payment_attempt_v18`, `open_table_session`,
  `update_table_session_occupancy`;
- closes provably-empty scan-only sessions and re-derives every table's state.

All functions keep `security definer` + `set search_path = public`, identifiers
are schema-qualified, no bare ambiguous `id` is used, and RLS/branch isolation
is unchanged: the branch is always derived server-side from the scanned
`table_code` (`tables → branches → organizations`), never from client input.

`create_order_for_table_v18` was deliberately **not** re-created: its signature
and body are correct as of Build 19, and the behaviour change reached it through
the replaced `build19_resolve_session_for_write` body.

## 13. Tests actually executed

**None of the runtime tests. Nothing here is verified against a running system.**

This container has no network access, so `npm ci` fails with a 403 from the npm
registry, and there is no Postgres binary available. `npm run typecheck`,
`npm run lint`, `npm run build` and the migration itself were therefore **not
run**, and none of TEST 1–15 was executed.

What was actually done:

- Read of the current Build 19 implementation before editing:
  `lib/customer.ts`, `components/customer/CustomerLayout.tsx`,
  `components/customer/CustomerCheckoutClient.tsx`, `app/tables/page.tsx`,
  `app/api/payments/verify|webhook`, `202609170004`, `202609170009`,
  `202609170010`, `202609170011`, `202609170015`.
- Repository-wide search for every session-creation path
  (`table_sessions` inserts, session/visit/device token handling,
  `table_session_id`). The only remaining ones are: the order RPC, PAY_NOW
  finalize, the Build 17 staff/legacy `build17_attach_order_session` fallback,
  and staff `open_table_session`. **No path creates a session from opening a QR
  page.**
- Structural review of the new migration: balanced `$$` (18, even), balanced
  parentheses (231/231), single `begin;`/`commit;`, qualified identifiers, no
  plpgsql output-parameter/column collisions, every replaced function at an
  identical signature.

## 14. Tests that could NOT be executed

Please run these before shipping — they are the acceptance gate, not a
formality:

- `npm ci && npm run typecheck && npm run lint && npm run build` (no registry
  access here).
- Applying `202609170016` to a staging copy of the database, then TEST 1–15
  from the brief end to end, in particular:
  - TEST 1/2 — scan and leave: assert `select count(*) from table_sessions`
    is unchanged and the table stays `AVAILABLE`;
  - TEST 4/6 — abandoned and failed Razorpay: assert no order and no session;
  - TEST 10 — same browser, "Start new visit", second order → second session;
  - TEST 11 — seat-tracking capacity across two sessions;
  - TEST 13 — coupon usage row points at customer B's session.
- The stray-session cleanup in §9 of the migration against real data — verify
  on a copy that only genuinely empty sessions are closed.
- Browser console and realtime behaviour on the Tables page with two live
  sessions on one table.
- `extensions.digest` (pgcrypto) availability on your project — the codebase
  already relies on `extensions.gen_random_bytes` from the same extension.

This build is **not** claimed to be bug-free; it is claimed to be reviewed.
