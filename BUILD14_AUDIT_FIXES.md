# Build 14 — Audit Fixes

Applied on top of the original Build 14 drop, in response to the Build 14
verification audit. Every change below is a fix for a confirmed finding; no
unrelated code was refactored and no new architecture was introduced.

The Build 14 migration `supabase/migrations/202609160013_build14_subscription_v2.sql`
was corrected **in place** rather than patched by a follow-up file. The file is
re-runnable: every statement is `create or replace`, `add column if not exists`,
`drop ... if exists` or a guarded `update`, so re-applying it over an environment
that already ran the original version is safe and is the intended upgrade path.

---

## P0 — Blocking

### 1. `subscription_resource_available_internal` was `STABLE` but used `SELECT ... FOR UPDATE`

PostgreSQL rejects `SELECT FOR UPDATE` inside a non-volatile function. This
function is called by all four resource-limit triggers, so after the original
migration **every insert into `branches`, `staff`, `tables` and `menu_items`
would have failed at runtime** — the blast radius was the whole product, not just
billing.

**Fix:** declared `volatile` (the row lock is deliberate and is what makes the
concurrent quota check safe). `organization_can_add_resource`, which delegates to
it, was also `STABLE` and is now `volatile` for the same reason.

A repo-wide scan now reports zero non-volatile functions containing `FOR UPDATE`.

### 2. Provider-synchronisation RPCs were re-granted to `authenticated`

Build 11 migration `202609150021_build11_provider_rpc_privileges.sql` deliberately
revoked these from `authenticated` with the comment *"clients must not forge
billing events."* Build 14 granted them back.

The concrete exploit: an owner calls
`record_subscription_provider_creation_v2(own_org, 'PRO', 'sub_anything', 'year')`
and then `confirm_subscription_payment_v2('sub_anything', 'pay_anything')`. Both
owner checks pass. Result: an ACTIVE Pro annual subscription with no Razorpay
subscription and no payment. Separately, `apply_provider_subscription_event` had
**no authorization check at all** and is keyed only on a provider subscription id,
so it could rewrite the status, plan and price of any subscription.

**Fix:**
- `revoke execute ... from public, authenticated` and `grant ... to service_role`
  for `apply_provider_subscription_event`, `record_subscription_provider_creation_v2`,
  `confirm_subscription_payment_v2`, `admin_set_provider_plan_id_v2` and
  `write_subscription_audit_event`.
- `apply_provider_subscription_event` now hard-fails if `auth.uid()` is non-null
  (defence in depth, independent of grants).
- `confirm_subscription_payment_v2` resolves the subscription by provider id when
  running as the service role, and still applies the owner check for any direct
  authenticated caller.
- `/api/subscriptions/verify` now calls it through the **service-role** client, and
  first verifies via `get_current_subscription` that the subscription being
  confirmed actually belongs to the caller's restaurant. The Razorpay signature
  check and the provider status fetch are unchanged and still run first.
- Razorpay plan identifiers are no longer handed to every authenticated user:
  `saas_plans` moved from a table-wide `grant select` to a column-level grant that
  excludes `provider_plan_id` / `provider_plan_id_annual`, and
  `get_active_plan_catalog_v2` now returns `has_monthly` / `has_annual` booleans in
  their place. Platform admins still get the real ids from `admin_list_plans_v2`.

---

## P1 — Major

### 3. The order quota was never enforced

`enforce_subscription_order_limit()` was created and granted but **never attached
to a trigger**, and nothing in `create_order_for_table` checked the quota. The
order limit existed only as a number in the UI.

**Fix:** bound it as `subscription_limit_orders before insert on public.orders`.
`BEFORE INSERT` is the correct hook for the Build 13.3 payment-first flow: an order
row exists only once `create_order_for_table` succeeds, so an abandoned or
unverified PAY_NOW attempt still never consumes quota.

### 4. `admin_list_subscription_overview_v2` would abort with an ambiguous column reference

