# BUILD 19.3 — Coupon control-flow fix (the real fix, not a field rename)

You were right, and my earlier "fix" (the migration named
`202609170018_build18_coupon_checkout_record_regression_fix.sql` I sent
previously) was **incomplete**. This build supersedes it with a new migration,
`supabase/migrations/202609170018_build19_3_coupon_control_flow_fix.sql`
(different name, deliberately — see note at the end). One migration, additive,
`create or replace` at unchanged signatures, nothing else touched.

---

## What was actually wrong

Renaming `v_coupon.id` to `v_coupon.coupon_id` fixed the field name, but not
the bug. The real defect is a **control-flow** one:

```sql
if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
  select * into v_coupon from public.build18_validate_coupon(...);
  v_discount := coalesce(v_coupon.discount_amount, 0);
end if;
...
-- further down, OUTSIDE that if-block:
values(..., case when v_coupon.coupon_id is null then null else v_coupon.coupon_id end, ...)
...
if v_coupon.coupon_id is not null then
  insert into coupon_usages(...) values (v_coupon.coupon_id, ...);
```

`v_coupon` is a bare `record`. In PL/pgSQL, a `record` variable has **no
structure at all** until it's assigned a row. The instant code *references any
field* of an unassigned record — `v_coupon.coupon_id`, `v_coupon.id`, doesn't
matter which name — Postgres raises `record "v_coupon" is not assigned yet`
right there, before any `is null` comparison even gets a chance to run. The
`case when v_coupon.coupon_id is null then ... end` guard does not protect
against this, because the field is *read* to evaluate the `is null` test — the
crash happens during the read, not after it.

So the previous "fix" only worked when a coupon was actually supplied (the one
path where `v_coupon` gets a row). Every other path — no coupon at all, coupons
existing but this guest not using one — still crashed, exactly matching your
three states:

| State | What happens | Why |
|---|---|---|
| No coupon code supplied at all | crash | `v_coupon` never assigned, then read anyway |
| A coupon exists/could apply but guest didn't enter one | crash | same — whether other coupons exist is irrelevant, only *this checkout's* `p_coupon_code` matters |
| A valid coupon code entered | works | the only path where `v_coupon` is actually populated before being read |

## The fix

`v_coupon` is now read **only inside the same `if` branch that assigns it**.
Its needed fields are copied there into four ordinary, individually-typed
variables — `v_coupon_id uuid`, `v_coupon_code text`,
`v_coupon_discount_type text`, `v_coupon_discount_value numeric` — which are
`NULL` by default and were simply never assigned when no coupon applies.
Reading a `NULL` scalar is always safe in PL/pgSQL; it's only the *unassigned
record* that's radioactive. Every reference after that branch — the order/
payment-attempt INSERT, the `coupon_usages` insert, the `COUPON_APPLIED`
event — now uses those scalars, and `v_coupon` itself is never touched again
outside its own assigning branch.

I verified this by grep: every remaining `v_coupon.<field>` in the new
migration sits on the four lines immediately following
`select * into v_coupon from public.build18_validate_coupon(...)`, inside the
`if` that guards it — nowhere else.

## Functions fixed

- `create_order_for_table_v18` (10-arg, PAY_AT_COUNTER)
- `create_payment_attempt_for_table_v18` (9-arg, PAY_NOW attempt)

Both re-created with `create or replace` at their current, unchanged
signatures — no drop needed, no duplicate overload.

**Not touched**, confirmed by a repo-wide grep for every call site of
`build18_validate_coupon`: `finalize_payment_attempt_v18` (its `v_coupon` is a
real `public.coupons%rowtype` from `select c.* into v_coupon from
public.coupons`, always either populated or the query fails first — never
subject to this bug), `build18_validate_coupon` itself, `update_coupon`, and
`preview_public_checkout_v18` (uses scalar `into` variables directly, no
`v_coupon` record at all).

## The four required states, after this fix

