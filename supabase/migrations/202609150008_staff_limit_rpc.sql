-- Staff invitation plan-limit RPC.
create or replace function public.organization_can_add_staff(p_organization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.staff s
    where s.organization_id = p_organization_id
      and s.user_id = v_user
      and s.active = true
      and s.role = 'OWNER'
  ) then
    raise exception 'Only the owner can check the staff limit' using errcode = '42501';
  end if;

  select case
    when sp.features ? 'max_staff' and sp.features->>'max_staff' is not null
      then (sp.features->>'max_staff')::integer
    else null
  end
  into v_limit
  from public.organization_subscriptions os
  join public.saas_plans sp on sp.id = os.plan_id and sp.active = true
  where os.organization_id = p_organization_id
    and os.status in ('TRIAL', 'ACTIVE');

  if v_limit is null then
    return true;
  end if;

  select count(*)::integer
  into v_count
  from public.staff s
  where s.organization_id = p_organization_id
    and s.active = true
    and s.role <> 'OWNER';

  return v_count < greatest(v_limit, 0);
end;
$$;

grant execute on function public.organization_can_add_staff(uuid) to authenticated;
