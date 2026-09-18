# Fixes applied to Build 15 (kitchen order acceptance)

This package is the clean **TABLELY-BUILD14-SUBSCRIPTION-V2-AUDIT-FIXED-V5**
base with a corrected `202609170001_build15_kitchen_acceptance.sql`, plus
the unmodified Build 15 app-layer files (kitchen page, staff page,
cancellation component, login/reset-password, globals.css). Confirmed by
diffing this V5 base's migration history against the original Build 15
zip: this base did **not** already have any of the three bugs below —
they were introduced fresh by the Build 15 migration itself while
rewriting nearby functions to add the kitchen-acceptance feature.

## 1. CRITICAL — reintroduced anonymous cancellation-bypass, removed again

The original Build 15 migration recreated
`request_order_cancellation(p_order_id uuid, p_reason text)` — a
2-argument overload with **no ownership/tracking-token check at all**,
granted to `anon`. This exact vulnerability had already been fixed twice
before (`202609160002_build13_audit_fixes.sql` being the most recent
drop). The app itself has only ever called the secure 3-argument version.

**Fix:** the corrected migration keeps the 3-argument signature
(`p_order_id, p_tracking_token, p_reason`) with the tracking-token
ownership check intact, and explicitly re-drops the insecure 2-argument
overload at the end of the migration as a defense-in-depth measure, with
a comment flagging that it has now been accidentally reintroduced twice
and must never come back.

## 2. HIGH — two payment-integrity guards dropped from `transition_order_status`

Rewriting this function to add the kitchen-acceptance gate silently
dropped two checks present in the version it replaced
(`202609160005_build13_3_payment_state_fix.sql`, from the Build 13.3
"payment-first order creation" work):

- the guard blocking any status action on a `PAY_NOW` order still at
  `NEW`/`PENDING` (i.e. before the customer actually paid)
- the guard requiring `payment_status = 'PAID'` before an order can move
  to `COMPLETED`

**Fix:** both guards are restored in their original positions, with
comments noting they were restored and why.

## 3. MEDIUM — cancellation-request notification bypassed the owner notification-preference system

While fixing #1, I found a third, related problem: the rewritten
`request_order_cancellation` sent the Owner notification via a raw
`insert into notifications`, bypassing `public.create_staff_notification()`
— which is what actually checks `owner_notification_preferences` (added
in Build 13.4). An Owner who had opted out of a branch's notifications
would still have been notified; in some multi-branch setups the raw
insert's `s.branch_id = v_order.branch_id and s.role = 'OWNER'` condition
could also simply match no row and silently notify no one.

**Fix:** the corrected version calls `create_staff_notification(...,
ARRAY['OWNER'], ...)` for the Owner (respecting their preference and using
the canonical owner-staff resolution), and keeps a direct insert only for
the branch-local wait-capable, non-Manager, non-Owner staff — since
`can_waiter` is a flag rather than a fixed role and can't be expressed
through `create_staff_notification`'s role-array filter.

## 4. Reverted an unrequested behavior change: Manager notifications

While fixing #3 above, the original Build 15 migration also **removed
Manager entirely** from cancellation-request notifications
(`ARRAY['OWNER']` instead of `ARRAY['OWNER','MANAGER']`). This was never
asked for — the feature spec only ever restricted Manager from *deciding*
a cancellation request (`decide_order_cancellation`), and Manager being a
notification recipient predates Build 15 and was working as intended.

**Fix:** `request_order_cancellation` now notifies Owner **and** Manager
again (both through `create_staff_notification`, so the Owner's
notification-preference opt-out still applies). The restriction on
Manager *deciding* cancellation requests (`decide_order_cancellation`)
and the in-app action panel being hidden from Manager
(`OrderCancellationRequests.tsx`'s `canHandle` check) are both unchanged
and correct — Manager sees/gets notified that a request exists, but still
can't approve or reject it, matching the original spec.

## 5. Reverted: Manager can decide cancellation requests again (Build 14 behavior restored)

The person confirmed Manager being able to accept/reject a customer
cancellation request is existing, wanted Build 14 behavior — it was never
something this feature was supposed to change. `decide_order_cancellation`
now allows `role in ('OWNER','MANAGER') or can_waiter` again (matching
`202609160011_build13_4_cancellation_ux_fixes.sql`, the last version
before Build 15 touched it), and `OrderCancellationRequests.tsx`'s
`canHandle` check includes `MANAGER` again so the Accept/Reject panel is
visible to them. A stale message on the Staff page claiming cancellation
requests "are not available to Branch Managers" was also removed.

**Net effect on cancellation requests after all of this build's fixes:**
Manager behavior is now identical to Build 14 — notified, and able to
accept/reject. The only actual change from Build 14 in this build is the
new, unrelated Kitchen order-acceptance toggle and its realtime delivery.

## 6. Fixed: "Accept order" did nothing on the Kitchen page

The person reported the real symptom: Kitchen order acceptance
notification came through in realtime, but clicking "Accept order" did
nothing — the order only got accepted if a Manager did it from the
`/orders` page instead (which then reached Kitchen via the realtime
UPDATE it was already subscribed to, making it look like Kitchen's own
button just wasn't wired to anything).

**Root cause:** in `app/kitchen/page.tsx`, the `advance()` click handler's
status-transition ternary only covered `ACCEPTED → PREPARING` and
`PREPARING → READY`:

```js
const target = o.status==='ACCEPTED' ? 'PREPARING' : o.status==='PREPARING' ? 'READY' : null;
```

It never handled `NEW → ACCEPTED` at all. Since "Accept order" only shows
for `status==='NEW'`, `target` always evaluated to `null` for that click,
and the function returned before ever calling `transition_order_status` —
no RPC call, no error, nothing. This was a plain frontend bug, unrelated
to the SQL/authorization work above; the backend RPC itself was already
correct (proven by the Manager's Accept button on `/orders` working).

**Fix:** added the missing case —
`o.status==='NEW' ? 'ACCEPTED' : ...` — so Kitchen's own Accept button now
actually calls the RPC.

## What was left untouched

Everything else in the original Build 15 migration and app files matched
the feature spec correctly and needed no changes: the branch-scoped
`kitchen_accept_orders` column and its `get_/set_kitchen_order_acceptance`
RPCs, the Manager-exclusion in `decide_order_cancellation`, the realtime
Kitchen subscription (branch-filtered, with proper cleanup), the Kitchen
UI's accept-button gating, the audit log entry, and the forgot-password
flow.

## Apply order

```
... (all Build 14 V5 migrations, unchanged, through 202609160013) ...
202609170001_build15_kitchen_acceptance.sql   <- corrected version, from this zip
```

## Still not verified here

Same standing limitation as every previous round: no network access in
this sandbox for `npm install`/`typecheck`/`build`/`lint`, and no live
Supabase or browser to actually execute this migration or click through
the flows. Please run those before deploying.