- **Coupons off / no code entered** → the `if` branch never runs → discount
  stays `0`, `v_coupon_id` etc. stay `NULL` → order/attempt inserted with no
  coupon columns → checkout succeeds.
- **Coupons available, guest doesn't use one** → identical to the above; there
  is no separate "coupon feature" flag in the schema to check — the only
  branch condition is whether *this checkout's* `p_coupon_code` is non-empty.
- **Valid coupon entered** → `v_coupon` populated, discount calculated, order/
  attempt carries the coupon snapshot, `coupon_usages` row and
  `COUPON_APPLIED` event written — unchanged from before, still works.
- **Invalid coupon entered** → `build18_validate_coupon`'s own
  `raise exception 'Invalid coupon'` (or the specific reason) still fires
  first, before any of this code runs — unaffected, still a safe customer-
  facing error.

## Extra fix found while investigating your screenshot

Your screenshot showed "Discounted subtotal ₹30" printed right under
"Subtotal ₹30" — identical numbers, no discount applied, but the label made it
look like a discount had happened. That row in `CustomerCheckoutClient.tsx` was
rendered unconditionally; only the "Discount" line above it was gated on
`discount > 0`. Fixed: "Discounted subtotal" now only renders alongside
"Discount", i.e. only when a discount actually applied. This is a display-only
change — no pricing, coupon, or checkout logic touched.

## What was NOT touched (per Build 20.1's hard rules, still respected)

Schema, `table_sessions`, session resolver functions, RLS, Razorpay,
`PAY_AT_COUNTER`/`PAY_NOW` architecture, table occupancy, and the Build 20.1
cart/coupon browser-tab isolation (`lib/customer.ts` visit-context keys,
`CustomerMenuClient.tsx`, `CustomerCartClient.tsx`, `CustomerLayout.tsx`) are
all exactly as they were in the zip you gave me. This migration only changes
the internals of two SQL functions and one JSX conditional.

## Why this migration has a different filename than before

The earlier (incomplete) fix I sent you was named
`202609170018_build18_coupon_checkout_record_regression_fix.sql`. This zip
never actually contained that file — it wasn't in your repo, only sent as a
loose SQL file for you to run by hand. To avoid any ambiguity about "which 018"
if you already ran that old content via the SQL editor, this corrected version
uses a distinct name:
`202609170018_build19_3_coupon_control_flow_fix.sql`. Both are `create or
replace` at identical signatures, so if you did run the old one, this one will
simply overwrite it with the corrected body — that's safe either way.

## Tests actually executed

**None of the runtime tests.** Same constraint as every prior round: this
container has no network access (`npm ci`/`npm install` gets a 403 from the
registry) and there's no Postgres instance, so `npm run typecheck`,
`npm run lint`, `npm run build`, and the migration itself were **not run**, and
none of the four checkout states was executed end to end.

What was actually done:

- Re-read the exact live bodies of `create_order_for_table_v18` (015) and
  `create_payment_attempt_for_table_v18` (016) character-by-character to find
  every `v_coupon.*` reference and its position relative to the assigning
  `if` block.
- Grepped every call site of `build18_validate_coupon` across all 18
  migrations to confirm no other function has this pattern.
- Grepped the new migration itself: every `v_coupon.*` reference is on one of
  8 lines, all inside the two `if ... is not null then` blocks that assign it
  — zero references outside those guards.
- Structural check: balanced `$$` (4, even), balanced parentheses (157/157),
  single `begin;`/`commit;`.

Please run before shipping:

- `npm ci && npm run typecheck && npm run lint && npm run build`.
- Apply this migration (via CLI push or SQL editor, whichever you use), then
  actually place: a PAY_AT_COUNTER order with no coupon, one with a valid
  coupon, one with an invalid coupon, and the same three for PAY_NOW.
- Confirm the checkout page no longer shows "Discounted subtotal" when no
  coupon was applied.
