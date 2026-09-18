-- TABLELY BUILD 18 FIX — Manager branch-scoped coupon access + robust
-- branch-context resolution for /settings/coupons.
--
-- Root causes addressed:
--
-- 1) Every Build 18 owner-facing coupon RPC (list_coupons_v18,
--    upsert_coupon_v18, get_coupon_config_v18, list_coupon_usage_v18)
--    hardcoded `s.role = 'OWNER'` as the only path to organization_id.
--    A Manager granted the "Discounts / Coupons" permission via the
--    existing Advanced Permissions system had no way to ever pass this
--    check -- the feature described in the spec did not exist yet. This
--    migration adds a DISCOUNTS_COUPONS permission (reusing the existing
--    staff_permissions / is_branch_manager_with_permission architecture
--    from 202609150037_branch_manager_delegation.sql, not a new system)
--    and rewrites all four RPCs to resolve, server-side:
--      - OWNER -> full organization access, explicit branch or all-branch
--      - MANAGER with DISCOUNTS_COUPONS -> their own assigned branch_id
--        only, silently ignoring/overriding any other branch_id a
--        manipulated client request might try to submit
--      - anyone else -> denied (42501), as before
--
-- 2) list_coupons_v18(p_branch_id) previously raised when a non-owner,
--    non-authorized caller reached it with organization_id unresolved.
--    The rewritten version resolves the caller's effective org/branch
--    once, up front, and only ever queries with a real validated UUID --
--    never a client-supplied, unvalidated branch id for a Manager.
--
-- Additive/idempotent. Build 1-18 tables, RLS, checkout pipeline, and
-- payment-first flow are untouched.
begin;

-- ---------------------------------------------------------------------------
-- 1) Register the new permission with the existing Advanced Permissions
--    system. Owners get it by default (mirrors ensure_default_staff_permissions'
--    existing v_sensitive/v_operational split); non-owners start OFF and the
--    owner must explicitly grant it, exactly like STAFF_MANAGEMENT/BRANCH_MANAGEMENT.
-- ---------------------------------------------------------------------------
insert into public.staff_permissions(staff_id,permission,allowed)
select s.id,'DISCOUNTS_COUPONS', (s.role = 'OWNER')
from public.staff s
where not exists(select 1 from public.staff_permissions sp where sp.staff_id=s.id and sp.permission='DISCOUNTS_COUPONS');

create or replace function public.ensure_default_staff_permissions()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_sensitive text[] := array['BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT','SETTINGS','DISCOUNTS_COUPONS'];
  v_operational text[] := array['VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS','ANALYTICS','MENU_MANAGEMENT'];
begin
  if new.role = 'OWNER' then
    insert into public.staff_permissions(staff_id,permission,allowed)
    select new.id, p, true from unnest(v_sensitive || v_operational) p
    on conflict (staff_id,permission) do nothing;
  else
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

-- ---------------------------------------------------------------------------
-- 2) Shared resolver: given the authenticated caller, return their
--    organization_id and, when they are a branch-scoped delegate (not the
--    owner), their locked branch_id. Server is the sole authority here --
--    the client never supplies or overrides this. Raises 42501 for anyone
--    without owner access or a granted DISCOUNTS_COUPONS delegation.
-- ---------------------------------------------------------------------------
drop function if exists public.resolve_coupon_actor_v18();
create function public.resolve_coupon_actor_v18()
returns table(organization_id uuid, is_owner boolean, locked_branch_id uuid)
language plpgsql security definer stable set search_path=public as $$
declare
  v_owner public.staff%rowtype;
  v_delegate public.staff%rowtype;
begin
  select s.* into v_owner from public.staff s
  where s.user_id=auth.uid() and s.active=true and s.role='OWNER'
  order by s.created_at limit 1;
  if v_owner.id is not null then
    return query select v_owner.organization_id, true, null::uuid;
    return;
  end if;

  select s.* into v_delegate from public.staff s
  join public.staff_permissions sp on sp.staff_id=s.id
  where s.user_id=auth.uid() and s.active=true and s.role='MANAGER'::public.staff_role
    and sp.permission='DISCOUNTS_COUPONS' and sp.allowed=true
  order by s.created_at limit 1;
  if v_delegate.id is not null and v_delegate.branch_id is not null then
    return query select v_delegate.organization_id, false, v_delegate.branch_id;
    return;
  end if;

  raise exception 'Discounts/coupons access is required' using errcode='42501';
end;
$$;
grant execute on function public.resolve_coupon_actor_v18() to authenticated;
revoke execute on function public.resolve_coupon_actor_v18() from public;

