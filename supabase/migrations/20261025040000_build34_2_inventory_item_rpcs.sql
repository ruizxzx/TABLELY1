-- TABLELY BUILD 34.2 — Inventory items, locations & suppliers RPCs
-- Core CRUD operations for the ingredient master, storage locations,
-- suppliers, and item-supplier price relationships.
-- Additive/idempotent. Depends on 20261025030000.

begin;

-- ---------------------------------------------------------------------------
-- 1) Inventory items RPC
-- ---------------------------------------------------------------------------
create or replace function public.inventory_upsert_item(
  p_organization_id uuid,
  p_id uuid default null,
  p_name text default null,
  p_sku text default null,
  p_description text default null,
  p_category_id uuid default null,
  p_base_unit text default null,
  p_purchase_unit text default null,
  p_purchase_unit_conversion numeric default 1,
  p_reorder_level numeric default null,
  p_target_stock_level numeric default null,
  p_track_expiry boolean default false,
  p_track_batches boolean default false,
  p_preferred_supplier_id uuid default null,
  p_tax_rate_pct numeric default null,
  p_hsn_code text default null,
  p_is_active boolean default true
)
returns public.inventory_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.inventory_items;
  v_caller_org uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  -- Verify caller belongs to the organization and has write access
  select s.organization_id into v_caller_org
  from public.staff s
  where s.user_id = auth.uid()
    and s.organization_id = p_organization_id
    and s.active = true
  limit 1;

  if v_caller_org is null then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if not public.organization_has_feature(p_organization_id, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this organization' using errcode = '42501';
  end if;

  -- Must be owner OR have INVENTORY_MANAGEMENT on at least one branch of this org
  if not (
    public.is_org_owner(p_organization_id)
    or exists (
      select 1 from public.branches b
      where b.organization_id = p_organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_MANAGEMENT')
    )
  ) then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;
  if p_category_id is not null and not exists (
    select 1 from public.inventory_categories c
    where c.id = p_category_id and c.organization_id = p_organization_id
  ) then
    raise exception 'Category not found in the item organization' using errcode = '42501';
  end if;
  if p_preferred_supplier_id is not null and not exists (
    select 1 from public.inventory_suppliers s
    where s.id = p_preferred_supplier_id and s.organization_id = p_organization_id
  ) then
    raise exception 'Supplier not found in the item organization' using errcode = '42501';
  end if;

  if p_id is not null then
    -- Update
    update public.inventory_items set
      name = coalesce(p_name, name),
      sku = p_sku,
      description = p_description,
      category_id = p_category_id,
      base_unit = coalesce(p_base_unit, base_unit),
      purchase_unit = coalesce(p_purchase_unit, purchase_unit),
      purchase_unit_conversion = coalesce(p_purchase_unit_conversion, purchase_unit_conversion),
      reorder_level = p_reorder_level,
      target_stock_level = p_target_stock_level,
      track_expiry = coalesce(p_track_expiry, track_expiry),
      track_batches = coalesce(p_track_batches, track_batches),
      preferred_supplier_id = p_preferred_supplier_id,
      tax_rate_pct = p_tax_rate_pct,
      hsn_code = p_hsn_code,
      is_active = coalesce(p_is_active, is_active),
      updated_at = now()
    where id = p_id
      and organization_id = p_organization_id
    returning * into v_item;

    if v_item.id is null then
      raise exception 'Item not found or access denied' using errcode = 'P0002';
    end if;
  else
    -- Create
    if p_name is null or p_base_unit is null or p_purchase_unit is null then
      raise exception 'name, base_unit, and purchase_unit are required for new items';
    end if;

    insert into public.inventory_items(
      organization_id, name, sku, description, category_id,
      base_unit, purchase_unit, purchase_unit_conversion,
      reorder_level, target_stock_level,
      track_expiry, track_batches,
      preferred_supplier_id, tax_rate_pct, hsn_code, is_active, created_by
    ) values (
      p_organization_id, trim(p_name), nullif(trim(coalesce(p_sku,'')), ''),
      nullif(trim(coalesce(p_description,'')), ''), p_category_id,
      trim(p_base_unit), trim(p_purchase_unit), p_purchase_unit_conversion,
      p_reorder_level, p_target_stock_level,
      coalesce(p_track_expiry, false), coalesce(p_track_batches, false),
      p_preferred_supplier_id, p_tax_rate_pct, nullif(trim(coalesce(p_hsn_code,'')), ''),
      coalesce(p_is_active, true), auth.uid()
    ) returning * into v_item;
  end if;

  return v_item;
end;
$$;
grant execute on function public.inventory_upsert_item to authenticated;
revoke execute on function public.inventory_upsert_item from anon, public;

-- ---------------------------------------------------------------------------
-- 2) List inventory items with balance data
-- ---------------------------------------------------------------------------
create or replace function public.inventory_list_items(
  p_branch_id uuid,
  p_search text default null,
  p_category_id uuid default null,
  p_status text default null, -- 'LOW','OUT','HEALTHY','ALL'
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(
  id uuid,
  name text,
  sku text,
  category_id uuid,
  category_name text,
  base_unit text,
  purchase_unit text,
  purchase_unit_conversion numeric,
  reorder_level numeric,
  target_stock_level numeric,
  track_expiry boolean,
  track_batches boolean,
  is_active boolean,
  -- Balance data
  on_hand_qty numeric,
  reserved_qty numeric,
  available_qty numeric,
  avg_unit_cost_paise bigint,
  stock_value_paise bigint,
  last_movement_at timestamptz,
  -- Stock status
  stock_status text,
  -- Upcoming expiry count
  expiring_batch_count bigint
)
language plpgsql
security definer
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_org uuid;
begin
  select b.organization_id into v_org from public.branches b where b.id = p_branch_id;
  if v_org is null or not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;

  return query
  select
    ii.id,
    ii.name,
    ii.sku,
    ii.category_id,
    ic.name as category_name,
    ii.base_unit,
    ii.purchase_unit,
    ii.purchase_unit_conversion,
    ii.reorder_level,
    ii.target_stock_level,
    ii.track_expiry,
    ii.track_batches,
    ii.is_active,
    coalesce(ib.on_hand_qty, 0) as on_hand_qty,
    coalesce(ib.reserved_qty, 0) as reserved_qty,
    coalesce(ib.available_qty, 0) as available_qty,
    case when public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW')
      then coalesce(ib.avg_unit_cost_paise, 0) else null end as avg_unit_cost_paise,
    case when public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW')
      then coalesce(ib.stock_value_paise, 0) else null end as stock_value_paise,
    ib.last_movement_at,
    case
      when coalesce(ib.available_qty, 0) <= 0 then 'OUT'
      when ii.reorder_level is not null and coalesce(ib.available_qty, 0) <= ii.reorder_level then 'LOW'
      else 'HEALTHY'
    end as stock_status,
    (
      select count(*) from public.inventory_batches bat
      where bat.item_id = ii.id
        and bat.branch_id = p_branch_id
        and bat.is_active = true
        and bat.current_qty > 0
        and bat.expires_at is not null
        and bat.expires_at <= current_date + 7
    ) as expiring_batch_count
  from public.inventory_items ii
  left join public.inventory_categories ic on ic.id = ii.category_id
  left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
  where ii.organization_id = v_org
    and ii.is_active = true
    and (p_search is null or ii.name ilike '%' || p_search || '%' or ii.sku ilike '%' || p_search || '%')
    and (p_category_id is null or ii.category_id = p_category_id)
    and (
      p_status is null or p_status = 'ALL'
      or (p_status = 'OUT' and coalesce(ib.available_qty, 0) <= 0)
      or (p_status = 'LOW' and ii.reorder_level is not null and coalesce(ib.available_qty, 0) > 0 and coalesce(ib.available_qty, 0) <= ii.reorder_level)
      or (p_status = 'HEALTHY' and coalesce(ib.available_qty, 0) > 0 and (ii.reorder_level is null or coalesce(ib.available_qty, 0) > ii.reorder_level))
    )
  order by ii.name
  limit p_limit offset p_offset;
end;
$$;
grant execute on function public.inventory_list_items(uuid, text, uuid, text, integer, integer) to authenticated;
revoke execute on function public.inventory_list_items(uuid, text, uuid, text, integer, integer) from anon, public;

-- ---------------------------------------------------------------------------
-- 3) Inventory item detail
-- ---------------------------------------------------------------------------
create or replace function public.inventory_get_item_detail(
  p_item_id uuid,
  p_branch_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_item public.inventory_items;
  v_balance public.inventory_balances;
  v_result jsonb;
  v_can_view_cost boolean;
  v_can_manage_purchases boolean;
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

  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');
  v_can_manage_purchases := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_PURCHASE');

  select * into v_item from public.inventory_items where id = p_item_id;
  if v_item.id is null then
    raise exception 'Item not found' using errcode = 'P0002';
  end if;

  select * into v_balance from public.inventory_balances
  where item_id = p_item_id and branch_id = p_branch_id;

  v_result := jsonb_build_object(
    'item', row_to_json(v_item),
    'balance', case
      when v_can_view_cost then to_jsonb(v_balance)
      else to_jsonb(v_balance) - 'avg_unit_cost_paise' - 'stock_value_paise'
    end,
    'batches', (
      select coalesce(jsonb_agg(
        case when v_can_view_cost then to_jsonb(b) else to_jsonb(b) - 'unit_cost_paise' end
        order by b.expires_at asc nulls last, b.received_at asc
      ), '[]'::jsonb)
      from public.inventory_batches b
      where b.item_id = p_item_id and b.branch_id = p_branch_id and b.is_active = true and b.current_qty > 0
    ),
    'recent_movements', (
      select coalesce(jsonb_agg(
        case when v_can_view_cost then to_jsonb(m)
          else to_jsonb(m) - 'unit_cost_paise' - 'total_cost_paise'
        end order by m.created_at desc
      ), '[]'::jsonb)
      from (
        select * from public.inventory_stock_movements
        where item_id = p_item_id and branch_id = p_branch_id
        order by created_at desc limit 20
      ) m
    ),
    'suppliers', (
      select case when v_can_manage_purchases then coalesce(jsonb_agg(
        case when v_can_view_cost then to_jsonb(s) else to_jsonb(s) - 'unit_price_paise' end
      ), '[]'::jsonb) else '[]'::jsonb end
      from (
        select iis.*, sup.company_name, sup.contact_name, sup.phone
        from public.inventory_item_suppliers iis
        join public.inventory_suppliers sup on sup.id = iis.supplier_id
        where iis.item_id = p_item_id
        order by iis.is_preferred desc, sup.company_name
      ) s
    )
  );

  return v_result;
end;
$$;
grant execute on function public.inventory_get_item_detail(uuid, uuid) to authenticated;
revoke execute on function public.inventory_get_item_detail(uuid, uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- 4) Suppliers RPCs
-- ---------------------------------------------------------------------------
create or replace function public.inventory_upsert_supplier(
  p_organization_id uuid,
  p_id uuid default null,
  p_company_name text default null,
  p_contact_name text default null,
  p_phone text default null,
  p_email text default null,
  p_address text default null,
  p_gstin text default null,
  p_payment_terms_days integer default null,
  p_preferred_delivery_days text[] default null,
  p_lead_time_days integer default null,
  p_notes text default null,
  p_is_active boolean default true
)
returns public.inventory_suppliers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplier public.inventory_suppliers;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.organization_has_feature(p_organization_id, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this organization' using errcode = '42501';
  end if;

  if not (
    public.is_org_owner(p_organization_id)
    or exists (
      select 1 from public.branches b
      where b.organization_id = p_organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
    )
  ) then
    raise exception 'INVENTORY_PURCHASE permission required' using errcode = '42501';
  end if;

  if p_id is not null then
    update public.inventory_suppliers set
      company_name = coalesce(p_company_name, company_name),
      contact_name = p_contact_name,
      phone = p_phone,
      email = p_email,
      address = p_address,
      gstin = p_gstin,
      payment_terms_days = p_payment_terms_days,
      preferred_delivery_days = p_preferred_delivery_days,
      lead_time_days = p_lead_time_days,
      notes = p_notes,
      is_active = coalesce(p_is_active, is_active),
      updated_at = now()
    where id = p_id and organization_id = p_organization_id
    returning * into v_supplier;
  else
    if p_company_name is null then raise exception 'company_name is required'; end if;
    insert into public.inventory_suppliers(
      organization_id, company_name, contact_name, phone, email, address,
      gstin, payment_terms_days, preferred_delivery_days, lead_time_days, notes, is_active
    ) values (
      p_organization_id, trim(p_company_name), p_contact_name, p_phone, p_email, p_address,
      p_gstin, p_payment_terms_days, p_preferred_delivery_days, p_lead_time_days, p_notes,
      coalesce(p_is_active, true)
    ) returning * into v_supplier;
  end if;

  return v_supplier;
end;
$$;
grant execute on function public.inventory_upsert_supplier to authenticated;
revoke execute on function public.inventory_upsert_supplier from anon, public;

create or replace function public.inventory_list_suppliers(p_organization_id uuid)
returns setof public.inventory_suppliers
language sql
security definer
stable
set search_path = public
as $$
  select s.* from public.inventory_suppliers s
  where s.organization_id = p_organization_id
    and public.organization_has_feature(p_organization_id, 'INVENTORY')
    and exists (
      select 1 from public.branches b
      where b.organization_id = p_organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
    )
  order by s.company_name;
$$;
grant execute on function public.inventory_list_suppliers(uuid) to authenticated;
revoke execute on function public.inventory_list_suppliers(uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- 5) Item-supplier price RPCs
-- ---------------------------------------------------------------------------
create or replace function public.inventory_upsert_item_supplier(
  p_item_id uuid,
  p_supplier_id uuid,
  p_unit_price_paise bigint,
  p_price_unit text,
  p_supplier_item_code text default null,
  p_is_preferred boolean default false,
  p_notes text default null
)
returns public.inventory_item_suppliers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_item_suppliers;
  v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  select organization_id into v_org from public.inventory_items where id = p_item_id;
  if v_org is null then raise exception 'Item not found'; end if;
  if not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this organization' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.inventory_suppliers s
    where s.id = p_supplier_id and s.organization_id = v_org
  ) then
    raise exception 'Supplier not found in the item organization' using errcode = '42501';
  end if;

  if not (
    public.is_org_owner(v_org)
    or exists (
      select 1 from public.branches b
      where b.organization_id = v_org
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
    )
  ) then
    raise exception 'INVENTORY_PURCHASE permission required' using errcode = '42501';
  end if;

  -- If marking as preferred, unset other preferred flags for this item
  if p_is_preferred then
    update public.inventory_item_suppliers set is_preferred = false
    where item_id = p_item_id;
  end if;

  insert into public.inventory_item_suppliers(
    item_id, supplier_id, organization_id,
    supplier_item_code, unit_price_paise, price_unit, is_preferred, notes
  ) values (
    p_item_id, p_supplier_id, v_org,
    p_supplier_item_code, p_unit_price_paise, p_price_unit,
    coalesce(p_is_preferred, false), p_notes
  )
  on conflict (item_id, supplier_id) do update set
    supplier_item_code = coalesce(excluded.supplier_item_code, inventory_item_suppliers.supplier_item_code),
    unit_price_paise = excluded.unit_price_paise,
    price_unit = excluded.price_unit,
    is_preferred = excluded.is_preferred,
    notes = excluded.notes,
    effective_from = now(),
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.inventory_upsert_item_supplier to authenticated;
revoke execute on function public.inventory_upsert_item_supplier from anon, public;

-- ---------------------------------------------------------------------------
-- 6) Storage locations RPCs
-- ---------------------------------------------------------------------------
create or replace function public.inventory_upsert_location(
  p_branch_id uuid,
  p_id uuid default null,
  p_name text default null,
  p_description text default null,
  p_is_active boolean default true,
  p_sort_order integer default 0
)
returns public.inventory_locations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.inventory_locations;
  v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  if p_id is not null then
    update public.inventory_locations set
      name = coalesce(p_name, name),
      description = p_description,
      is_active = coalesce(p_is_active, is_active),
      sort_order = coalesce(p_sort_order, sort_order)
    where id = p_id and branch_id = p_branch_id
    returning * into v_row;
  else
    if p_name is null then raise exception 'name is required'; end if;
    insert into public.inventory_locations(branch_id, organization_id, name, description, is_active, sort_order)
    values (p_branch_id, v_org, trim(p_name), p_description, coalesce(p_is_active, true), coalesce(p_sort_order, 0))
    returning * into v_row;
  end if;

  return v_row;
