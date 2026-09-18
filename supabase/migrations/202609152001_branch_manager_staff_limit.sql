-- Allow delegated Branch Managers to pass the staff-limit check for their own branch.
-- The legacy one-argument organization_can_add_staff(uuid) remains owner-only
-- for backward compatibility; the staff invite API uses this branch-scoped RPC.

create or replace function public.organization_can_add_staff_for_branch(
  p_organization_id uuid,
  p_branch_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
  v_user uuid := auth.uid();
  v_authorized boolean := false;
  v_branch_org uuid;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select b.organization_id into v_branch_org
  from public.branches b
  where b.id = p_branch_id and b.is_active = true;

  if v_branch_org is null or v_branch_org <> p_organization_id then
    raise exception 'Invalid branch for this organization' using errcode = '42501';
  end if;

  if public.is_org_owner(p_organization_id) then
    v_authorized := true;
  elsif public.is_branch_manager_with_permission(p_branch_id, 'STAFF_MANAGEMENT') then
    v_authorized := true;
  end if;

  if not v_authorized then
    raise exception 'Only the owner or a branch manager with staff-management access can check the staff limit' using errcode = '42501';
  end if;

  select nullif(sp.features->>'max_staff','')::integer
  into v_limit
  from public.organization_subscriptions os
  join public.saas_plans sp on sp.id = os.plan_id and sp.active = true
  where os.organization_id = p_organization_id
    and os.status in ('TRIAL','ACTIVE')
  order by os.updated_at desc nulls last
  limit 1;

  if v_limit is null then
    return true;
  end if;

  select count(*)::integer into v_count
  from public.staff s
  where s.organization_id = p_organization_id
    and s.active = true
    and s.role <> 'OWNER';

  return v_count < greatest(v_limit, 0);
end;
$$;

grant execute on function public.organization_can_add_staff_for_branch(uuid,uuid) to authenticated;

select pg_notify('pgrst','reload schema');