-- ---------------------------------------------------------------------------
-- 3) list_coupons_v18 -- owner: optional branch filter (or all-branch view).
--    Branch-manager delegate: always their own branch, p_branch_id from the
--    client is ignored/overridden, never trusted.
-- ---------------------------------------------------------------------------
drop function if exists public.list_coupons_v18(uuid);
create function public.list_coupons_v18(p_branch_id uuid default null)
returns table(id uuid,branch_id uuid,code text,title text,description text,offer_type text,discount_type text,discount_value numeric,minimum_order_amount numeric,starts_at timestamptz,ends_at timestamptz,usage_limit_total integer,usage_limit_per_customer integer,is_active boolean,promote boolean,usage_count bigint,updated_at timestamptz)
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org uuid; v_is_owner boolean; v_locked_branch uuid; v_effective_branch uuid;
begin
  select organization_id,is_owner,locked_branch_id into v_org,v_is_owner,v_locked_branch from public.resolve_coupon_actor_v18();

  if v_is_owner then
    if p_branch_id is not null and not exists(select 1 from public.branches b where b.id=p_branch_id and b.organization_id=v_org) then
      raise exception 'Branch not found';
    end if;
    v_effective_branch := p_branch_id;
  else
    -- Delegate: server-resolved branch always wins, regardless of what the
    -- client sent.
    v_effective_branch := v_locked_branch;
  end if;

  return query
  select c.id,c.branch_id,c.code,c.title,c.description,c.offer_type,c.discount_type,c.discount_value,c.minimum_order_amount,c.starts_at,c.ends_at,c.usage_limit_total,c.usage_limit_per_customer,c.is_active,c.promote,
         (select count(*) from public.coupon_usages u where u.coupon_id=c.id),c.updated_at
  from public.coupons c
  where c.organization_id=v_org
    and (
      (v_is_owner and (v_effective_branch is null or c.branch_id is null or c.branch_id=v_effective_branch))
      or
      (not v_is_owner and c.branch_id=v_effective_branch)
    )
  order by c.created_at desc;
end;
$$;
grant execute on function public.list_coupons_v18(uuid) to authenticated;
revoke execute on function public.list_coupons_v18(uuid) from public;

-- ---------------------------------------------------------------------------
-- 4) upsert_coupon_v18 -- owner: any branch in their org, or NULL for
--    all-branch. Delegate: branch is always forced to their own branch_id;
--    they can never create/move a coupon to another branch or to
--    all-branch scope, however the request is shaped.
-- ---------------------------------------------------------------------------
drop function if exists public.upsert_coupon_v18(uuid,uuid,text,text,text,text,text,numeric,numeric,timestamptz,timestamptz,integer,integer,boolean,boolean,uuid[],uuid[]);
create function public.upsert_coupon_v18(
  p_id uuid default null,
  p_branch_id uuid default null,
  p_code text default null,
  p_title text default null,
  p_description text default null,
  p_offer_type text default 'STANDARD',
  p_discount_type text default 'PERCENTAGE',
  p_discount_value numeric default 0,
  p_minimum_order_amount numeric default 0,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_usage_limit_total integer default null,
  p_usage_limit_per_customer integer default null,
  p_is_active boolean default true,
  p_promote boolean default false,
  p_category_ids uuid[] default '{}',
  p_menu_item_ids uuid[] default '{}'
)
returns public.coupons
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org uuid; v_is_owner boolean; v_locked_branch uuid;
  v_effective_branch uuid;
  v_coupon public.coupons%rowtype;
  v_before public.coupons%rowtype;
  v_code text:=upper(trim(coalesce(p_code,'')));
  v_branch_org uuid;
