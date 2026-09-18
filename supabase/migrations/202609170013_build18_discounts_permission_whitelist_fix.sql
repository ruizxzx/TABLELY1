-- Fix: "Unsupported permission" when an owner tries to grant
-- "Discounts / coupons" to a Manager in Advanced Permissions.
--
-- Root cause: 202609170012_build18_coupon_manager_branch_scope.sql correctly
-- seeded the DISCOUNTS_COUPONS permission row for every staff member and
-- added it to ensure_default_staff_permissions() (so new staff get a
-- default value), but missed that set_staff_permission() -- the RPC the
-- /staff/permissions UI actually calls when the owner clicks a toggle --
-- has its own, separate hardcoded whitelist of valid permission keys
-- (from 202609160001_build13_authorization_security.sql, which superseded
-- the Build 12 version of this same function). DISCOUNTS_COUPONS was never
-- added to that whitelist, so every toggle attempt was rejected with
-- "Unsupported permission" even though the underlying permission system
-- itself was already correctly wired up.
--
-- Fix: widen the same whitelist to include DISCOUNTS_COUPONS. No other
-- behavior of set_staff_permission changes.
-- Additive/idempotent.

create or replace function public.set_staff_permission(
  p_staff_id uuid,
  p_permission text,
  p_allowed boolean
)
returns public.staff_permissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff_permissions;
  v_target public.staff%rowtype;
  v_permission text := upper(trim(coalesce(p_permission, '')));
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if v_permission not in (
    'VIEW_ORDERS',
    'EDIT_ORDERS',
    'CANCEL_ORDERS',
    'KITCHEN_ACCESS',
    'BILLING',
    'CHARGES',
    'PAYMENTS',
    'STAFF_MANAGEMENT',
    'ANALYTICS',
    'SETTINGS',
    'MENU_MANAGEMENT',
    'BRANCH_MANAGEMENT',
    'SUBSCRIPTION_MANAGEMENT',
    'DISCOUNTS_COUPONS'
  ) then
    raise exception 'Unsupported permission';
  end if;

  select * into v_target
  from public.staff s
  where s.id = p_staff_id
  for update;

  if v_target.id is null then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  if v_target.role = 'OWNER'::public.staff_role then
    raise exception 'Owner permissions cannot be modified' using errcode = '42501';
  end if;

  if not public.can_manage_permissions(p_staff_id) then
    raise exception 'Only an authorized owner can manage advanced permissions' using errcode = '42501';
  end if;

  insert into public.staff_permissions(staff_id, permission, allowed)
  values (p_staff_id, v_permission, coalesce(p_allowed, false))
  on conflict (staff_id, permission)
  do update set allowed = excluded.allowed, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.set_staff_permission(uuid,text,boolean) to authenticated;
revoke execute on function public.set_staff_permission(uuid,text,boolean) from anon, public;

select pg_notify('pgrst','reload schema');
