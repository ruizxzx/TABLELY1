# Fixes applied on top of TABLELY-BUILD13-AUTHORIZATION-SECURITY-HARDENED

This note supersedes the previous one (the `get_user_id_by_email` fix from
Build 12 is still included, unchanged, in
`202609152002_lock_down_get_user_id_by_email.sql`).

New file: `supabase/migrations/202609160002_build13_audit_fixes.sql`

## 1. CRITICAL — insecure order-cancellation overload removed

`request_order_cancellation(uuid, text)` (no tracking-token argument) had
been correctly dropped in `202609141000_build6_10_operations_money_admin.sql`,
then unintentionally **recreated** — still `security definer`, still
granted to `anon` — by the later migration
`202609142300_staff_access_google_settings.sql`. Because Postgres treats
different argument lists as distinct overloaded functions, both the
insecure 2-arg version and the secure 3-arg version (which requires the
caller to supply the order's actual `tracking_token`) have existed side by
side ever since. Any anonymous caller who obtained or guessed an order
UUID could file a cancellation request against **any order in any
organization**, with no ownership, branch, or org check.

**Fix:** the new migration revokes execute and drops the insecure 2-arg
overload. The app already only calls the secure 3-arg version
(`components/customer/CustomerOrderClient.tsx`), so no application code
needed to change.

## 2. MEDIUM — inconsistent revenue definition across analytics RPCs

`get_branch_analytics()` and `get_build12_analytics()` counted revenue for
any order with `payment_status = 'PAID'`, including ones later
`CANCELLED`, while `get_build12_cross_branch_analytics()` excluded
cancelled orders from revenue. Same underlying data, two different
numbers depending on which screen you looked at.

**Fix:** both functions now define revenue (and AOV / online / counter
revenue) the same way as cross-branch analytics: `payment_status = 'PAID'
AND status <> 'CANCELLED'`.

## 3. MEDIUM — Managers had no way to know their own permissions client-side

`staff_permissions` could previously only be read by an organization
owner. Non-owner staff's own permission rows were invisible to their own
client, so the app UI could not hide a nav item a Manager isn't allowed to
use — enforcement was correct at the RPC/RLS layer, but the UI gave no
early feedback and always showed every Manager-eligible nav item
regardless of their actual granted permissions.

**Fix (SQL):** `staff_permissions_select` now also allows a staff member
to read their own rows (`s.user_id = auth.uid()`), in addition to the
existing owner-management access. Nobody's write access changed — only an
authorized owner can still call `set_staff_permission()`.

**Fix (app):** `components/StudioShell.tsx` now fetches the logged-in
Manager's own `staff_permissions` and hides nav items (Staff, Payments,
Analytics, Menu, Bills, Kitchen, Subscription) when the corresponding
permission (`STAFF_MANAGEMENT`, `PAYMENTS`, `ANALYTICS`,
`MENU_MANAGEMENT`, `BILLING`, `KITCHEN_ACCESS`,
`SUBSCRIPTION_MANAGEMENT`) is off. Owners are unaffected — they always see
everything their role already allows. This is a UX improvement, not a new
authorization boundary; the server-side RPC/RLS checks remain the actual
enforcement point.

## 4. MEDIUM — internal error messages returned to anonymous callers

`app/api/payments/create`, `app/api/payments/verify`,
`app/api/payments/webhook`, and `app/api/subscriptions/webhook` returned
raw Postgres/Supabase error text (`error.message`) directly to the caller
on failure. These are the four anonymous/public-facing routes in the API
surface, so this could leak internal implementation details to an
unauthenticated caller.

**Fix:** all four now return a fixed, generic error message to the caller
and log the real error server-side with `console.error` for debugging.

**Scope note:** the same `.message` pattern exists in several
*authenticated, owner/manager-only* routes (`app/api/admin/*`,
`app/api/subscriptions/{create,cancel,change,history,invoices,me,plans,verify}`,
`app/api/staff/invite`, `app/api/settings/*`). Those are reached only by
logged-in staff viewing their own organization's data, so the severity is
much lower (an owner seeing a raw Postgres error about their own account,
not a stranger). I left those as-is rather than doing a blanket rewrite
across a dozen more files without being asked; happy to do that pass too
if you want it.

## 5. LOW — no lint script existed at all

`package.json` had no `lint` script and the project had no ESLint config,
so lint compliance wasn't even checkable. Added:

- `"lint": "eslint ."` script
- `eslint.config.mjs` using `next/core-web-vitals` + `next/typescript`
- `eslint`, `eslint-config-next`, `@eslint/eslintrc` as devDependencies

**Not run here** — this sandbox has no network access to `npm install`,
so I could not actually execute `npm run lint`/`typecheck`/`build` against
this config. Please run those three locally before deploying; that's the
one verification step I can't substitute for.

## 6. LOW/MEDIUM — Settings nav item wasn't gated by the SETTINGS permission (found by a second review pass)

`PERMISSION_FOR_HREF` in `StudioShell.tsx` was missing a `'/settings':
'SETTINGS'` entry, so a Manager with `SETTINGS = OFF` would still see the
Settings nav item. I checked the actual impact before "fixing" it for
appearances: every settings-affecting operation
(`app/api/settings/charges`, `app/api/settings/payment`,
`update_build12_branding()`, `create_organization_domain()`) is hardcoded
to `is_org_owner()`/`role === 'OWNER'` at the server/RPC layer, regardless
of the `SETTINGS` permission — so this was never an authorization bypass,
only a UI inconsistency (a Manager would land on a page that then
rejected every action). Also checked and ruled out: a claim that
`KITCHEN_ACCESS` might not match what's actually stored in the database —
it does; every seed, whitelist, and RLS/RPC check uses the string
`'KITCHEN_ACCESS'` consistently, so nothing there needed fixing.

**Fix:** added `'/settings': 'SETTINGS'` to `PERMISSION_FOR_HREF`, so the
nav item is now hidden for Managers without the `SETTINGS` permission,
consistent with how Staff/Payments/Analytics/etc. already behave.

## Apply order

```
... (all existing Build 12 / 13 migrations, unchanged) ...
202609160001_build13_authorization_security.sql
202609160002_build13_audit_fixes.sql   <- new, apply last
```
