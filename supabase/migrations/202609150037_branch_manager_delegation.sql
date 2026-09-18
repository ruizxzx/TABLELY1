-- Branch Manager delegation.
--
-- Concept: no new role is added. A "Branch Manager" is simply a MANAGER
-- whose owner has explicitly granted them STAFF_MANAGEMENT and/or
-- BRANCH_MANAGEMENT in the existing (until now unused) staff_permissions
-- system, via /staff/permissions. Everything a Manager already does today
-- (menu, tables, orders, kitchen, cancellations, service requests, branch
-- analytics) is unchanged -- this migration only adds two NEW, narrowly
-- scoped capabilities, both restricted to the manager's own branch_id:
--   - STAFF_MANAGEMENT: invite/enable/disable WAITER or KITCHEN staff for
--     their own branch only. They can never create another MANAGER or
--     touch staff outside their branch -- only the true owner can do that.
--   - BRANCH_MANAGEMENT: edit their own branch's name/address/phone.
--     They can never create branches, deactivate a branch, or touch any
--     other branch -- only the true owner can do that.
-- Additive/idempotent.

-- 1) Fix unsafe default permission grants.
-- ensure_default_staff_permissions previously granted ALL 13 permissions
-- (including BILLING, STAFF_MANAGEMENT, SUBSCRIPTION_MANAGEMENT) = true
-- to every new staff row regardless of role. That was harmless only
-- because nothing enforced these flags yet. Now that we're wiring
-- STAFF_MANAGEMENT/BRANCH_MANAGEMENT into real checks below, defaults
-- must be sane per role, or every existing Waiter/Kitchen would instantly
-- gain staff- and branch-management rights.
create or replace function public.ensure_default_staff_permissions()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_sensitive text[] := array['BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT','SETTINGS'];
  v_operational text[] := array['VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS','ANALYTICS','MENU_MANAGEMENT'];
begin
  if new.role = 'OWNER' then
    insert into public.staff_permissions(staff_id,permission,allowed)
    select new.id, p, true from unnest(v_sensitive || v_operational) p
    on conflict (staff_id,permission) do nothing;
  else
    -- Managers/Waiters/Kitchen get operational access by default; sensitive
    -- permissions (staff/branch/billing/subscription management) start
    -- OFF and must be explicitly granted by the owner via /staff/permissions.
    insert into public.staff_permissions(staff_id,permission,allowed)
    select new.id, p, true from unnest(v_operational) p
    on conflict (staff_id,permission) do nothing;
    insert into public.staff_permissions(staff_id,permission,allowed)
    select new.id, p, false from unnest(v_sensitive) p
    on conflict (staff_id,permission) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists staff_default_permissions on public.staff;
create trigger staff_default_permissions after insert on public.staff for each row execute function public.ensure_default_staff_permissions();

-- One-time correction: the earlier backfill set every existing non-owner
-- staff row's sensitive permissions to true. Since nothing ever enforced
-- them, no owner could have intentionally relied on that -- reset them to
-- the safe default (off) now, before enforcement goes live. Operational
-- permissions are left as-is.
update public.staff_permissions sp
set allowed = false, updated_at = now()
from public.staff s
where sp.staff_id = s.id
  and s.role <> 'OWNER'
  and sp.permission in ('BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT','SETTINGS')
  and sp.allowed = true;

