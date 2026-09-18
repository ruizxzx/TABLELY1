-- Fix: owner locked out of tables/menu/orders/analytics/service-requests on
-- any branch other than the one branch their own `staff` row happens to
-- point to (e.g. "You do not have permission to manage this menu" after
-- creating and switching to a new branch).
--
-- Root cause: is_branch_member() and is_branch_manager_or_owner() are
-- Build 2-era functions, written before multi-branch existed. They only
-- check `staff.branch_id = target_branch` for the calling user. An owner
-- has exactly one staff row with one branch_id (their original/main
-- branch), so these checks correctly pass for that branch and incorrectly
-- fail for every other branch in the same organization -- even though the
-- owner should have access across all of their own branches.
--
-- These two functions gate a large surface: tables, menu_items,
-- menu_categories RPCs, menu image uploads, orders, order_events,
-- order_cancellation_requests, service_requests, and branch analytics.
-- Fixing them here fixes all of those call sites at once, with no other
-- migration changes required.
--
-- Fix: both functions now also pass if the caller is the real organization
-- owner (organizations.owner_id) of the branch in question, regardless of
-- which single branch their own staff row is tied to. Non-owner staff
-- (managers/waiters/kitchen) are unaffected -- they still only pass for
-- their own assigned branch_id, exactly as before.
-- Additive/idempotent.

create or replace function public.is_branch_member(target_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff s
    where s.branch_id = target_branch and s.user_id = auth.uid() and s.active = true
  )
  or exists (
    select 1 from public.branches b
    where b.id = target_branch and public.is_org_owner(b.organization_id)
  );
$$;
grant execute on function public.is_branch_member(uuid) to authenticated;

create or replace function public.is_branch_manager_or_owner(target_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff s
    where s.branch_id = target_branch
      and s.user_id = auth.uid()
      and s.role in ('OWNER'::public.staff_role, 'MANAGER'::public.staff_role)
      and s.active = true
  )
  or exists (
    select 1 from public.branches b
    where b.id = target_branch and public.is_org_owner(b.organization_id)
  );
$$;
grant execute on function public.is_branch_manager_or_owner(uuid) to authenticated;

select pg_notify('pgrst','reload schema');
