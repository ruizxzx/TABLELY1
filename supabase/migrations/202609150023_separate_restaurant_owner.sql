-- Separate the restaurant owner account from the Tablely platform-admin account.
do $$
declare
  v_target_user uuid;
  v_old_owner uuid;
  v_org_id uuid;
  v_branch_id uuid;
  v_old_staff_id uuid;
begin
  select id into v_target_user
  from auth.users
  where lower(email) = 'technicalvines1234@gmail.com';
  if v_target_user is null then
    raise exception 'Target restaurant owner account was not found';
  end if;

  select o.id, o.owner_id into v_org_id, v_old_owner
  from public.organizations o
  where o.name = 'Golpo Ghor'
  limit 1;
  if v_org_id is null then
    raise exception 'Restaurant workspace Golpo Ghor was not found';
  end if;

  select s.id, s.branch_id into v_old_staff_id, v_branch_id
  from public.staff s
  where s.organization_id = v_org_id
    and s.user_id = v_old_owner
    and s.role = 'OWNER'
  order by s.created_at
  limit 1;
  if v_branch_id is null then
    select b.id into v_branch_id
    from public.branches b
    where b.organization_id = v_org_id
    order by b.created_at
    limit 1;
  end if;

  update public.organizations
  set owner_id = v_target_user, updated_at = now()
  where id = v_org_id;

  if exists (select 1 from public.staff where user_id = v_target_user and organization_id = v_org_id and branch_id = v_branch_id) then
    update public.staff
    set role = 'OWNER', active = true, can_kitchen = true, can_waiter = true, updated_at = now()
    where user_id = v_target_user and organization_id = v_org_id and branch_id = v_branch_id;
  else
    insert into public.staff(user_id, organization_id, branch_id, role, active, can_kitchen, can_waiter)
    values(v_target_user, v_org_id, v_branch_id, 'OWNER', true, true, true);
  end if;

  if v_old_staff_id is not null and v_old_owner <> v_target_user then
    update public.staff
    set active = false, updated_at = now()
    where id = v_old_staff_id;
  end if;
end;
$$;