-- 2) Helper: is the caller a MANAGER of target_branch with a given
-- permission granted? Used by both delegated actions below.
create or replace function public.is_branch_manager_with_permission(target_branch uuid, p_permission text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists (
    select 1
    from public.staff s
    join public.staff_permissions sp on sp.staff_id = s.id
    where s.branch_id = target_branch
      and s.user_id = auth.uid()
      and s.role = 'MANAGER'::public.staff_role
      and s.active = true
      and sp.permission = upper(trim(p_permission))
      and sp.allowed = true
  );
$$;
grant execute on function public.is_branch_manager_with_permission(uuid,text) to authenticated;

-- 3) Fix set_staff_capabilities so promoting an EXISTING staff member to
-- MANAGER actually works -- previously it inferred role purely from the
-- can_kitchen/can_waiter flags and could never produce 'MANAGER'.
drop function if exists public.set_staff_capabilities(uuid,boolean,boolean);
create or replace function public.set_staff_capabilities(p_staff_id uuid, p_role public.staff_role, p_can_kitchen boolean, p_can_waiter boolean)
returns public.staff language plpgsql security definer set search_path=public as $$
declare v_staff public.staff%rowtype; v_actor public.staff%rowtype; v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  if p_role not in ('MANAGER','WAITER','KITCHEN') then raise exception 'Invalid staff role'; end if;
  if not (p_can_kitchen or p_can_waiter) then raise exception 'At least one operational permission is required'; end if;
  select * into v_staff from public.staff where id = p_staff_id for update;
  if v_staff.id is null then raise exception 'Staff member not found'; end if;
  select * into v_actor from public.staff where user_id = v_user and organization_id = v_staff.organization_id and active = true order by created_at limit 1;
  if v_actor.id is null or v_actor.role <> 'OWNER' then raise exception 'Only the owner can change staff roles' using errcode='42501'; end if;
  if v_staff.role = 'OWNER' then raise exception 'Owner permissions cannot be changed'; end if;
  update public.staff set role = p_role, can_kitchen = p_can_kitchen, can_waiter = p_can_waiter, updated_at = now() where id = p_staff_id returning * into v_staff;
  return v_staff;
end;
$$;
grant execute on function public.set_staff_capabilities(uuid,public.staff_role,boolean,boolean) to authenticated;

