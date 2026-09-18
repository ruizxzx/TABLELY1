# Build 18 fix — coupon UUID error + Manager branch-scoped access

## A. Exact root cause of `invalid input syntax for type uuid: "undefined"`

`app/settings/coupons/page.tsx`'s `load()` function read:

```js
const org = r.data.staff.organization_id;
```

`CurrentRestaurantContext['staff']` (`lib/restaurant-context.ts`) only returns
`{ id, role, can_kitchen, can_waiter }` — it does not include
`organization_id`. So `org` evaluated to `undefined`, and that `undefined`
was then passed into `.eq('organization_id', org)` on the branches query and
into the `list_coupons_v18` RPC call. This is the file-level bug that
produces a client-supplied `undefined` reaching a `uuid` column/parameter.

**Fix:** changed to `const org = r.data.organization.id;`, which is the field
that is actually populated on the context object.

**Caveat, stated plainly per your instructions:** I could not run this
codebase (no working `npm install` / no live Supabase instance in this
environment — see section G), so I have not watched this exact error
message fire and then confirm it disappears. The reasoning above (wrong
field → `undefined` → passed to a uuid-typed filter/param → Postgres error)
is the correct, verified defect in the code as written, and removing it
removes the only concrete mechanism in this file that could produce that
message. I did not find a second, independent site producing the same
error after searching every other branch-dependent client call in the
codebase (coupons page, staff/permissions page, charges/payments settings,
kitchen/tables/orders/service-requests channel subscriptions, customer
checkout/offers fetchers) — all other sites already guarded branch-id
usage behind a resolved, non-undefined value before this fix.

## B. Files changed

1. **`app/settings/coupons/page.tsx`** (rewritten)
   - Fixed the `staff.organization_id` → `organization.id` bug above.
   - Added a client-side gate: Owner, or Manager with `DISCOUNTS_COUPONS`
     granted (checked via `has_staff_permission` RPC) — anyone else sees an
     access-denied message and no coupon data is ever queried.
   - Branch-dependent queries only fire after `getCurrentRestaurantContext`
     has resolved and (for a Manager) the granted-permission check has
     completed — never before either is available.
   - Owner: branch selector defaults to their *currently active branch*
     when creating a coupon (not silently "All Branches"); "All branches"
     remains an explicit, separate option in the dropdown.
   - Manager: branch selector is replaced with a disabled, read-only field
     showing their own branch name. `save()` also force-overrides the
     branch id to the Manager's locked branch before calling the RPC, as a
     second (client-side, non-authoritative) layer on top of the
     server-side enforcement in (C).

2. **`lib/tablely-build12.ts`**
   - Added `['DISCOUNTS_COUPONS', 'Discounts / coupons']` to the existing
     `BUILD12_PERMISSIONS` list (no new permission system).

3. **`app/staff/permissions/page.tsx`**
   - Added `DISCOUNTS_COUPONS` to the existing "Finance" permission group
     so it renders in the Advanced Permissions grid automatically (this
     page already iterates `BUILD12_PERMISSIONS`, so no other change was
     needed for it to appear and be toggleable there).

## C. SQL migration added

**`supabase/migrations/202609170012_build18_coupon_manager_branch_scope.sql`**
— additive, does not touch or rewrite `202609170011_build18_discounts_coupons.sql`.

1. Seeds the new `DISCOUNTS_COUPONS` permission for all existing staff
   (owners = `true`, everyone else = `false`), and updates
   `ensure_default_staff_permissions()` (the existing trigger from Build 12
   / the branch-manager-delegation migration) to include it going forward,
   in the existing "sensitive, off-by-default for non-owners" bucket
   alongside `STAFF_MANAGEMENT`/`BRANCH_MANAGEMENT`.
2. Adds `resolve_coupon_actor_v18()` — a single server-side resolver
   reused by all four owner RPCs. Returns `(organization_id, is_owner,
   locked_branch_id)`:
   - True owner → `is_owner = true`, `locked_branch_id = null`.
   - `MANAGER` with `DISCOUNTS_COUPONS` granted → `is_owner = false`,
     `locked_branch_id` = their own `staff.branch_id` (never client-supplied).
   - Anyone else → raises `42501`.
3. Rewrites `list_coupons_v18`, `upsert_coupon_v18`, `get_coupon_config_v18`,
   `list_coupon_usage_v18` to call this resolver instead of the old
   hardcoded `role='OWNER'` lookup, and to use the resolved
   `locked_branch_id` — never a client-passed `p_branch_id` — for every
   Manager read/write. A Manager's `p_branch_id` argument is accepted by
   the function signature (for the owner code path) but is ignored/
   overridden on the Manager code path.
   - `upsert_coupon_v18` additionally checks, on edit, that the existing
     coupon's `branch_id` already equals the Manager's locked branch before
     allowing any change — a Manager can never edit a coupon belonging to
     another branch or an all-branch coupon, even one they can see.
   - `list_coupon_usage_v18` restricts a Manager to usage rows recorded
     under their own `branch_id`.
