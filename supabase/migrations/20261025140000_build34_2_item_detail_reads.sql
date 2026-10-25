begin;

create or replace function public.inventory_get_item_detail(p_item_id uuid, p_branch_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_item public.inventory_items;
  v_balance public.inventory_balances;
  v_org uuid;
  v_can_view_cost boolean;
begin
  select b.organization_id into v_org
  from public.branches b
  where b.id = p_branch_id
    and b.is_active
    and public.organization_has_feature(b.organization_id, 'INVENTORY');
  if v_org is null or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;
  select * into v_item
  from public.inventory_items ii
  where ii.id = p_item_id and ii.organization_id = v_org;
  if v_item.id is null then raise exception 'Inventory item not found in this organization' using errcode = 'P0002'; end if;
  select * into v_balance
  from public.inventory_balances ib
  where ib.item_id = p_item_id and ib.branch_id = p_branch_id;
  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return jsonb_build_object(
    'item', to_jsonb(v_item),
    'category_name', (select c.name from public.inventory_categories c where c.id = v_item.category_id),
    'balance', case when v_balance.id is null then null
      when v_can_view_cost then to_jsonb(v_balance)
      else to_jsonb(v_balance) - 'avg_unit_cost_paise' - 'stock_value_paise'
    end
  );
end;
$$;
grant execute on function public.inventory_get_item_detail(uuid, uuid) to authenticated;
revoke execute on function public.inventory_get_item_detail(uuid, uuid) from anon, public;

create or replace function public.inventory_list_item_batches(
  p_item_id uuid,
  p_branch_id uuid,
  p_limit integer default 100
)
returns table(
  id uuid,
  batch_number text,
  manufactured_at date,
  expires_at date,
  received_qty numeric,
  current_qty numeric,
  unit_cost_paise bigint,
  location_name text,
  received_at timestamptz,
  is_active boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare v_can_view_cost boolean;
begin
  if p_limit < 1 or p_limit > 200 then raise exception 'Invalid limit' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.branches b
    join public.inventory_items ii on ii.organization_id = b.organization_id and ii.id = p_item_id
    where b.id = p_branch_id and b.is_active
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
      and public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW')
  ) then raise exception 'Inventory item not found or access denied' using errcode = '42501'; end if;
  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return query
  select b.id, b.batch_number, b.manufactured_at, b.expires_at, b.received_qty, b.current_qty,
    case when v_can_view_cost then b.unit_cost_paise else null end,
    l.name, b.received_at, b.is_active
  from public.inventory_batches b
  left join public.inventory_locations l on l.id = b.location_id
  where b.item_id = p_item_id and b.branch_id = p_branch_id
  order by b.received_at desc
  limit p_limit;
end;
$$;
grant execute on function public.inventory_list_item_batches(uuid, uuid, integer) to authenticated;
revoke execute on function public.inventory_list_item_batches(uuid, uuid, integer) from anon, public;

create or replace function public.inventory_list_item_suppliers(p_item_id uuid, p_branch_id uuid)
returns table(
  supplier_id uuid,
  company_name text,
  supplier_item_code text,
  price_unit text,
  unit_price_paise bigint,
  is_preferred boolean,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_org uuid;
  v_can_view_cost boolean;
begin
  select b.organization_id into v_org
  from public.branches b
  join public.inventory_items ii on ii.organization_id = b.organization_id and ii.id = p_item_id
  where b.id = p_branch_id and b.is_active
    and public.organization_has_feature(b.organization_id, 'INVENTORY');
  if v_org is null or not (
    public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_PURCHASE')
    or public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW')
  ) then
    raise exception 'Purchase or cost-view permission required' using errcode = '42501';
  end if;
  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return query
  select iis.supplier_id, s.company_name, iis.supplier_item_code, iis.price_unit,
    case when v_can_view_cost then iis.unit_price_paise else null end,
    iis.is_preferred, iis.updated_at
  from public.inventory_item_suppliers iis
  join public.inventory_suppliers s on s.id = iis.supplier_id
  where iis.item_id = p_item_id and iis.organization_id = v_org
    and s.organization_id = v_org and s.is_active
  order by iis.is_preferred desc, s.company_name;
end;
$$;
grant execute on function public.inventory_list_item_suppliers(uuid, uuid) to authenticated;
revoke execute on function public.inventory_list_item_suppliers(uuid, uuid) from anon, public;

create or replace function public.inventory_list_item_recipe_usage(p_item_id uuid, p_branch_id uuid)
returns table(
  recipe_id uuid,
  recipe_name text,
  menu_item_name text,
  version_number integer,
  qty_per_serving numeric,
  unit text,
  yield_pct numeric
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare v_org uuid;
begin
  select b.organization_id into v_org
  from public.branches b
  join public.inventory_items ii on ii.organization_id = b.organization_id and ii.id = p_item_id
  where b.id = p_branch_id and b.is_active
    and public.organization_has_feature(b.organization_id, 'INVENTORY');
  if v_org is null or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;

  return query
  select r.id, r.name, mi.name, rv.version_number, rl.qty_per_serving, rl.unit, rl.yield_pct
  from public.inventory_recipes r
  join public.inventory_recipe_versions rv on rv.id = r.current_version_id
  join public.inventory_recipe_lines rl on rl.version_id = rv.id and rl.item_id = p_item_id
  left join public.menu_items mi on mi.id = r.menu_item_id
  where r.organization_id = v_org and (r.branch_id is null or r.branch_id = p_branch_id)
    and r.is_active
  order by r.name;
end;
$$;
grant execute on function public.inventory_list_item_recipe_usage(uuid, uuid) to authenticated;
revoke execute on function public.inventory_list_item_recipe_usage(uuid, uuid) from anon, public;

select pg_notify('pgrst', 'reload schema');
commit;
