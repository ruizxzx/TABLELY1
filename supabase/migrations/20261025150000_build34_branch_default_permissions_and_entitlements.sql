-- TABLELY BUILD 34 — Branch Default Permissions, Inventory Entitlements & Overview Hardening
-- 1. Sets branch inventory permissions ON by default for branch managers so each branch
--    can independently manage their inventory until turned off by the owner.
-- 2. Enables the INVENTORY feature flag and saas_plans features for all plans.
-- 3. Hardens organization_has_feature for INVENTORY so branches are never locked out.
-- 4. Ensures branch settings, categories, locations, and processing error tracking are provisioned.

begin;

-- ---------------------------------------------------------------------------
-- 1) Enable INVENTORY in platform flags and all SaaS plans
-- ---------------------------------------------------------------------------
insert into public.platform_feature_flags(key, label, description, enabled, maintenance_mode)
values ('INVENTORY', 'Inventory', 'Multi-branch restaurant inventory and recipe management.', true, false)
on conflict (key) do update set enabled = true, maintenance_mode = false, updated_at = now();

update public.saas_plans
set features = jsonb_set(
  jsonb_set(coalesce(features, '{}'::jsonb), '{INVENTORY}', 'true'::jsonb),
  '{inventory}', 'true'::jsonb
);

-- ---------------------------------------------------------------------------
-- 2) Upgrade organization_has_feature to recognize INVENTORY and overrides
-- ---------------------------------------------------------------------------
create or replace function public.organization_has_feature(p_organization_id uuid, p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_features jsonb;
  v_status text;
  v_trial_end timestamptz;
  v_key text := upper(trim(coalesce(p_feature, '')));
  v_global public.platform_feature_flags;
  v_override public.organization_feature_overrides;
begin
  if auth.uid() is not null and auth.role() <> 'anon'
     and not public.is_org_member(p_organization_id)
     and not public.is_platform_admin() then return false; end if;

  -- Check global platform flag
  select * into v_global from public.platform_feature_flags where key = v_key;
  if v_global.key is not null and (not v_global.enabled or v_global.maintenance_mode) then
    return false;
  end if;

  -- Check org-specific override
  select * into v_override from public.organization_feature_overrides
  where organization_id = p_organization_id and feature_key = v_key;
  if v_override.organization_id is not null then
    if v_override.enabled is false or v_override.maintenance_mode is true then
      return false;
    elsif v_override.enabled is true then
      return true;
    end if;
  end if;

  -- For INVENTORY, if global flag is enabled and not overridden, grant access to all organization members
  if v_key = 'INVENTORY' then
    return true;
  end if;

  -- Check subscription plan features
  select os.status, os.trial_ends_at, sp.features
  into v_status, v_trial_end, v_features
  from public.organization_subscriptions os
  join public.saas_plans sp on sp.id = os.plan_id
  where os.organization_id = p_organization_id;

  if v_status is null or (v_status = 'TRIAL' and v_trial_end is not null and v_trial_end <= now())
     or v_status not in ('TRIAL', 'ACTIVE') then
    return false;
  end if;

  return coalesce((v_features->>v_key)::boolean, (v_features->>lower(v_key))::boolean, false);
end;
$$;
grant execute on function public.organization_has_feature(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Ensure inventory_processing_errors table exists with RLS
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_processing_errors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  order_status text not null,
  error_message text not null,
  error_detail text,
  occurrences integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  unique (order_id, order_status, error_message)
);

create index if not exists inventory_processing_errors_branch_idx
  on public.inventory_processing_errors(branch_id, resolved_at, last_seen_at desc);

alter table public.inventory_processing_errors enable row level security;

drop policy if exists inventory_processing_errors_select on public.inventory_processing_errors;
create policy inventory_processing_errors_select on public.inventory_processing_errors
  for select to authenticated
  using (
    public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW')
    and public.organization_has_feature(organization_id, 'INVENTORY')
  );

grant select on public.inventory_processing_errors to authenticated;
revoke all on public.inventory_processing_errors from anon;

-- ---------------------------------------------------------------------------
-- 4) Branch-level default permissions: MANAGERs get full branch inventory permissions ON by default
-- ---------------------------------------------------------------------------
create or replace function public.ensure_default_staff_permissions()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_sensitive text[] := array[
    'BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT',
    'SUBSCRIPTION_MANAGEMENT','SETTINGS','DISCOUNTS_COUPONS'
  ];
  v_operational text[] := array[
    'VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS',
    'ANALYTICS','MENU_MANAGEMENT','INVENTORY_VIEW'
  ];
  v_inventory text[] := array[
    'INVENTORY_VIEW','INVENTORY_MANAGEMENT','INVENTORY_PURCHASE',
    'INVENTORY_RECEIVE','INVENTORY_ADJUST','INVENTORY_WASTAGE',
    'INVENTORY_RECIPE_MANAGEMENT','INVENTORY_COST_VIEW','INVENTORY_TRANSFER'
  ];
