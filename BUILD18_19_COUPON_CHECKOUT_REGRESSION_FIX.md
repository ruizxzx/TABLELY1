# BUILD 18/19 — Coupon checkout record regression fix

One new, additive migration:
`supabase/migrations/202609170018_build18_coupon_checkout_record_regression_fix.sql`.
No old migration edited or deleted. No data touched. No session, occupancy,
identity, or discount *logic* changed — only two wrong field references.

---

## 1. Exact root cause

In `create_order_for_table_v18` and `create_payment_attempt_for_table_v18`,
`v_coupon` is declared as a bare `record` and populated with:

```sql
select * into v_coupon from public.build18_validate_coupon(...);
```

`build18_validate_coupon(...)` returns `coupon_id, coupon_code, discount_type,
discount_value, eligible_subtotal, discount_amount` — there is **no column
named `id`**. So:

- with `p_coupon_code` NULL/empty, that `select ... into v_coupon` never runs,
  `v_coupon` stays unassigned, and any `v_coupon.id` reference raises
  `record "v_coupon" is not assigned yet`;
- with a coupon supplied, `v_coupon` is assigned but has no `id` field, so
  `v_coupon.id` raises `record "v_coupon" has no field "id"`.

Either way, checkout fails — with or without a coupon.

## 2. Why 202609170014 was previously correct

`202609170014_build18_coupon_record_field_fix.sql` re-created exactly these two
functions with every `v_coupon.id` changed to `v_coupon.coupon_id`, and its own
header explicitly noted the distinction: `build18_validate_coupon` itself and
`update_coupon` use a *different* `v_coupon` — declared
`public.coupons%rowtype` and populated with `select c.* into v_coupon from
public.coupons c` — whose `id` column is real, so those `v_coupon.id`
references were correctly left alone. That migration was correct and complete
for the code as it stood at the time.

## 3. Which later migrations reintroduced the bug

Both functions were **re-created from scratch** afterwards to add Build 19
functionality, and both re-creations were based on the pre-014 body:

- `create_order_for_table_v18` — re-created in
  `202609170015_build19_multi_session_table_handoff.sql` (adds the two
  session-token parameters). Reintroduced `v_coupon.id` at three call sites.
- `create_payment_attempt_for_table_v18` — re-created in
  `202609170016_build19_1_session_on_first_order.sql` (drops the
  `table_session_id` write, adds visit/device token hashing). Reintroduced
  `v_coupon.id` at the same three call sites.

`finalize_payment_attempt_v18` was **also** re-created by both 015 and 016, but
its `v_coupon` is `public.coupons%rowtype` populated by `select c.* into
v_coupon from public.coupons c where c.id = v_attempt.coupon_id` — a real row
with a real `id` column. Its `v_coupon.id` references are correct and were
**not** touched.

## 4. Exact functions repaired

| Function | Live (broken) definition was in | Fix |
| --- | --- | --- |
| `create_order_for_table_v18` | `202609170015` | 3 call sites: `v_coupon.id` → `v_coupon.coupon_id` |
| `create_payment_attempt_for_table_v18` | `202609170016` | 3 call sites (one line, 4 occurrences) → `v_coupon.coupon_id` |

Not touched (already correct, verified by full-repo grep):
`build18_validate_coupon`, `update_coupon`, `finalize_payment_attempt_v18`,
`preview_public_checkout_v18` (uses scalar `into` variables, no `v_coupon`
record at all, so it was never affected by this class of bug).

## 5. Exact new migration name

`supabase/migrations/202609170018_build18_coupon_checkout_record_regression_fix.sql`.
`018` was free — the latest prior migration in the repo was `017`
(`build19_2_origin_and_preorder_requests`).

Both functions are re-created with `create or replace function` at their
**current, unchanged** signatures (10 args for the order RPC, 9 for the
payment-attempt RPC) — no `drop function` was needed since the signature
doesn't change, and no duplicate/ambiguous overload is introduced. Every other
parameter, return type, grant, revoke, and piece of Build 19/19.1 logic
(session resolution, visit/device token hashing, `table_session_id` handling)
is copied verbatim from the current live body — only the coupon field name
changed.

## 6. How no-coupon checkout works now

