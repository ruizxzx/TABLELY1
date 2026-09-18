# BUILD 19 — Multi-session table handoff / customer changeover

Additive change on top of the frozen Builds 1–17 and the Build 18 discount work.
No existing migration was rewritten, no data is destroyed, and no second session
system was introduced — `public.table_sessions` is still the only session table.

---

## 1. Root cause / previous limitation

Two things in Build 17 made the handoff scenario impossible:

1. **`supabase/migrations/202609170004_build17_restaurant_operations.sql`** created

   ```sql
   create unique index table_sessions_one_active_per_table_uidx
     on public.table_sessions(table_id) where status='ACTIVE';
   ```

   A table could physically hold only **one** open session, so a second
   customer could never get their own session on the same table.

2. **`build17_attach_order_session()`** (BEFORE INSERT on `public.orders`,
   latest version in `202609170010`) attached *every* new order on a table to
   "the newest ACTIVE session for this table". Customer B's order, totals,
   coupon usage and service requests therefore landed inside Customer A's
   still-unsettled session.

Supporting cause: a session carried **no customer identity at all** (no token,
no name, no phone), so the server had nothing to distinguish "same guest came
back to the QR" from "a new guest sat down". `service_requests` had no session
reference either, so `close_table_session()` blocked on *any* open request for
the whole table, and `build17_sync_table_operational_state()` derived table
state from a single session row.

---

## 2. Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/202609170015_build19_multi_session_table_handoff.sql` | **New** additive migration (everything below). |
| `lib/customer.ts` | Anonymous device/session token helpers, `resolve_public_table_session` client, session token passed on every public write. |
| `components/customer/CustomerLayout.tsx` | Resolves the guest's session on QR open (throttled), for every customer page. |
| `app/tables/page.tsx` | Staff floor view renders **all** open sessions per table with per-session Occupancy / Close actions. |
| `app/globals.css` | Small styles for stacked session cards. |
| `BUILD19_MULTI_SESSION_HANDOFF.md` | This changelog. |

Nothing else in the repo was touched.

---

## 3. Database changes (all additive)

**`public.table_sessions`**
- new columns: `session_token_hash`, `device_token_hash`, `customer_name`,
  `customer_phone`, `origin` (`STAFF` / `CUSTOMER_SCAN` / `AUTO`),
  `settling_at`, `last_seen_at`.
- status domain widened to `ACTIVE | SETTLING | CLOSED`
  (`table_sessions_status_chk`).
- **dropped** `table_sessions_one_active_per_table_uidx` — the single-session
  lock.
- new indexes: unique `session_token_hash`; unique
  `(table_id, device_token_hash)` **where open** (this is what makes concurrent
  scans idempotent instead of duplicating sessions); `(table_id, status,
  opened_at desc)`.

**`public.service_requests`** — new nullable `table_session_id` FK
(`on delete set null`) + index. Still-open legacy rows are backfilled to the
newest open session of their own table; resolved history is left untouched.

**`public.payment_attempts`** — new nullable `table_session_id` FK, so a
payment-first (PAY_NOW) order lands in the session the checkout started in.

**New functions**
- `build19_hash_token(text)` — SHA-256; raw tokens are **never** stored.
- `build19_refresh_session_status(uuid)` — moves a session ACTIVE ⇄ SETTLING.
  It never closes a session.
- `build19_resolve_session_for_write(uuid,uuid,text,text,boolean)` — resolves
  the caller's own session for a public write (internal, not granted to anon).
- `resolve_public_table_session(text,text,text)` — the public QR-scan RPC
  (`anon`, `authenticated`).
- `list_open_table_sessions_v19(uuid)` — branch-checked staff read model.

**Replaced functions (same names, behaviour extended)**
- `build17_sync_table_operational_state(uuid)` — now aggregates **all** open
  sessions of the table.
- `build17_attach_order_session()` — honours an explicitly resolved
  `table_session_id` (validating table/branch/open-ness) instead of overriding
  it; keeps the old "newest open session, else create" fallback for staff and
  legacy inserts.
- `build17_orders_sync_table_trigger()` — also refreshes the order's own
  session status (and the old session on a session/table move).
- `open_table_session`, `update_table_session_occupancy`, `close_table_session`.
- `create_service_request_for_table` — gained `p_session_token` /
  `p_device_token` (the 3-arg signature is dropped and re-created with defaults,
  so no ambiguous overload exists).
- `create_order_for_table_v18`, `create_payment_attempt_for_table_v18` — gained
  `p_session_token` / `p_device_token` (old signatures dropped first, again to
  avoid duplicate signatures).
- `finalize_payment_attempt_v18` — attaches the order to the attempt's session.

**Privileges** — `select` on `table_sessions` for `authenticated` is now
column-level and excludes the token hash columns. Every new SECURITY DEFINER
function keeps `set search_path=public` and is revoked from `public`.

---

## 4. New multi-session behaviour

```
TABLE 5
├── Session A  Rahul   Order #101  PAY_AT_COUNTER  unpaid   → SETTLING (preserved)
└── Session B  Priya   Order #103                           → ACTIVE
TABLE 5 → OCCUPIED
```

- A QR scan by a new guest creates a **new** session with the **same**
  `table_id` / `branch_id` and a new `session_id`. Session A's id, customer,
  orders, payments, service requests, timestamps and status are never modified.