begin
  select organization_id,is_owner,locked_branch_id into v_org,v_is_owner,v_locked_branch from public.resolve_coupon_actor_v18();

  if v_is_owner then
    v_effective_branch := p_branch_id;
  else
    -- A delegate can never write for another branch or all-branch, no
    -- matter what p_branch_id the client sends.
    v_effective_branch := v_locked_branch;
  end if;

  if v_code is null or v_code='' or length(v_code)>64 or v_code !~ '^[A-Z0-9][A-Z0-9_-]*$' then raise exception 'Coupon code must use letters, numbers, hyphen or underscore'; end if;
  if p_discount_type not in ('PERCENTAGE','FIXED') then raise exception 'Invalid discount type'; end if;
  if p_offer_type not in ('STANDARD','TIME_BASED','RUSH_HOUR','SPECIAL_OFFER') then raise exception 'Invalid offer type'; end if;
  if p_discount_value is null or p_discount_value<0 or (p_discount_type='PERCENTAGE' and p_discount_value>100) then raise exception 'Invalid discount value'; end if;
  if p_minimum_order_amount is null or p_minimum_order_amount<0 then raise exception 'Invalid minimum order amount'; end if;
  if p_ends_at is not null and p_starts_at is not null and p_ends_at<=p_starts_at then raise exception 'End time must be after start time'; end if;
  if p_usage_limit_total is not null and p_usage_limit_total<1 then raise exception 'Invalid total usage limit'; end if;
  if p_usage_limit_per_customer is not null and p_usage_limit_per_customer<1 then raise exception 'Invalid customer usage limit'; end if;
  if v_effective_branch is not null then
    select b.organization_id into v_branch_org from public.branches b where b.id=v_effective_branch and b.is_active=true;
    if v_branch_org is null or v_branch_org<>v_org then raise exception 'Branch not found'; end if;
  end if;

  if exists(select 1 from unnest(coalesce(p_menu_item_ids,'{}'::uuid[])) x where not exists(select 1 from public.menu_items mi join public.branches b on b.id=mi.branch_id where mi.id=x and b.organization_id=v_org and (v_effective_branch is null or mi.branch_id=v_effective_branch))) then raise exception 'One or more menu items are outside this restaurant or branch'; end if;
  if exists(select 1 from unnest(coalesce(p_category_ids,'{}'::uuid[])) x where not exists(select 1 from public.menu_categories mc join public.branches b on b.id=mc.branch_id where mc.id=x and b.organization_id=v_org and (v_effective_branch is null or mc.branch_id=v_effective_branch))) then raise exception 'One or more categories are outside this restaurant or branch'; end if;

  if p_id is null then
    insert into public.coupons(organization_id,branch_id,code,title,description,offer_type,discount_type,discount_value,minimum_order_amount,starts_at,ends_at,usage_limit_total,usage_limit_per_customer,is_active,promote)
    values(v_org,v_effective_branch,v_code,nullif(left(trim(coalesce(p_title,'')),120),''),nullif(left(trim(coalesce(p_description,'')),500),''),p_offer_type,p_discount_type,round(p_discount_value,2),round(p_minimum_order_amount,2),p_starts_at,p_ends_at,p_usage_limit_total,p_usage_limit_per_customer,coalesce(p_is_active,true),coalesce(p_promote,false))
    returning * into v_coupon;
  else
    select c.* into v_before from public.coupons c where c.id=p_id and c.organization_id=v_org for update;
    if v_before.id is null then raise exception 'Coupon not found'; end if;
    -- A delegate may only ever edit a coupon that already belongs to their
    -- own branch -- never another branch's coupon, never an all-branch one.
    if not v_is_owner and v_before.branch_id is distinct from v_locked_branch then
      raise exception 'You can only manage coupons for your assigned branch' using errcode='42501';
    end if;
    update public.coupons c set branch_id=v_effective_branch,code=v_code,title=nullif(left(trim(coalesce(p_title,'')),120),''),description=nullif(left(trim(coalesce(p_description,'')),500),''),offer_type=p_offer_type,discount_type=p_discount_type,discount_value=round(p_discount_value,2),minimum_order_amount=round(p_minimum_order_amount,2),starts_at=p_starts_at,ends_at=p_ends_at,usage_limit_total=p_usage_limit_total,usage_limit_per_customer=p_usage_limit_per_customer,is_active=coalesce(p_is_active,true),promote=coalesce(p_promote,false),updated_at=now()
    where c.id=p_id and c.organization_id=v_org
    returning * into v_coupon;
    if v_coupon.id is null then raise exception 'Coupon not found'; end if;
  end if;

  delete from public.coupon_menu_items where coupon_id=v_coupon.id;
  delete from public.coupon_categories where coupon_id=v_coupon.id;
  insert into public.coupon_menu_items(coupon_id,menu_item_id) select v_coupon.id,x from unnest(coalesce(p_menu_item_ids,'{}'::uuid[])) x;
  insert into public.coupon_categories(coupon_id,category_id) select v_coupon.id,x from unnest(coalesce(p_category_ids,'{}'::uuid[])) x;

  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(
    auth.uid(),
    case
      when v_before.id is null then 'COUPON_CREATED'
      when v_before.is_active and not v_coupon.is_active then 'COUPON_DISABLED'
      when not v_before.is_active and v_coupon.is_active then 'COUPON_ENABLED'
      else 'COUPON_UPDATED'
    end,
    'COUPON',
    v_coupon.id,
    jsonb_build_object(
      'organization_id',v_coupon.organization_id,
      'branch_id',v_coupon.branch_id,
      'code',v_coupon.code,
      'discount_type',v_coupon.discount_type,
      'discount_value',v_coupon.discount_value,
      'minimum_order_amount',v_coupon.minimum_order_amount,
      'is_active',v_coupon.is_active,
      'promote',v_coupon.promote,
      'previous_active',case when v_before.id is null then null else v_before.is_active end,
      'actor_role',case when v_is_owner then 'OWNER' else 'MANAGER' end
    )
  );

  return v_coupon;