4. Did not touch: table definitions, RLS on `coupons`/`coupon_usages`/etc.
   (all writes still go exclusively through `security definer` RPCs, per
   the existing `revoke all ... from anon,authenticated,public` in the
   original Build 18 migration), the checkout/payment-first pipeline, or
   `build18_validate_coupon` / `preview_public_checkout_v18` /
   `get_public_active_offers_v18` (already correctly branch-scoped by
   `c.branch_id is null or c.branch_id = v_table.branch_id` checks in the
   original migration — verified by full read-through, unchanged).

## D. Owner behavior (as implemented)

- Sees all branches; can pick current branch, another branch, or explicitly
  "All Branches" when creating/editing a coupon.
- Default selection when opening "New coupon" is the branch currently
  active in their session — never silently all-branch.
- Unaffected in every other respect (list/edit/disable/usage across any
  branch or all-branch coupons, exactly as before).

## E. Manager behavior (as implemented)

- No access to `/settings/coupons` at all unless the owner has explicitly
  turned on `DISCOUNTS_COUPONS` for them in Advanced Permissions (default:
  off for every non-owner).
- With it granted: sees and can create/edit/enable/disable coupons scoped
  to their own assigned branch only. Cannot see, create, or edit coupons
  belonging to another branch. The branch selector in the UI is a
  disabled/read-only field, not a dropdown, so there is no control to even
  attempt a different value from — and the server independently ignores/
  overrides any `p_branch_id` a manipulated request might still send.
- I did not add a way for a Manager to see all-branch coupons that also
  apply to their branch (they see only coupons with `branch_id` exactly
  equal to their own). The spec did not explicitly resolve this edge case
  either way; I chose the more restrictive reading ("ONLY for their
  assigned branch") rather than assume broader visibility. Flagging this
  as a judgment call in case you want the opposite behavior.

## F. Customer branch-scope behavior

Unchanged — already correct in the original Build 18 migration, verified
by reading `build18_validate_coupon`, `preview_public_checkout_v18`, and
`get_public_active_offers_v18` in full. A branch-scoped coupon does not
appear in offers, cannot be validated, and cannot affect totals for any
other branch; a manipulated coupon-code submission for the wrong branch is
rejected server-side (`raise exception 'Coupon not valid for this branch'`).

## G. Tests/checks actually run

- Read every relevant file in full before editing (coupons page,
  restaurant-context.ts, the full 792-line Build 18 migration, the
  branch-manager-delegation migration, the permissions page/table/RLS,
  StudioShell.tsx's own branch-loading code, middleware.ts is unrelated to
  this feature and was not touched).
- Searched the entire codebase for every other read/write of
  `staff.organization_id` against the context-return type, and for every
  other branch-id-dependent client call site, to check whether the same
  class of bug existed elsewhere. None found beyond the one file.
- Brace/paren/bracket balance check (script-based) on every `.ts`/`.tsx`
  file touched — all balanced.
- Dollar-quote pair count check on the new SQL migration (12 `$$` = 6
  function bodies opened and closed) — balanced.
- Manual, full read-through of the new SQL migration and the rewritten
  coupons page for logical consistency (variable names, branch-lock flow,
  owner-vs-manager branching) after editing.

## H. What could NOT be tested (be aware of this before deploying)

- **No `npm install`, `tsc`, `next build`, or lint was run.** This sandbox
  has no network access to the npm registry (confirmed by a direct
  `npm install` attempt returning `403 Forbidden`), so none of Builds 1–18
  including this fix have ever been compiled or type-checked by me in this
  environment. You must run these yourself before deploying:
  ```
  npm install
  npm run typecheck   # or: npx tsc --noEmit
  npm run lint
  npm run build
  ```
- **No SQL was executed against a real Postgres/Supabase instance.** The
  migration has not been run; I cannot rule out a syntax slip I didn't
  catch by manual review (though the balance checks and careful
  convention-matching against your existing `is_branch_manager_with_permission`
  pattern make this unlikely).
- **The exact production reproduction of the UUID error was not watched
  and confirmed fixed live** — see the caveat in section A.
- I did not test the 21-point manual test list from your task doc against
  a running app, for the same no-environment reason. Please run through it
  after deploying to a real dev/staging Supabase project, in that order:
  migration → app.

## I. Migration order

Run after `202609170011_build18_discounts_coupons.sql` and after every
migration already in your project (this one assumes `staff_permissions`,
`is_branch_manager_with_permission`, and the `coupons` tables already
exist). No destructive changes; safe to run against existing data.