- Customer B can order immediately; Session A's pending counter settlement does
  not block them.
- `SETTLING` is set automatically when a session has orders, nothing left in
  `NEW/ACCEPTED/PREPARING/READY`, and something still unpaid or only `SERVED`.
  It reverts to `ACTIVE` if that session orders again. Sessions are **never**
  auto-closed, and a new scan never closes anything.
- `close_table_session(p_session_id)` still closes exactly one session, and now
  only that session's own service requests block it (a legacy request with no
  session still blocks, but only while it is the table's last open session).
  Closing A leaves B completely untouched.
- Coupons: `coupon_usages.table_session_id` now records B's session, so B's
  discount can never touch A's order totals or discount snapshots.

## 5. Customer/session identity logic

No customer accounts were introduced. Two anonymous values, both stored
**hashed** server-side:

- **device token** — stable random value in `localStorage` (`tablely:device`),
  per browser.
- **session token** — 32 random bytes issued by the server per visit, stored in
  `localStorage` under `tablely:session:<tableCode>`.

Resolution order in `resolve_public_table_session`, after the branch and table
are resolved **server-side from the scanned table code** (client-supplied
branch ids are never trusted):

1. session token matches an **open** session **on this table** → reuse it
   (same guest re-scanning / navigating — no duplicate session).
2. else device token matches an open session on this table → reuse that session
   and re-issue a token for it.
3. else → **new session** on the same table.

Name and phone are only recorded on the session as display information the
first time an order is placed (the Build 18 checkout already required them);
they are never used as the identity key, and name is never matched on.

## 6. Table occupancy behaviour

`build17_sync_table_operational_state` now counts open (`ACTIVE` or `SETTLING`)
sessions of the table:

- `0` open sessions → `AVAILABLE`, occupancy `0`.
- `≥1` open session → occupied; the exact state (`BILL_REQUESTED` /
  `PAYMENT_PENDING` / `PREPARING` / `ORDERING` / `COMPLETED` / `OCCUPIED`) is
  derived from the orders of **all** open sessions, using the same precedence
  Build 17 used.
- Occupancy count = sum of open sessions' `occupancy_count`, or the number of
  seats occupied by any open session when seat tracking is on.

So closing A while B is active leaves Table 5 `OCCUPIED`; the table only becomes
`AVAILABLE` after the last session closes. The existing Build 17 realtime
publication and the single `tablely:floor:<branch>` channel are reused — no new
subscription architecture.

---

## 7. Tests actually run

Honest answer: **static review only.** This container has no network access, so
`npm ci` fails (403 from the registry) and there is no Postgres instance
available.

What was actually done:

- Full read of the Build 17 session/order/table architecture
  (`202609170004`, `202609170005`, `202609170009`, `202609170010`) and the
  Build 18 coupon/order/payment RPCs (`202609170011`–`202609170014`) before
  changing anything.
- Line-by-line review of the new migration for: balanced `$$` quoting
  (32 delimiters, even), balanced parentheses, single `begin;`/`commit;`,
  qualified identifiers, no ambiguous `id`, no plpgsql output-parameter/column
  name collisions, no duplicate function signatures (every changed signature is
  explicitly `drop function if exists`-ed first), and preserved
  `security definer` + `set search_path=public` on every function.
- Review of every call site of the changed RPCs in the repo
  (`lib/customer.ts`, `app/tables/page.tsx`, `app/orders/page.tsx`,
  `app/api/payments/*`) to confirm the new parameters are passed and no other
  code assumed one session per table.

## 8. Not tested / needs verification on your environment

Please run these before shipping:

- `npm ci && npm run typecheck && npm run lint && npm run build` — **not run
  here** (no registry access).
- Applying the migration against a real database — **not run here** (no
  Postgres). Apply it to a staging copy first; it is written to be safe on
  existing data (nullable columns, `if not exists`, no deletes).
- The 15 scenario tests from the brief (A scans → orders → PAY_AT_COUNTER → B
  scans → B orders → A pays → A closes → B closes → table AVAILABLE, plus the
  coupon, service-request, concurrency and history cases). The code paths for
  all of them are implemented; none of them has been executed.
- Browser console / realtime behaviour on the Tables page with two sessions on
  one table.
- `extensions.digest` (pgcrypto) must be available — the codebase already uses
  `extensions.gen_random_bytes`, which comes from the same extension, so this
  should hold, but it is worth confirming on your project.
- Column-level `select` on `table_sessions` and Supabase Realtime: staff queries
  use explicit column lists and should be unaffected, but confirm the floor
  channel still receives `table_sessions` events on your project.

## 9. Known trade-off (superseded by Build 19.1)

> Superseded: Build 19.1 (`202609170016`) moved session creation to the first
> real order, so a QR scan no longer creates a session or occupies the table.
> See `BUILD19_1_SESSION_ON_FIRST_ORDER.md`.


A QR scan opens a session even if the guest never orders, so a stray scan marks
the table occupied until someone closes it. That session is visible on the
Tables page with `0` orders and "Guest not identified yet", and one click on
**Close session** clears it (a session with no orders and no requests closes
without complaint). No automatic expiry was added, because that would need a
scheduler that does not exist in this build.