Its `RETURNS TABLE` OUT parameters `organization_id`, `provider_subscription_id`
and `cancellation_requested_at` share names with the columns it selected
unqualified. plpgsql's default `variable_conflict = error` aborts the call, taking
the whole platform-admin subscriptions page with it.

**Fix:** read into locals, qualify every column with the table alias, then assign
to the OUT parameters.

### 5. Pending plan changes never cleared

The 13.4 version of `apply_provider_subscription_event` cleared `pending_plan_id`
and `pending_provider_plan_id` once the provider confirmed the change. Build 14
dropped that logic and added `pending_billing_interval` without clearing it, so the
dashboard showed "plan change scheduled" permanently after the change had applied.

**Fix:** restored the clearing, extended to match on interval as well as plan, so
a monthly→annual switch clears correctly too.

### 6. The migration silently desynchronised provisioned provider plans

Step 1 rewrote `price_monthly` for STARTER/GROWTH/PRO unconditionally, including
rows that already had a Razorpay plan provisioned at the old amount. Internal price
then diverged from the provider price, and `admin_update_plan_v2`'s new price lock
made it impossible to correct through the UI.

**Fix:** prices are only rewritten while the corresponding provider plan id is
`null`. Once Razorpay owns the amount, the catalog leaves it alone.

---

## P2 / P3

### 7. Annual plans got a yearly order allowance instead of a monthly one

`max_monthly_orders` was counted across `current_period_start → current_period_end`,
which is twelve months on an annual plan — Starter annual meant 1,000 orders *per
year*.

**Fix:** new `subscription_order_window(p_start, p_end)` helper returns the current
one-month slice of the billing period. Used by **both** the entitlement resolver
(display) and the enforcement path, so the number the owner sees always matches the
number enforced. Monthly plans are unaffected (the window equals the period). The
window is also returned to clients as `order_window_start` / `order_window_end`.

### 8. Catalog price changes retroactively changed existing subscribers

`get_current_entitlements` returned the live catalog `price_monthly` where 13.4
returned `price_monthly_snapshot`.

**Fix:** snapshots take precedence again (`coalesce(snapshot, catalog)`), for
`price_monthly`, `price_annual` and `selected_price`. The live list price is still
available as `catalog_price_monthly` / `catalog_price_annual`.

### 9. `total_count: 1200` was sent for annual subscriptions

Razorpay caps `total_count` per plan period and the yearly cap is far below the
monthly one. **Fix:** `createTablelySubscription` now takes the interval and sends
120 (monthly) or 10 (yearly) — ten years either way — and records the interval in
the subscription notes. **Still worth confirming against the live Razorpay API**;
this was flagged in the audit as provider behaviour I could not test.

### 10. Other fixes

- `apply_provider_subscription_event` no longer drops the webhook `payload` when
  updating the billing event row; it also records `last_provider_event_id`, and
  `current_start` / `current_end` are `nullif`-guarded before the `bigint` cast so a
  malformed payload cannot abort the handler.
- `admin_update_plan_v2` set `updated_at = coalesce(updated_at, now())`, so it never
  advanced — now `now()`. `description` is `coalesce`d instead of being wiped when
  the caller omits it.
- `get_billing_context` read `provider_subscription_id`, `pending_plan_id` and
  `cancellation_requested_at` from the entitlements payload, which never contained
  them. Those keys (plus `pending_billing_interval`) are now returned by
  `get_organization_entitlements_v2`.
- `write_subscription_audit_event` is service-role only, so audit rows are no longer
  forgeable by the actor they describe. The SECURITY DEFINER billing functions still
  call it internally as the function owner.
- Dashboard: the current-plan header hardcoded `/month`, so an annual subscriber saw
  "₹29,990/month". It now uses the subscription's real interval. Upgrade/downgrade
  labels now compare like with like instead of an annual price against a monthly one.
  Intervals with no provisioned provider plan are disabled rather than failing at
  checkout. Order usage is labelled "this month".