end;
$$;
grant execute on function public.inventory_upsert_location to authenticated;
revoke execute on function public.inventory_upsert_location from anon, public;

-- ---------------------------------------------------------------------------
-- 7) Branch settings upsert
-- ---------------------------------------------------------------------------
create or replace function public.inventory_upsert_branch_settings(
  p_branch_id uuid,
  p_stock_mode text default 'WARNING',
  p_expiry_alert_days_1 integer default 7,
  p_expiry_alert_days_2 integer default 3,
  p_expiry_alert_days_3 integer default 1,
  p_variance_alert_threshold_pct numeric default 10,
  p_target_food_cost_pct numeric default null
)
returns public.branch_inventory_settings
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.branch_inventory_settings; v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;
  if p_stock_mode not in ('STRICT','WARNING','DISABLED') then
    raise exception 'stock_mode must be STRICT, WARNING, or DISABLED';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  perform public.inventory_ensure_branch_settings(p_branch_id);

  update public.branch_inventory_settings set
    stock_mode = p_stock_mode,
    expiry_alert_days_1 = coalesce(p_expiry_alert_days_1, expiry_alert_days_1),
    expiry_alert_days_2 = coalesce(p_expiry_alert_days_2, expiry_alert_days_2),
    expiry_alert_days_3 = coalesce(p_expiry_alert_days_3, expiry_alert_days_3),
    variance_alert_threshold_pct = coalesce(p_variance_alert_threshold_pct, variance_alert_threshold_pct),
    target_food_cost_pct = p_target_food_cost_pct,
    updated_at = now(),
    updated_by = auth.uid()
  where branch_id = p_branch_id
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.inventory_upsert_branch_settings to authenticated;
revoke execute on function public.inventory_upsert_branch_settings from anon, public;

-- ---------------------------------------------------------------------------
-- 8) Dashboard overview metrics
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
      join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
      where ii.organization_id = v_org and ii.is_active
        and ii.reorder_level is not null
        and ib.available_qty > 0
        and ib.available_qty <= ii.reorder_level
    ),
    'out_of_stock_count', (
      select count(*) from public.inventory_items ii
      join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
      where ii.organization_id = v_org and ii.is_active
        and ib.available_qty <= 0
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
        join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
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
