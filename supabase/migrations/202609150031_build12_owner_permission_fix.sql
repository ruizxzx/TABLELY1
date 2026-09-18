-- TABLELY BUILD 12 HOTFIX — Owner permission-denied bug
-- Root cause: `organizations.owner_id` is the real source of truth for who
-- owns a restaurant, but Build 12's permissions feature (can_manage_permissions,
-- staff_permissions RLS) and the analytics RPC independently re-derived
-- "owner" from staff.role = 'OWNER'. Those two can drift apart (wrong role on
-- a staff row, duplicate staff rows, role set before the OWNER enum value
-- existed, etc.), so the real owner passes owner-only checks in some places
-- (branches, branding, domains) and gets 42501 "permission denied" in others
-- (staff permissions, cross-branch analytics). This migration:
--   1. Repairs any existing drift so every organization's real owner has a
--      correctly-flagged staff row.
--   2. Makes ownership checks derive from organizations.owner_id everywhere,
--      so staff.role can never again disagree with the real owner.
-- Additive/idempotent.

-- 1) Repair drift: for every organization, make sure the auth user in
--    owner_id has an active staff row with role = 'OWNER' in that org.
--    Demote any other staff row in the org that incorrectly claims OWNER.
do $$
declare
  r record;
  v_staff_id uuid;
  v_branch_id uuid;
begin
  for r in select id as org_id, owner_id from public.organizations where owner_id is not null loop

    -- Does the real owner already have a staff row in this org?
    select id into v_staff_id
    from public.staff
    where organization_id = r.org_id and user_id = r.owner_id
    order by created_at
    limit 1;

    if v_staff_id is not null then
      update public.staff
      set role = 'OWNER', active = true, updated_at = now()
      where id = v_staff_id;
    else
      -- No staff row for the real owner yet: create one on the org's oldest
      -- active branch (falls back to oldest branch of any status).
      select id into v_branch_id
      from public.branches
      where organization_id = r.org_id and is_active
      order by created_at
      limit 1;
      if v_branch_id is null then
        select id into v_branch_id from public.branches where organization_id = r.org_id order by created_at limit 1;
      end if;

      if v_branch_id is not null then
        insert into public.staff(user_id, organization_id, branch_id, role, active, can_kitchen, can_waiter)
        values (r.owner_id, r.org_id, v_branch_id, 'OWNER', true, true, true)
        on conflict do nothing;
      end if;
    end if;

    -- Demote any other staff row in this org that claims OWNER but isn't
    -- the real owner (drift from a previous build / bad data).
    update public.staff
    set role = 'MANAGER', updated_at = now()
    where organization_id = r.org_id
      and role = 'OWNER'
      and user_id is distinct from r.owner_id;

  end loop;
end;
$$;

-- 2) Make can_manage_permissions derive from is_org_owner (organizations.owner_id)
--    instead of staff.role, so it can never drift again.
create or replace function public.can_manage_permissions(p_staff_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.staff target
    where target.id = p_staff_id
      and public.is_org_owner(target.organization_id)
  );
$$;
grant execute on function public.can_manage_permissions(uuid) to authenticated;

-- 3) Same fix for cross-branch analytics: use is_org_owner against the
--    caller's organization instead of trusting staff.role directly.
create or replace function public.get_build12_cross_branch_analytics(p_from timestamptz, p_to timestamptz)
returns table(branch_id uuid, branch_name text, revenue numeric, orders bigint, average_order_value numeric, cancelled bigint)
language plpgsql stable security definer set search_path=public as $$
declare v_org uuid;
begin
  select o.id into v_org
  from public.organizations o
  where o.owner_id = auth.uid()
  limit 1;

  if v_org is null then
    raise exception 'Only the owner can view cross-branch reporting' using errcode='42501';
  end if;
  if not public.organization_has_feature(v_org, 'CROSS_BRANCH_REPORTING') then
    raise exception 'Cross-branch reporting is not available on the current Tablely plan' using errcode='42501';
  end if;

  return query select b.id, b.name,
    coalesce(sum(o.total) filter(where o.payment_status='PAID'),0), count(o.id), coalesce(avg(o.total),0),
    count(o.id) filter(where o.status='CANCELLED')
    from public.branches b left join public.orders o on o.branch_id=b.id and o.created_at>=p_from and o.created_at<p_to
    where b.organization_id=v_org group by b.id,b.name order by revenue desc;
end; $$;
grant execute on function public.get_build12_cross_branch_analytics(timestamptz,timestamptz) to authenticated;

-- 4) Keep staff_permissions in sync going forward: whenever organizations.owner_id
--    changes (ownership transfer), re-sync staff.role for both the old and new owner.
create or replace function public.sync_staff_role_on_owner_change()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.owner_id is distinct from old.owner_id then
    if old.owner_id is not null then
      update public.staff set role='MANAGER', updated_at=now()
      where organization_id=new.id and user_id=old.owner_id and role='OWNER';
    end if;
    if new.owner_id is not null then
      if exists(select 1 from public.staff where organization_id=new.id and user_id=new.owner_id) then
        update public.staff set role='OWNER', active=true, updated_at=now()
        where organization_id=new.id and user_id=new.owner_id;
      else
        insert into public.staff(user_id, organization_id, branch_id, role, active, can_kitchen, can_waiter)
        select new.owner_id, new.id, b.id, 'OWNER', true, true, true
        from public.branches b where b.organization_id=new.id order by b.created_at limit 1
        on conflict do nothing;
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists organizations_owner_change_sync on public.organizations;
create trigger organizations_owner_change_sync
  after update of owner_id on public.organizations
  for each row execute function public.sync_staff_role_on_owner_change();

select pg_notify('pgrst','reload schema');