exception when unique_violation then
  raise exception 'A coupon with this code already exists';
end;
$$;
grant execute on function public.upsert_coupon_v18(uuid,uuid,text,text,text,text,text,numeric,numeric,timestamptz,timestamptz,integer,integer,boolean,boolean,uuid[],uuid[]) to authenticated;
revoke execute on function public.upsert_coupon_v18(uuid,uuid,text,text,text,text,text,numeric,numeric,timestamptz,timestamptz,integer,integer,boolean,boolean,uuid[],uuid[]) from public;

-- ---------------------------------------------------------------------------
-- 5) get_coupon_config_v18 -- delegate can only read config for a coupon
--    that belongs to their own branch.
-- ---------------------------------------------------------------------------
drop function if exists public.get_coupon_config_v18(uuid);
create function public.get_coupon_config_v18(p_id uuid)
returns table(category_ids uuid[],menu_item_ids uuid[])
language plpgsql security definer
set search_path=public
as $$
declare v_org uuid; v_is_owner boolean; v_locked_branch uuid; v_coupon_branch uuid;
begin
  select organization_id,is_owner,locked_branch_id into v_org,v_is_owner,v_locked_branch from public.resolve_coupon_actor_v18();
  select c.branch_id into v_coupon_branch from public.coupons c where c.id=p_id and c.organization_id=v_org;
  if v_coupon_branch is null and not exists(select 1 from public.coupons c where c.id=p_id and c.organization_id=v_org) then
    return;
  end if;
  if not v_is_owner and v_coupon_branch is distinct from v_locked_branch then
    raise exception 'You can only manage coupons for your assigned branch' using errcode='42501';
  end if;
  return query select
    coalesce((select array_agg(category_id order by category_id) from public.coupon_categories where coupon_id=p_id),'{}'::uuid[]),
    coalesce((select array_agg(menu_item_id order by menu_item_id) from public.coupon_menu_items where coupon_id=p_id),'{}'::uuid[])
  where exists(select 1 from public.coupons c where c.id=p_id and c.organization_id=v_org);
end;
$$;
grant execute on function public.get_coupon_config_v18(uuid) to authenticated;
revoke execute on function public.get_coupon_config_v18(uuid) from public;

-- ---------------------------------------------------------------------------
-- 6) list_coupon_usage_v18 -- delegate sees usage only for their own
--    branch's coupons (and, per branch_id, only usage rows recorded for
--    their branch -- an all-branch coupon's usage from another branch stays
--    hidden from a branch-scoped delegate).
-- ---------------------------------------------------------------------------
drop function if exists public.list_coupon_usage_v18(uuid);
create function public.list_coupon_usage_v18(p_coupon_id uuid)
returns table(order_id uuid,order_number bigint,branch_id uuid,table_id uuid,customer_phone text,discount_amount numeric,applied_at timestamptz)
language plpgsql
security definer
set search_path=public
as $$
declare v_org uuid; v_is_owner boolean; v_locked_branch uuid; v_coupon_branch uuid;
begin
  select organization_id,is_owner,locked_branch_id into v_org,v_is_owner,v_locked_branch from public.resolve_coupon_actor_v18();
  select c.branch_id into v_coupon_branch from public.coupons c where c.id=p_coupon_id and c.organization_id=v_org;
  if not v_is_owner and v_coupon_branch is distinct from v_locked_branch then
    raise exception 'You can only view usage for your assigned branch' using errcode='42501';
  end if;
  return query select u.order_id,o.order_number,u.branch_id,u.table_id,u.customer_phone,u.discount_amount,u.applied_at
  from public.coupon_usages u join public.orders o on o.id=u.order_id
  where u.coupon_id=p_coupon_id and u.organization_id=v_org
    and (v_is_owner or u.branch_id=v_locked_branch)
  order by u.applied_at desc;
end;
$$;
grant execute on function public.list_coupon_usage_v18(uuid) to authenticated;
revoke execute on function public.list_coupon_usage_v18(uuid) from public;

commit;
notify pgrst, 'reload schema';