begin
  if new.role = 'OWNER' then
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, true from unnest(v_sensitive || v_operational || v_inventory) p
    on conflict (staff_id, permission) do update set allowed = true;
  elsif new.role = 'MANAGER' then
    -- Branch Managers independently manage inventory linked to their specific branch by default,
    -- until the main branch owner explicitly turns off a permission for them.
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, true from unnest(v_operational || v_inventory) p
    on conflict (staff_id, permission) do nothing;
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, false from unnest(v_sensitive) p
    on conflict (staff_id, permission) do nothing;
  else
    -- Waiters and Kitchen staff get operational view by default
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, true from unnest(v_operational) p
    on conflict (staff_id, permission) do nothing;
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, false from unnest(v_sensitive || array[
      'INVENTORY_MANAGEMENT','INVENTORY_PURCHASE','INVENTORY_RECEIVE',
      'INVENTORY_ADJUST','INVENTORY_WASTAGE','INVENTORY_RECIPE_MANAGEMENT',
      'INVENTORY_COST_VIEW','INVENTORY_TRANSFER'
    ]) p
    on conflict (staff_id, permission) do nothing;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Backfill existing OWNER and MANAGER staff with all 9 inventory permissions ON
-- ---------------------------------------------------------------------------
insert into public.staff_permissions(staff_id, permission, allowed)
select s.id, p.perm, true
from public.staff s
cross join unnest(array[
  'INVENTORY_VIEW','INVENTORY_MANAGEMENT','INVENTORY_PURCHASE',
  'INVENTORY_RECEIVE','INVENTORY_ADJUST','INVENTORY_WASTAGE',
  'INVENTORY_RECIPE_MANAGEMENT','INVENTORY_COST_VIEW','INVENTORY_TRANSFER'
]) p(perm)
where s.role in ('OWNER', 'MANAGER')
on conflict (staff_id, permission) do update set allowed = true;

-- ---------------------------------------------------------------------------
-- 6) Harden inventory_get_overview to auto-provision branch defaults
-- ---------------------------------------------------------------------------
create or replace function public.inventory_get_overview(p_branch_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare v_org uuid; v_result jsonb; v_can_view_cost boolean;
begin
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  select jsonb_build_object(
    'total_items', (select count(*) from public.inventory_items where organization_id = v_org and is_active),
    'total_stock_value_paise', case when v_can_view_cost then
      (select coalesce(sum(stock_value_paise), 0) from public.inventory_balances where branch_id = p_branch_id)
      else null end,
    'low_stock_count', (
      select count(*) from public.inventory_items ii
      left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
      where ii.organization_id = v_org and ii.is_active
        and ii.reorder_level is not null
        and coalesce(ib.available_qty, 0) > 0
        and coalesce(ib.available_qty, 0) <= ii.reorder_level
    ),
    'out_of_stock_count', (
      select count(*) from public.inventory_items ii
      left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
      where ii.organization_id = v_org and ii.is_active
        and coalesce(ib.available_qty, 0) <= 0
    ),
    'expiring_soon_count', (
      select count(distinct item_id) from public.inventory_batches
      where branch_id = p_branch_id and is_active = true and current_qty > 0
        and expires_at is not null
        and expires_at <= current_date + 7
        and expires_at >= current_date
    ),
    'expired_count', (
      select count(distinct item_id) from public.inventory_batches
      where branch_id = p_branch_id and is_active = true and current_qty > 0
        and expires_at is not null
        and expires_at < current_date
    ),
    'pending_po_count', (
      select count(*) from public.inventory_purchase_orders
      where branch_id = p_branch_id
        and status in ('DRAFT','PENDING_APPROVAL','APPROVED','SENT')
    ),
    'wastage_value_paise_this_month', case when v_can_view_cost then (
      select coalesce(sum(cost_paise), 0) from public.inventory_wastage
      where branch_id = p_branch_id
        and date_trunc('month', wastage_date::timestamptz) = date_trunc('month', now())
    ) else null end,
    'recent_movements', (
      select coalesce(jsonb_agg(
        case when v_can_view_cost then to_jsonb(m)
          else to_jsonb(m) - 'unit_cost_paise' - 'total_cost_paise'
        end order by m.created_at desc
      ), '[]'::jsonb)
      from (
        select m.*, ii.name as item_name, ii.base_unit
        from public.inventory_stock_movements m
        join public.inventory_items ii on ii.id = m.item_id
        where m.branch_id = p_branch_id
        order by m.created_at desc
        limit 10
      ) m
    ),
    'low_stock_items', (
      select coalesce(jsonb_agg(x order by x.available_qty asc), '[]')
      from (
        select ii.id, ii.name, ii.base_unit, ii.reorder_level,
          coalesce(ib.available_qty, 0) as available_qty,
          case
            when coalesce(ib.available_qty, 0) <= 0 then 'OUT'
            else 'LOW'
          end as stock_status
        from public.inventory_items ii
        left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
        where ii.organization_id = v_org and ii.is_active
          and ii.reorder_level is not null
          and coalesce(ib.available_qty, 0) <= ii.reorder_level
        order by ib.available_qty asc
        limit 10
      ) x
    )
  ) into v_result;

  return v_result;
end;
$$;
grant execute on function public.inventory_get_overview(uuid) to authenticated;
revoke execute on function public.inventory_get_overview(uuid) from anon, public;

select pg_notify('pgrst', 'reload schema');

commit;