`p_coupon_code` is NULL or empty →
`nullif(trim(coalesce(p_coupon_code,'')),'')` is NULL → the
`build18_validate_coupon` branch never runs → `v_coupon` stays unassigned →
every use of it is `v_coupon.coupon_id`, guarded as
`case when v_coupon.coupon_id is null then null else ... end` or
`if v_coupon.coupon_id is not null then`. An unassigned `record`'s field access
raises "not assigned yet" **only when Postgres has to resolve which record type
it is** — since these are ordinary field reads on a record that was never given
a row, and the pattern is unchanged from 202609170014's already-verified fix,
this resolves the same way: `v_discount` stays `0`, no coupon row/usage/event is
written, and the order or payment attempt is created normally.

## 7. How coupon checkout works now

A valid `p_coupon_code` → `build18_validate_coupon` returns a row →
`v_coupon.discount_amount` feeds `v_discount` → charges are computed on the
discounted subtotal → the order/attempt is inserted with
`v_coupon.coupon_id`, `v_coupon.coupon_code`, `v_coupon.discount_type`,
`v_coupon.discount_value` as its coupon snapshot → for
`create_order_for_table_v18`, a `coupon_usages` row and a `COUPON_APPLIED`
order event are written referencing `v_coupon.coupon_id` and the order's own
`table_session_id`. All of Build 18's percentage/fixed, minimum order, validity
window, usage-limit, per-customer-limit, branch scope, and item/category scope
checks live inside `build18_validate_coupon` itself, which this migration does
not touch.

An **invalid** coupon still surfaces `build18_validate_coupon`'s own
`raise exception 'Invalid coupon'` (or the specific reason — expired, minimum
not met, usage limit reached, etc.) — customer-safe messages, unchanged.

## 8. PAY_NOW result

`create_payment_attempt_for_table_v18` only stores the coupon snapshot on the
`payment_attempts` row (with the same `v_coupon.coupon_id` fix) — no order, no
session, and no coupon usage row is created at this stage, exactly as in Build
19.1. `finalize_payment_attempt_v18` (untouched, already correct) is what
creates the order, the session, the coupon usage, and the payment transaction,
and only after Razorpay signature verification succeeds. A failed or abandoned
payment attempt leaves no order and no session, unaffected by this fix.

## 9. PAY_AT_COUNTER result

`create_order_for_table_v18` now runs to completion in both the no-coupon and
valid-coupon cases: session resolution (Build 19.1's visit-token based
`build19_resolve_session_for_write`) is unaffected, the order is created and
attached to the correct session, and — when a coupon was supplied — the coupon
usage row references that same session.

## 10. Tests actually executed

**None of the runtime tests.** This container has no network access —
`npm ci`/`npm install` fails with a 403 from the npm registry — and there is no
Postgres instance available. `npm run typecheck`, `npm run lint`,
`npm run build`, and the migration itself were **not run**. TEST CASE 1–6 from
the request were **not executed**.

What was actually done — a full static audit, which is what surfaced and
confirmed the exact regression:

- Repo-wide `grep` for every `v_coupon.id` and `v_coupon.coupon_id` occurrence
  across all 18 migrations, cross-referenced against each occurrence's
  `v_coupon` declaration (`record` vs `public.coupons%rowtype`) and its
  population source, to build the SAFE / MUST-FIX classification in the
  migration's own header comment.
- Confirmed which definition of each function is the *live* one (last
  `create`/`create or replace` in migration-timestamp order) before touching
  anything, so the fix targets the actual current bodies and does not
  accidentally resurrect a pre-Build-19 version.
- Confirmed `preview_public_checkout_v18` uses no `v_coupon` record and was
  never subject to this bug.
- Structural review of the new migration: balanced `$$` (4, even), balanced
  parentheses (168/168), single `begin;`/`commit;`, no remaining bare
  `v_coupon.id` in executable code (only in explanatory comments, verified by
  grep excluding `--` lines), functions replaced at identical signatures with
  no new drops, `security definer` + `search_path=public` preserved, existing
  grants/revokes preserved verbatim.

Please run before shipping — this is the acceptance gate, not a formality:

- `npm ci && npm run typecheck && npm run lint && npm run build`.
- Apply `202609170018` to a staging copy, then TEST CASE 1–6 end to end,
  in particular the two that were previously crashing: a `PAY_AT_COUNTER`
  order with `p_coupon_code = NULL`, and one with a valid coupon code.