- Marketing pricing page guards a null `price_annual` instead of rendering "₹0/year".

---

## Not verified

- `npm install` / `npm run lint` / `npm run build` / `npx tsc --noEmit`:
  **NOT EXECUTED** — the build environment has no network access (npm registry
  returns 403). All 101 `.ts`/`.tsx` files parse cleanly, but that is a syntax check,
  not a type check. **Run the full toolchain before merging.**
- SQL runtime execution: **NOT EXECUTED** — no PostgreSQL instance available. The
  migration has not been run against a real database. Apply it to a staging copy of
  the 13.4 schema first.
- Razorpay API behaviour (`total_count` caps, `cancel_at_cycle_end` event ordering)
  was reasoned about, not exercised.

## Known behaviour worth a decision, not bugs

- `admin_update_plan_v2` locks a price permanently once its provider plan is
  provisioned. There is no plan-versioning path, so changing a live price requires a
  new plan id. This is a deliberate safety property of Build 14, not a defect, but
  it is a product constraint worth knowing about.
- The order-limit trigger takes a row lock on `organization_subscriptions` per
  insert, which serialises concurrent order creation within a single restaurant.
  That is the cost of closing the concurrent-quota-bypass hole; transactions are
  short, but it is worth watching under load.

---

# Second audit pass

A follow-up review raised three further findings. Two were real and are fixed
below; one was not reproducible.

## 11. Billing tables were readable by every staff member (fixed)

`lib/subscription-access.ts` gates every `/api/subscriptions/*` route behind
"OWNER, or staff holding `SUBSCRIPTION_MANAGEMENT`". The RLS on the underlying
tables did not match. The policies used `is_org_member()`, which is true for any
active staff row — waiter, kitchen, anyone — and the tables carry a matching
`grant select ... to authenticated`. Any staff member could read the full
subscription row straight through PostgREST with the browser client the app
already ships, and the API-layer gate would never see the request.

Build 14 did not create those policies, but it added most of the columns that now
leak through them (`price_annual_snapshot`, `selected_price_snapshot`,
`billing_period_*`, `pending_billing_interval`, `last_provider_event_id`), and it
created `subscription_audit_events` with the same member-wide policy.

**Fix:** new `can_view_organization_billing(p_organization_id)` helper — platform
admin, or org owner (`organizations.owner_id` *or* an `OWNER` staff row, since
Build 12 separated the two), or active staff with `SUBSCRIPTION_MANAGEMENT` or
`BILLING` allowed. It now backs the select policy on all three billing tables:
`organization_subscriptions`, `subscription_billing_events`,
`subscription_audit_events`.

No supported code path changes: every billing read in the app goes through a
SECURITY DEFINER RPC, which bypasses RLS. There are no direct client reads of these
tables anywhere in the repo (verified by grep).

## 12. Order-quota window could invert (fixed)

`subscription_order_window()` clipped `window_end` to the billing period end but
never clamped `window_start`. If `now()` drifted past a stale `current_period_end`
— a renewal webhook arriving late, for example — `window_end` could land before
`window_start`, the count query would match nothing, and usage would briefly
under-report. Not a bypass, but it is a window where the quota reads low.

**Fix:** if the window inverts, fall back to the trailing month ending at
`window_end`.

## Not reproduced: `record_subscription_webhook_event` grant

The follow-up review reported this function as still granted to `authenticated`.
It is not. `202609150017_build11_billing_completion.sql:301` does grant it, but
`202609150021_build11_provider_rpc_privileges.sql:8-9` revokes it from
`public, authenticated` and re-grants to `service_role` only — and that migration
runs later. No migration after it re-grants the function; Build 14 does not touch
it. The earlier grant line appears to have been read without the later revoke.

No behavioural change was needed. The revoke/grant pair is nonetheless restated at
the end of the Build 14 migration so the posture survives any future migration
reordering, since Build 14 runs last.
