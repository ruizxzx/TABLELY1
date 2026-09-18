-- Branch Manager staff actions and scoped staff visibility.
-- Depends on 202609150037_branch_manager_delegation.sql.

-- Managers with STAFF_MANAGEMENT can see staff for their own branch.
-- Owners retain organization-wide visibility.
drop function if exists public.list_staff_with_email();
create or replace function public.list_staff_with_email()
returns table(
  id uuid,
  user_id uuid,
  role public.staff_role,
  active boolean,
  display_name text,
  created_at timestamptz,
  can_kitchen boolean,
  can_waiter boolean,
  branch_id uuid,
  email text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_user uuid := auth.uid();
  v_owner_org uuid;
  v_manager_branch uuid;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode='42501';
  end if;

  select s.organization_id into v_owner_org
  from public.staff s
  where s.user_id = v_user and s.active = true and s.role = 'OWNER'
  order by s.created_at
  limit 1;

  if v_owner_org is not null then
    return query
      select s.id, s.user_id, s.role, s.active, s.display_name, s.created_at,
             s.can_kitchen, s.can_waiter, s.branch_id, au.email::text
      from public.staff s
      left join auth.users au on au.id = s.user_id
      where s.organization_id = v_owner_org
      order by s.created_at;
    return;
  end if;

  select s.branch_id into v_manager_branch
  from public.staff s
  where s.user_id = v_user and s.active = true and s.role = 'MANAGER'
    and public.is_branch_manager_with_permission(s.branch_id, 'STAFF_MANAGEMENT')
  order by s.created_at
  limit 1;

  if v_manager_branch is null then
    raise exception 'Only the owner or a branch manager with staff-management access can view staff' using errcode='42501';
  end if;

  return query
    select s.id, s.user_id, s.role, s.active, s.display_name, s.created_at,
           s.can_kitchen, s.can_waiter, s.branch_id, au.email::text
    from public.staff s
    left join auth.users au on au.id = s.user_id
    where s.branch_id = v_manager_branch
    order by s.created_at;
end;
$$;
grant execute on function public.list_staff_with_email() to authenticated;

-- Owners can enable/disable any non-owner staff in their organization.
-- Delegated Branch Managers can only enable/disable Waiter/Kitchen staff on
-- their own branch. Owners themselves can never be disabled here.
create or replace function public.set_staff_active(p_staff_id uuid,p_active boolean)
returns public.staff
language plpgsql
security definer
set search_path=public
as $$
declare
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_authorized boolean := false;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode='42501';
  end if;

  select * into v_staff from public.staff where id=p_staff_id for update;
  if v_staff.id is null then
    raise exception 'Staff member not found' using errcode='404';
  end if;

  if public.is_org_owner(v_staff.organization_id) then
    v_authorized := true;
  elsif v_staff.role in ('WAITER'::public.staff_role,'KITCHEN'::public.staff_role)
        and public.is_branch_manager_with_permission(v_staff.branch_id,'STAFF_MANAGEMENT') then
    v_authorized := true;
  end if;

  if not v_authorized then
    raise exception 'Only the owner or a branch manager with staff-management access can change this staff member' using errcode='42501';
  end if;

  if v_staff.role='OWNER' then
    raise exception 'Owner cannot be disabled' using errcode='42501';
  end if;

  update public.staff
  set active=p_active, updated_at=now()
  where id=p_staff_id
  returning * into v_staff;
  return v_staff;
end;
$$;
grant execute on function public.set_staff_active(uuid,boolean) to authenticated;

select pg_notify('pgrst','reload schema');
