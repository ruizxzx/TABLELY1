# Build 12 Hotfix — Owner "permission denied" bug

## Root cause

Two different, disconnected definitions of "owner" existed in the codebase:

1. `organizations.owner_id` — the real source of truth. Checked by `is_org_owner()`,
   used by branches, branding, and domain management (all worked correctly).
2. `staff.role = 'OWNER'` — a separately-set column. Checked directly by Build 12's
   new `can_manage_permissions()` (used in the `staff_permissions` RLS policy for
   `/staff/permissions`) and by `get_build12_cross_branch_analytics()`.

Nothing kept these two in sync. Any restaurant owner whose `staff.role` wasn't
exactly `'OWNER'` — from onboarding order-of-operations, a duplicate/stale
`staff` row (now more likely since Build 12 allows multi-branch staff
assignment), or old data from earlier builds — would pass owner checks in most
of the app but hit **"Only the owner can manage advanced permissions"** or
**"Only the owner can view cross-branch reporting"** (Postgres error 42501) in
the two Build 12 features that checked `staff.role` instead of `owner_id`.

The existing `202609150023_separate_restaurant_owner.sql` migration was a
one-off hand patch for a single account (`technicalvines1234@gmail.com` /
"Golpo Ghor"), not a structural fix — so the same class of bug kept coming
back for other owners in later builds.

## Fix — `202609150031_build12_owner_permission_fix.sql`

1. **Data repair (idempotent):** for every organization, ensures the account
   in `organizations.owner_id` has an active `staff` row with `role='OWNER'`
   in that org (creating one if missing), and demotes any *other* staff row
   in the org that incorrectly claims `OWNER`.
2. **`can_manage_permissions()` rewritten** to check `is_org_owner()`
   (i.e. `organizations.owner_id`) instead of `staff.role` — so it can never
   drift from the real owner again.
3. **`get_build12_cross_branch_analytics()` rewritten** the same way.
4. **New trigger `organizations_owner_change_sync`**: if `owner_id` is ever
   transferred to a different user, automatically demotes the old owner's
   staff role and promotes/creates the new owner's staff row, so the two
   representations of ownership can't fall out of sync going forward.

## App-layer defense (`lib/restaurant-context.ts`, `components/StudioShell.tsx`)

Both loaded "the" current staff row with `.order('created_at').limit(1)`,
so if a user ever ends up with more than one active `staff` row (now
possible with multi-branch), the oldest row could load — silently
demoting an owner to whatever role that row had. Both now fetch all
active staff rows for the user and explicitly prefer the `OWNER` row if
one exists.

## To apply

1. Run `202609150031_build12_owner_permission_fix.sql` against the linked
   Supabase project (after `202609150030_build12_...sql`).
2. No app redeploy is strictly required for the SQL fix alone, but the two
   updated `.ts`/`.tsx` files should be deployed together with it.
3. Verify: log in as an owner whose `staff.role` was previously wrong (or
   who has staff rows in multiple branches) and confirm `/staff/permissions`
   and cross-branch analytics no longer return "permission denied."

## Not fixed here

As before, this workspace has no installable `node_modules`, so
`npm run typecheck` / `npm run build` still could not be run to verify
compilation. Only static review + brace/dollar-quote balance checks were
possible. Run the full build/typecheck in your real dev environment before
deploying.