-- 4) Delegated staff invitations: true owner unchanged (org-wide, any
-- role). A Branch Manager with STAFF_MANAGEMENT can now also invite, but
-- only for their OWN branch and only WAITER/KITCHEN (never MANAGER or
-- OWNER) -- so a Branch Manager can staff their branch but can never
-- create a peer or escalate anyone.
create or replace function public.create_staff_invitation(
  p_branch_id uuid,
  p_email text,
  p_role public.staff_role,
  p_can_kitchen boolean default null,
  p_can_waiter boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  v_actor public.staff%rowtype;
  v_branch public.branches%rowtype;
  v_token text;
  v_row public.staff_invitations%rowtype;
  v_email text := lower(trim(coalesce(p_email,'')));
  v_kitchen boolean := coalesce(p_can_kitchen, p_role in ('OWNER','MANAGER','KITCHEN'));
  v_waiter boolean := coalesce(p_can_waiter, p_role in ('OWNER','MANAGER','WAITER'));
  v_is_delegate boolean := false;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='42501'; end if;

  select b.* into v_branch from public.branches b where b.id = p_branch_id;
  if v_branch.id is null then raise exception 'Invalid branch' using errcode='42501'; end if;

  select s.* into v_actor from public.staff s where s.user_id = auth.uid() and s.active = true and s.role = 'OWNER' and s.organization_id = v_branch.organization_id order by s.created_at limit 1;

  if v_actor.id is null then
    -- Not the org owner -- check for branch-manager delegation instead.
    if not public.is_branch_manager_with_permission(p_branch_id, 'STAFF_MANAGEMENT') then
      raise exception 'Only the owner or a branch manager with staff-management access can invite staff' using errcode='42501';
    end if;
    if p_role not in ('WAITER','KITCHEN') then
      raise exception 'Branch managers can only invite Waiter or Kitchen staff' using errcode='42501';
    end if;
    v_is_delegate := true;
    select s.* into v_actor from public.staff s where s.user_id = auth.uid() and s.branch_id = p_branch_id and s.active = true limit 1;
  end if;

  if p_role not in ('MANAGER','WAITER','KITCHEN') then raise exception 'Invalid staff role'; end if;
  if not (v_kitchen or v_waiter) then raise exception 'At least one operational permission is required'; end if;
  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Invalid email address'; end if;

  if exists(select 1 from public.staff es join auth.users au on au.id = es.user_id where es.organization_id = v_branch.organization_id and es.active = true and lower(coalesce(au.email,'')) = v_email) then
    raise exception 'A staff member with this email is already active';
  end if;

  update public.staff_invitations set role = p_role, can_kitchen = v_kitchen, can_waiter = v_waiter, expires_at = greatest(expires_at, now() + interval '7 days')
    where branch_id = v_branch.id and lower(email) = v_email and accepted_at is null and expires_at > now();
  select * into v_row from public.staff_invitations si where si.branch_id = v_branch.id and lower(si.email) = v_email and si.accepted_at is null and si.expires_at > now() order by si.created_at desc limit 1;
  v_token := encode(extensions.gen_random_bytes(24),'hex');
  if v_row.id is not null then
    update public.staff_invitations set token_hash = encode(extensions.digest(v_token,'sha256'),'hex'), role = p_role, can_kitchen = v_kitchen, can_waiter = v_waiter returning * into v_row;
  else
    insert into public.staff_invitations(organization_id,branch_id,email,role,can_kitchen,can_waiter,token_hash,created_by)
    values(v_branch.organization_id, v_branch.id, v_email, p_role, v_kitchen, v_waiter, encode(extensions.digest(v_token,'sha256'),'hex'), auth.uid())
    returning * into v_row;
  end if;
  return jsonb_build_object('id',v_row.id,'email',v_row.email,'role',v_row.role,'can_kitchen',v_row.can_kitchen,'can_waiter',v_row.can_waiter,'expires_at',v_row.expires_at,'token',v_token);
end;
$$;
grant execute on function public.create_staff_invitation(uuid,text,public.staff_role,boolean,boolean) to authenticated;

-- 5) Delegated branch settings edits: true owner unchanged (any field, any
-- branch). A Branch Manager with BRANCH_MANAGEMENT can edit name/address/
-- phone for their OWN branch only -- is_active is silently pinned to the
-- branch's current value for a delegate, so they can never deactivate/
-- reactivate a branch. Only the true owner can do that.
create or replace function public.update_branch_settings(p_branch_id uuid, p_name text, p_address text, p_phone text, p_is_active boolean default true)
returns public.branches language plpgsql security definer set search_path=public as $$
declare v_row public.branches; v_org uuid; v_is_owner boolean; v_effective_active boolean;
begin
  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then raise exception 'Branch not found' using errcode='42501'; end if;
  v_is_owner := public.is_org_owner(v_org);

  if not v_is_owner then
    if not public.is_branch_manager_with_permission(p_branch_id, 'BRANCH_MANAGEMENT') then
      raise exception 'Only the owner or a branch manager with branch-management access can edit this branch' using errcode='42501';
    end if;
  end if;
  if not public.organization_has_feature(v_org,'MULTI_BRANCH') then raise exception 'Multi-branch management is not available on the current Tablely plan' using errcode='42501'; end if;

  if v_is_owner then
    v_effective_active := p_is_active;
    if p_is_active = false and (select count(*) from public.branches where organization_id = v_org and is_active) > 1 and (select is_active from public.branches where id = p_branch_id) then
      null;
    elsif p_is_active = false then
      raise exception 'At least one active branch is required';
    end if;
  else
    -- Delegated branch managers can never change activation state.
    select is_active into v_effective_active from public.branches where id = p_branch_id;
  end if;

  update public.branches set name = left(trim(p_name),100), address = nullif(left(trim(coalesce(p_address,'')),300),''), phone = nullif(left(trim(coalesce(p_phone,'')),30),''), is_active = v_effective_active
  where id = p_branch_id returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.update_branch_settings(uuid,text,text,text,boolean) to authenticated;

select pg_notify('pgrst','reload schema');
