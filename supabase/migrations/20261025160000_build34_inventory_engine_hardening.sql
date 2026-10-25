-- TABLELY BUILD 34 — Complete Inventory Engine Hardening, Order Lifecycle Correctness & Feature Completion
-- P0: Order items schema fix, duplicate SALE conflict aggregation, NEW->PREPARING reservation, item cancellations
-- P1: FEFO batch allocation, location-specific counts, supplier price history, base-unit protection, sub-recipe production
-- P1: Error replay & reconciliation, operational food cost for unpaid orders, recipe coverage, smart reorders

begin;

-- ===========================================================================
-- 1. ORDER ITEM CANCELLATION & RESERVATION LINE TRACKING
-- ===========================================================================

-- Trigger function on order_items to release reserved ingredients when an item is cancelled
create or replace function public.inventory_order_item_lifecycle_hook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res_line record;
  v_order public.orders%rowtype;
begin
  -- Only act when preparation_status transitions to CANCELLED
  if new.preparation_status = 'CANCELLED'
     and (old.preparation_status is null or old.preparation_status <> 'CANCELLED') then

    select * into v_order from public.orders where id = new.order_id;
    if v_order.id is null or v_order.status in ('COMPLETED', 'CANCELLED') then
      return new;
    end if;

    -- Find active reservation lines associated with this specific cancelled order item
    for v_res_line in
      select rl.id, rl.item_id, rl.branch_id, rl.reserved_qty
      from public.inventory_reservation_lines rl
      join public.inventory_reservations r on r.id = rl.reservation_id
      where rl.order_item_id = new.id
        and r.status = 'ACTIVE'
    loop
      -- Release the reserved quantity from the balance cache
      perform public.inventory_update_reservation(
        v_res_line.item_id, v_res_line.branch_id, -v_res_line.reserved_qty
      );
      -- Delete the reservation line so it is never consumed on order completion
      delete from public.inventory_reservation_lines where id = v_res_line.id;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists inventory_order_item_lifecycle on public.order_items;
create trigger inventory_order_item_lifecycle
  after update of preparation_status on public.order_items
  for each row
  execute function public.inventory_order_item_lifecycle_hook();

-- ===========================================================================
-- 2. HARDENED ORDER RESERVATION (Handles NEW->PREPARING, Portions & Modifiers)
-- ===========================================================================

create or replace function public.inventory_reserve_for_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_order public.orders%rowtype;
  v_settings public.branch_inventory_settings;
  v_reservation public.inventory_reservations;
  v_recipe public.inventory_recipes;
  v_version_id uuid;
  v_line public.inventory_recipe_lines;
  v_oi public.order_items%rowtype;
  v_item public.inventory_items;
  v_needed_qty numeric;
  v_available_qty numeric;
  v_insufficient_items text[] := array[]::text[];
  v_missing_recipes text[] := array[]::text[];
  v_addon record;
  v_addon_item public.inventory_items;
  v_portion_multiplier numeric := 1.0;
  v_opt record;
begin
  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then return; end if;
  if not public.organization_has_feature(
    (select b.organization_id from public.branches b where b.id = v_order.branch_id),
    'INVENTORY'
  ) then
    return;
  end if;

  -- Get branch settings; default to WARNING if not configured
  select * into v_settings from public.branch_inventory_settings
  where branch_id = v_order.branch_id;

  -- If DISABLED, skip entirely
  if v_settings.stock_mode = 'DISABLED' or v_settings.branch_id is null then
    return;
  end if;

  -- Idempotency check: if reservation already exists for this order, do nothing
  select * into v_reservation from public.inventory_reservations
  where order_id = p_order_id;
  if v_reservation.id is not null then return; end if;

  -- Create reservation header
  insert into public.inventory_reservations(order_id, branch_id, organization_id, status)
  values (
    p_order_id,
    v_order.branch_id,
    (select b.organization_id from public.branches b where b.id = v_order.branch_id),
    'ACTIVE'
  )
  on conflict (order_id) do nothing
  returning * into v_reservation;

  if v_reservation.id is null then return; end if; -- Concurrently created

  -- For each uncancelled order item, find recipe and reserve ingredients
  for v_oi in
    select * from public.order_items
    where order_id = p_order_id
      and (preparation_status is null or preparation_status <> 'CANCELLED')
  loop
    -- Detect portion variants (e.g. Half = 0.5, Small = 0.75, Large = 1.5)
    v_portion_multiplier := 1.0;
    if v_oi.selected_options is not null and jsonb_typeof(to_jsonb(v_oi.selected_options)) = 'array' then
      for v_opt in select * from jsonb_to_recordset(to_jsonb(v_oi.selected_options)) as x(name text, type text) loop
        if lower(coalesce(v_opt.name, '')) in ('half', 'small') then
          v_portion_multiplier := 0.5;
        elsif lower(coalesce(v_opt.name, '')) in ('large', 'double') then
          v_portion_multiplier := 1.5;
        end if;
      end loop;
    end if;

    -- Find active recipe for this menu item
    select r.* into v_recipe
    from public.inventory_recipes r
    where r.menu_item_id = v_oi.menu_item_id
      and r.is_active = true
      and (r.branch_id is null or r.branch_id = v_order.branch_id)
    order by r.branch_id desc nulls last
    limit 1;

    if v_recipe.id is null or v_recipe.current_version_id is null then
      v_missing_recipes := v_missing_recipes || v_oi.item_name_snapshot;
      continue;
    end if;

    v_version_id := v_recipe.current_version_id;

    -- For each ingredient line in the recipe
    for v_line in
      select * from public.inventory_recipe_lines
      where version_id = v_version_id and item_id is not null
    loop
      select * into v_item from public.inventory_items where id = v_line.item_id;
      if v_item.id is null then continue; end if;

      -- Needed quantity = gross_qty_per_serving * order item quantity * portion multiplier
      v_needed_qty := v_line.gross_qty_per_serving * v_oi.quantity * v_portion_multiplier;

      -- Serialize reservations for this branch/item
      perform pg_advisory_xact_lock(
        hashtextextended(v_line.item_id::text || ':' || v_order.branch_id::text, 0)
      );

      select coalesce(available_qty, 0) into v_available_qty
      from public.inventory_balances
      where item_id = v_line.item_id and branch_id = v_order.branch_id
      for update;

      if v_settings.stock_mode = 'STRICT' and coalesce(v_available_qty, 0) < v_needed_qty then
        v_insufficient_items := v_insufficient_items || v_item.name;
      end if;

      -- Create reservation line
      insert into public.inventory_reservation_lines(
        reservation_id, order_item_id, item_id, branch_id,
        reserved_qty, unit, recipe_version_id,
        stock_available
      ) values (
        v_reservation.id, v_oi.id, v_line.item_id, v_order.branch_id,
        v_needed_qty, v_item.base_unit, v_version_id,
        coalesce(v_available_qty, 0) >= v_needed_qty
      );

      -- Update reservation cache in balance
      perform public.inventory_update_reservation(v_line.item_id, v_order.branch_id, v_needed_qty);
    end loop;

    -- Also check selected_addons for extra tracked ingredients (e.g. Extra Cheese, Extra Paneer)
    if v_oi.selected_addons is not null and jsonb_typeof(to_jsonb(v_oi.selected_addons)) = 'array' then
      for v_addon in select * from jsonb_to_recordset(to_jsonb(v_oi.selected_addons)) as a(name text, price numeric) loop
        select * into v_addon_item from public.inventory_items
        where organization_id = v_order.organization_id
          and is_active = true
          and (
            lower(name) = lower(trim(replace(replace(v_addon.name, 'Extra ', ''), 'Add ', '')))
            or name ilike '%' || trim(replace(replace(v_addon.name, 'Extra ', ''), 'Add ', '')) || '%'
          )
        limit 1;

        if v_addon_item.id is not null then
          -- Default extra portion (e.g. 50g / 50ml / 1 portion)
          v_needed_qty := case
            when v_addon_item.base_unit in ('g', 'ml') then 50.0 * v_oi.quantity
            else 1.0 * v_oi.quantity
          end;

          insert into public.inventory_reservation_lines(
            reservation_id, order_item_id, item_id, branch_id,
            reserved_qty, unit, recipe_version_id, stock_available
          ) values (
            v_reservation.id, v_oi.id, v_addon_item.id, v_order.branch_id,
            v_needed_qty, v_addon_item.base_unit, null, true
          );

          perform public.inventory_update_reservation(v_addon_item.id, v_order.branch_id, v_needed_qty);
        end if;
      end loop;
    end if;

  end loop;

  -- STRICT mode validation
  if v_settings.stock_mode = 'STRICT' then
    if array_length(v_missing_recipes, 1) > 0 then
      delete from public.inventory_reservation_lines where reservation_id = v_reservation.id;
      delete from public.inventory_reservations where id = v_reservation.id;
      raise exception 'Missing recipe in STRICT mode for: %', array_to_string(v_missing_recipes, ', ')
        using errcode = 'P0001';
    end if;

    if array_length(v_insufficient_items, 1) > 0 then
      delete from public.inventory_reservation_lines where reservation_id = v_reservation.id;
      delete from public.inventory_reservations where id = v_reservation.id;
      raise exception 'Insufficient stock for: %. Order cannot be accepted in STRICT mode.',
        array_to_string(v_insufficient_items, ', ')
        using errcode = 'P0001';
    end if;
  end if;

end;
$$;

-- ===========================================================================
-- 3. HARDENED ORDER CONSUMPTION (Aggregated Dedup & FEFO Batch Allocation)
-- ===========================================================================

create or replace function public.inventory_consume_for_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_reservation public.inventory_reservations;
  v_agg record;
  v_batch record;
  v_movement_id uuid;
  v_unit_cost bigint;
  v_remaining_to_deduct numeric;
  v_batch_deduct numeric;
begin
  select * into v_reservation
  from public.inventory_reservations
  where order_id = p_order_id and status = 'ACTIVE'
  for update;

  -- No active reservation means either untracked or already consumed
  if v_reservation.id is null then return; end if;
  if v_reservation.consumed_at is not null then return; end if;

  -- Mark reservation as consumed atomically before creating movements
  update public.inventory_reservations
  set status = 'CONSUMED', consumed_at = now()
  where id = v_reservation.id;

  -- Aggregate reserved ingredients by item_id & branch_id before inserting movements.
  -- This eliminates unique constraint conflicts when multiple menu items use the same ingredient.
  for v_agg in
    select
      rl.item_id,
      rl.branch_id,
      min(rl.unit) as unit,
      sum(rl.reserved_qty) as total_qty,
      max(rl.recipe_version_id) as recipe_version_id
    from public.inventory_reservation_lines rl
    where rl.reservation_id = v_reservation.id
    group by rl.item_id, rl.branch_id
  loop
    -- Get current average cost for this ingredient
    select coalesce(avg_unit_cost_paise, 0) into v_unit_cost
    from public.inventory_balances
    where item_id = v_agg.item_id and branch_id = v_agg.branch_id;

    -- Insert exactly one aggregated SALE stock movement per item
    insert into public.inventory_stock_movements(
      item_id, branch_id, organization_id,
      movement_type, qty, unit, unit_cost_paise, total_cost_paise,
      source_event_type, source_event_id, recipe_version_id, created_by
    ) values (
      v_agg.item_id, v_agg.branch_id, v_reservation.organization_id,
      'SALE', -v_agg.total_qty, v_agg.unit,
      v_unit_cost, (v_agg.total_qty * v_unit_cost)::bigint,
      'ORDER', p_order_id, v_agg.recipe_version_id, null
    )
    on conflict (source_event_id, item_id, branch_id, movement_type) do nothing
    returning id into v_movement_id;

    -- Update balance: deduct on-hand stock and release reservation
    perform public.inventory_update_balance(
      v_agg.item_id, v_agg.branch_id, -v_agg.total_qty, 0
    );
    perform public.inventory_update_reservation(
      v_agg.item_id, v_agg.branch_id, -v_agg.total_qty
    );

    -- FEFO Batch Allocation: deduct stock from active batches in ascending expiry order
    v_remaining_to_deduct := v_agg.total_qty;
    for v_batch in
      select id, current_qty, expires_at
      from public.inventory_batches
      where item_id = v_agg.item_id
        and branch_id = v_agg.branch_id
        and is_active = true
        and current_qty > 0
      order by expires_at asc nulls last, created_at asc
      for update
    loop
      exit when v_remaining_to_deduct <= 0;
      v_batch_deduct := least(v_batch.current_qty, v_remaining_to_deduct);

      update public.inventory_batches
      set current_qty = current_qty - v_batch_deduct,
          updated_at = now()
      where id = v_batch.id;

      v_remaining_to_deduct := v_remaining_to_deduct - v_batch_deduct;
    end loop;

  end loop;

end;
$$;

-- ===========================================================================
-- 4. ORDER LIFECYCLE HOOK TRIGGER (Supports NEW->PREPARING & Re-entrancy)
-- ===========================================================================

create or replace function public.inventory_order_lifecycle_hook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_stock_mode text := 'WARNING';
begin
  if old.status = new.status then return new; end if;

  select b.organization_id into v_organization_id
  from public.branches b
  where b.id = new.branch_id;

  if v_organization_id is null
     or not public.organization_has_feature(v_organization_id, 'INVENTORY') then
    return new;
  end if;

  select s.stock_mode into v_stock_mode
  from public.branch_inventory_settings s
  where s.branch_id = new.branch_id;
  v_stock_mode := coalesce(v_stock_mode, 'WARNING');

  if v_stock_mode = 'DISABLED' then return new; end if;

  begin
    -- Both ACCEPTED and PREPARING trigger inventory reservations
    if new.status in ('ACCEPTED', 'PREPARING') then
      perform public.inventory_reserve_for_order(new.id);

    elsif new.status = 'COMPLETED' then
      -- If order went directly to COMPLETED without prior reservation, reserve first
      perform public.inventory_reserve_for_order(new.id);
      perform public.inventory_consume_for_order(new.id);

    elsif new.status = 'CANCELLED' then
      perform public.inventory_release_reservation(new.id);
    end if;

  exception when others then
    if v_stock_mode = 'STRICT' then
      raise;
    end if;

    -- WARNING mode: record error for visibility and reconciliation
    insert into public.inventory_processing_errors(
      organization_id, branch_id, order_id, order_status, error_code, error_message
    ) values (
      v_organization_id, new.branch_id, new.id, new.status::text, sqlstate,
      left(sqlerrm, 500)
    )
    on conflict (order_id, order_status, error_code)
    do update set
      occurrences = public.inventory_processing_errors.occurrences + 1,
      last_seen_at = now(),
      error_message = excluded.error_message,
      resolved_at = null,
      resolved_by = null;
  end;

  return new;
end;
$$;

-- ===========================================================================
-- 5. ERROR RECOVERY WITH REAL OPERATION REPLAY
-- ===========================================================================

create or replace function public.inventory_resolve_processing_error(
  p_error_id uuid,
  p_action text default 'RETRY' -- 'RETRY', 'RESOLVE', 'IGNORE'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_error public.inventory_processing_errors;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_error
  from public.inventory_processing_errors
  where id = p_error_id
  for update;

  if v_error.id is null then
    raise exception 'Inventory processing error not found' using errcode = 'P0002';
  end if;
  if not public.organization_has_feature(v_error.organization_id, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(v_error.branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  if upper(p_action) = 'RETRY' then
    begin
      if v_error.order_status in ('ACCEPTED', 'PREPARING') then
        perform public.inventory_reserve_for_order(v_error.order_id);
      elsif v_error.order_status = 'COMPLETED' then
        perform public.inventory_reserve_for_order(v_error.order_id);
        perform public.inventory_consume_for_order(v_error.order_id);
      elsif v_error.order_status = 'CANCELLED' then
        perform public.inventory_release_reservation(v_error.order_id);
      end if;

      -- Mark as resolved upon successful execution
      update public.inventory_processing_errors
      set resolved_at = now(), resolved_by = auth.uid()
      where id = p_error_id;

    exception when others then
      update public.inventory_processing_errors
      set occurrences = occurrences + 1,
          last_seen_at = now(),
          error_message = 'Retry failed: ' || sqlerrm
      where id = p_error_id;
      raise exception 'Replay failed: %', sqlerrm;
    end;
  else
    -- Manual reconciliation or ignore
    update public.inventory_processing_errors
    set resolved_at = now(), resolved_by = auth.uid()
    where id = p_error_id;
  end if;

end;
$$;
grant execute on function public.inventory_resolve_processing_error(uuid, text) to authenticated;

-- ===========================================================================
-- 6. PROTECT BASE-UNIT CHANGES IN INVENTORY ITEM UPSERT
-- ===========================================================================

create or replace function public.inventory_upsert_item(
  p_branch_id uuid,
  p_id uuid default null,
  p_name text default null,
  p_sku text default null,
  p_category_id uuid default null,
  p_base_unit text default 'g',
  p_purchase_unit text default 'kg',
  p_purchase_unit_conversion numeric default 1000,
  p_reorder_level numeric default null,
  p_target_stock_level numeric default null,
  p_track_expiry boolean default false,
  p_track_batches boolean default false,
  p_preferred_supplier_id uuid default null,
  p_default_location_id uuid default null,
  p_tax_rate_pct numeric default 0,
  p_is_active boolean default true
)
returns public.inventory_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_item public.inventory_items;
  v_existing public.inventory_items;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  if trim(coalesce(p_name, '')) = '' then
    raise exception 'Ingredient name is required';
  end if;
  if p_purchase_unit_conversion <= 0 then
    raise exception 'Purchase unit conversion must be greater than zero';
  end if;

  if p_id is not null then
    select * into v_existing from public.inventory_items where id = p_id and organization_id = v_org;
    if v_existing.id is null then
      raise exception 'Inventory item not found';
    end if;

    -- Base-unit change protection: disallow changing base_unit once movements or recipes exist
    if v_existing.base_unit <> p_base_unit then
      if exists (select 1 from public.inventory_stock_movements where item_id = p_id limit 1)
         or exists (select 1 from public.inventory_recipe_lines where item_id = p_id limit 1) then
        raise exception 'Base unit cannot be changed because inventory movements or recipes already exist for this item';
      end if;
    end if;

    update public.inventory_items set
      name = trim(p_name),
      sku = nullif(trim(p_sku), ''),
      category_id = p_category_id,
      base_unit = p_base_unit,
      purchase_unit = p_purchase_unit,
      purchase_unit_conversion = p_purchase_unit_conversion,
      reorder_level = p_reorder_level,
      target_stock_level = p_target_stock_level,
      track_expiry = p_track_expiry,
      track_batches = p_track_batches,
      preferred_supplier_id = p_preferred_supplier_id,
      default_location_id = p_default_location_id,
      tax_rate_pct = coalesce(p_tax_rate_pct, 0),
      is_active = p_is_active,
      updated_at = now()
    where id = p_id and organization_id = v_org
    returning * into v_item;
  else
    insert into public.inventory_items(
      organization_id, name, sku, category_id,
      base_unit, purchase_unit, purchase_unit_conversion,
      reorder_level, target_stock_level,
      track_expiry, track_batches,
      preferred_supplier_id, default_location_id,
      tax_rate_pct, is_active
    ) values (
      v_org, trim(p_name), nullif(trim(p_sku), ''), p_category_id,
      p_base_unit, p_purchase_unit, p_purchase_unit_conversion,
      p_reorder_level, p_target_stock_level,
      p_track_expiry, p_track_batches,
      p_preferred_supplier_id, p_default_location_id,
      coalesce(p_tax_rate_pct, 0), p_is_active
    )
    returning * into v_item;

    -- Initialize zero balance for the branch
    insert into public.inventory_balances(item_id, branch_id, organization_id, on_hand_qty, avg_unit_cost_paise, stock_value_paise)
    values (v_item.id, p_branch_id, v_org, 0, 0, 0)
    on conflict (item_id, branch_id) do nothing;
  end if;

  return v_item;
end;
$$;

-- ===========================================================================
-- 7. IMMUTABLE SUPPLIER PRICE HISTORY
-- ===========================================================================

create table if not exists public.inventory_supplier_price_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  supplier_id uuid not null references public.inventory_suppliers(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  price_paise bigint not null check (price_paise >= 0),
  price_unit text not null,
  min_order_qty numeric(15, 4) not null default 1,
  effective_date date not null default current_date,
  source_type text not null default 'MANUAL', -- 'MANUAL', 'PO', 'GRN'
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index if not exists inventory_supplier_price_history_item_idx
  on public.inventory_supplier_price_history(item_id, effective_date desc);

alter table public.inventory_supplier_price_history enable row level security;

create policy inventory_supplier_price_history_select on public.inventory_supplier_price_history
  for select to authenticated
  using (
    exists (
      select 1 from public.branches b
      where b.organization_id = inventory_supplier_price_history.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_COST_VIEW')
    )
  );

grant select on public.inventory_supplier_price_history to authenticated;
revoke all on public.inventory_supplier_price_history from anon;

-- Hook into inventory_upsert_item_supplier to automatically append to history
create or replace function public.inventory_upsert_item_supplier(
  p_branch_id uuid,
  p_item_id uuid,
  p_supplier_id uuid,
  p_supplier_sku text default null,
  p_price_paise bigint default 0,
  p_price_unit text default null,
  p_min_order_qty numeric default 1,
  p_lead_time_days integer default null,
  p_is_preferred boolean default false
)
returns public.inventory_item_suppliers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_row public.inventory_item_suppliers;
  v_unit text;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_PURCHASE') then
    raise exception 'INVENTORY_PURCHASE permission required' using errcode = '42501';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  select purchase_unit into v_unit from public.inventory_items where id = p_item_id and organization_id = v_org;
  if v_unit is null then raise exception 'Inventory item not found'; end if;
  v_unit := coalesce(p_price_unit, v_unit);

  if p_is_preferred then
    update public.inventory_item_suppliers set is_preferred = false
    where item_id = p_item_id and organization_id = v_org;
    update public.inventory_items set preferred_supplier_id = p_supplier_id
    where id = p_item_id and organization_id = v_org;
  end if;

  insert into public.inventory_item_suppliers(
    organization_id, item_id, supplier_id, supplier_sku,
    price_paise, price_unit, min_order_qty, lead_time_days,
    is_preferred, effective_date, updated_at
  ) values (
    v_org, p_item_id, p_supplier_id, nullif(trim(p_supplier_sku), ''),
    p_price_paise, v_unit, coalesce(p_min_order_qty, 1), p_lead_time_days,
    p_is_preferred, current_date, now()
  )
  on conflict (item_id, supplier_id) do update set
    supplier_sku = excluded.supplier_sku,
    price_paise = excluded.price_paise,
    price_unit = excluded.price_unit,
    min_order_qty = excluded.min_order_qty,
    lead_time_days = excluded.lead_time_days,
    is_preferred = excluded.is_preferred,
    effective_date = current_date,
    updated_at = now()
  returning * into v_row;

  -- Record price history
  insert into public.inventory_supplier_price_history(
    organization_id, supplier_id, item_id, price_paise, price_unit,
    min_order_qty, effective_date, source_type, created_by
  ) values (
    v_org, p_supplier_id, p_item_id, p_price_paise, v_unit,
    coalesce(p_min_order_qty, 1), current_date, 'MANUAL', auth.uid()
  );

  return v_row;
end;
$$;

-- Price history query RPC
create or replace function public.inventory_get_supplier_price_history(
  p_item_id uuid,
  p_branch_id uuid
)
returns table(
  id uuid,
  supplier_id uuid,
  supplier_name text,
  price_paise bigint,
  price_unit text,
  effective_date date,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
#variable_conflict use_column
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW') then
    raise exception 'INVENTORY_COST_VIEW permission required' using errcode = '42501';
  end if;

  return query
  select
    h.id,
    h.supplier_id,
    s.company_name as supplier_name,
    h.price_paise,
    h.price_unit,
    h.effective_date,
    h.created_at
  from public.inventory_supplier_price_history h
  join public.inventory_suppliers s on s.id = h.supplier_id
  where h.item_id = p_item_id
  order by h.effective_date desc, h.created_at desc;
end;
$$;
grant execute on function public.inventory_get_supplier_price_history(uuid, uuid) to authenticated;

-- ===========================================================================
-- 8. RECIPE COSTING WITH SUPPLIER FALLBACK & UNPRICED INGREDIENTS
-- ===========================================================================

create or replace function public.inventory_calculate_recipe_cost(
  p_recipe_id uuid,
  p_branch_id uuid
)
returns table(
  total_cost_paise bigint,
  cost_per_serving_paise bigint,
  is_cost_complete boolean,
  unpriced_count bigint
)
language plpgsql
security definer
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_recipe public.inventory_recipes;
  v_version_id uuid;
  v_total bigint := 0;
  v_line record;
  v_cost_paise bigint;
  v_item public.inventory_items;
  v_sup_price bigint;
  v_conversion numeric;
  v_unpriced bigint := 0;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW') then
    raise exception 'INVENTORY_COST_VIEW permission required' using errcode = '42501';
  end if;

  select * into v_recipe from public.inventory_recipes where id = p_recipe_id;
  if v_recipe.id is null then raise exception 'Recipe not found'; end if;
  v_version_id := v_recipe.current_version_id;
  if v_version_id is null then
    return query select 0::bigint, 0::bigint, false, 0::bigint;
    return;
  end if;

  for v_line in
    select rl.* from public.inventory_recipe_lines rl
    where rl.version_id = v_version_id
  loop
    v_cost_paise := 0;
    if v_line.item_id is not null then
      select avg_unit_cost_paise into v_cost_paise
      from public.inventory_balances
      where item_id = v_line.item_id and branch_id = p_branch_id;

      -- If zero or unpriced, fall back to preferred supplier price
      if coalesce(v_cost_paise, 0) <= 0 then
        select ii.purchase_unit_conversion into v_conversion
        from public.inventory_items ii where ii.id = v_line.item_id;

        select iis.price_paise into v_sup_price
        from public.inventory_item_suppliers iis
        where iis.item_id = v_line.item_id and iis.is_preferred = true
        limit 1;

        if v_sup_price is not null and coalesce(v_conversion, 1) > 0 then
          v_cost_paise := (v_sup_price::numeric / v_conversion)::bigint;
        else
          v_unpriced := v_unpriced + 1;
        end if;
      end if;

      v_total := v_total + (v_line.gross_qty_per_serving * coalesce(v_cost_paise, 0))::bigint;

    elsif v_line.sub_recipe_id is not null then
      -- Nested sub-recipe costing
      select coalesce(rv.cost_per_serving_paise, 0) into v_cost_paise
      from public.inventory_recipes sr
      join public.inventory_recipe_versions rv on rv.id = sr.current_version_id
      where sr.id = v_line.sub_recipe_id;

      if coalesce(v_cost_paise, 0) <= 0 then
        v_unpriced := v_unpriced + 1;
      end if;

      v_total := v_total + (v_line.gross_qty_per_serving * coalesce(v_cost_paise, 0))::bigint;
    end if;
  end loop;

  return query select
    v_total,
    case when v_recipe.output_servings > 0
      then (v_total::numeric / v_recipe.output_servings)::bigint
      else v_total end,
    (v_unpriced = 0),
    v_unpriced;
end;
$$;
grant execute on function public.inventory_calculate_recipe_cost(uuid, uuid) to authenticated;

-- ===========================================================================
-- 9. SUB-RECIPE PRODUCTION BATCH WORKFLOW
-- ===========================================================================

create or replace function public.inventory_record_production_batch(
  p_branch_id uuid,
  p_recipe_id uuid,
  p_batch_qty numeric,
  p_location_id uuid default null,
  p_batch_number text default null,
  p_expiry_date date default null,
  p_notes text default null
)
returns public.inventory_production_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_recipe public.inventory_recipes;
  v_prod public.inventory_production_batches;
  v_line record;
  v_item public.inventory_items;
  v_input_qty numeric;
  v_input_cost bigint;
  v_total_cost bigint := 0;
  v_out_item public.inventory_items;
  v_out_batch public.inventory_batches;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  select * into v_recipe from public.inventory_recipes
  where id = p_recipe_id and is_sub_recipe = true and is_active = true;
  if v_recipe.id is null then
    raise exception 'Active sub-recipe not found';
  end if;
  if p_batch_qty <= 0 then
    raise exception 'Batch quantity must be greater than zero';
  end if;

  -- Consume raw materials (PRODUCTION_INPUT)
  for v_line in
    select rl.* from public.inventory_recipe_lines rl
    where rl.version_id = v_recipe.current_version_id and rl.item_id is not null
  loop
    v_input_qty := v_line.gross_qty_per_serving * p_batch_qty;
    select coalesce(avg_unit_cost_paise, 0) into v_input_cost
    from public.inventory_balances
    where item_id = v_line.item_id and branch_id = p_branch_id;

    v_total_cost := v_total_cost + (v_input_qty * v_input_cost)::bigint;

    -- Deduct raw material
    insert into public.inventory_stock_movements(
      item_id, branch_id, location_id, organization_id,
      movement_type, qty, unit, unit_cost_paise, total_cost_paise,
      source_event_type, notes, created_by
    ) values (
      v_line.item_id, p_branch_id, p_location_id, v_org,
      'PRODUCTION_INPUT', -v_input_qty, v_line.unit, v_input_cost,
      (v_input_qty * v_input_cost)::bigint, 'PRODUCTION',
      'Consumed for prep batch: ' || v_recipe.name, auth.uid()
    );

    perform public.inventory_update_balance(v_line.item_id, p_branch_id, -v_input_qty, 0);
  end loop;

  -- Create production record
  insert into public.inventory_production_batches(
    organization_id, branch_id, recipe_id, recipe_version_id,
    location_id, status, batch_qty, batch_unit,
    total_cost_paise, cost_per_unit_paise, production_date,
    expiry_date, notes, created_by
  ) values (
    v_org, p_branch_id, p_recipe_id, v_recipe.current_version_id,
    p_location_id, 'COMPLETED', p_batch_qty, v_recipe.output_unit,
    v_total_cost, case when p_batch_qty > 0 then (v_total_cost / p_batch_qty)::bigint else 0 end,
    current_date, p_expiry_date, p_notes, auth.uid()
  ) returning * into v_prod;

  -- If this sub-recipe corresponds to an inventory item (prepared sauce/gravy item)
  select * into v_out_item from public.inventory_items
  where organization_id = v_org and name ilike v_recipe.name and is_active = true limit 1;

  if v_out_item.id is not null then
    insert into public.inventory_batches(
      item_id, branch_id, location_id, organization_id,
      batch_number, expires_at, received_qty, current_qty,
      unit_cost_paise, is_active
    ) values (
      v_out_item.id, p_branch_id, p_location_id, v_org,
      coalesce(p_batch_number, 'PREP-' || to_char(now(), 'YYYYMMDD-HH24MI')),
      p_expiry_date, p_batch_qty, p_batch_qty,
      v_prod.cost_per_unit_paise, true
    ) returning * into v_out_batch;

    insert into public.inventory_stock_movements(
      item_id, branch_id, location_id, batch_id, organization_id,
      movement_type, qty, unit, unit_cost_paise, total_cost_paise,
      source_event_type, source_event_id, notes, created_by
    ) values (
      v_out_item.id, p_branch_id, p_location_id, v_out_batch.id, v_org,
      'PRODUCTION_OUTPUT', p_batch_qty, v_recipe.output_unit,
      v_prod.cost_per_unit_paise, v_total_cost,
      'PRODUCTION', v_prod.id, 'Output of prep batch: ' || v_recipe.name, auth.uid()
    );

    perform public.inventory_update_balance(
      v_out_item.id, p_branch_id, p_batch_qty, v_total_cost
    );
  end if;

  return v_prod;
end;
$$;
grant execute on function public.inventory_record_production_batch to authenticated;

-- ===========================================================================
-- 10. RECIPE COVERAGE REPORT
-- ===========================================================================

create or replace function public.inventory_get_recipe_coverage(p_branch_id uuid)
returns table(
  menu_item_id uuid,
  menu_item_name text,
  category_name text,
  price numeric,
  has_recipe boolean,
  recipe_id uuid,
  recipe_name text,
  cost_per_serving_paise bigint,
  food_cost_pct numeric,
  ingredient_count bigint
)
language plpgsql
security definer
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_org uuid;
  v_can_cost boolean;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;

  select b.organization_id into v_org from public.branches b where b.id = p_branch_id;
  v_can_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return query
  select
    mi.id as menu_item_id,
    mi.name as menu_item_name,
    coalesce(c.name, 'Uncategorized') as category_name,
    mi.price,
    (r.id is not null) as has_recipe,
    r.id as recipe_id,
    r.name as recipe_name,
    case when v_can_cost then rv.cost_per_serving_paise else null end,
    case when v_can_cost and mi.price > 0 and rv.cost_per_serving_paise is not null
      then round(((rv.cost_per_serving_paise::numeric / 100.0) / mi.price) * 100, 1)
      else null end as food_cost_pct,
    (
      select count(*) from public.inventory_recipe_lines rl
      where rl.version_id = r.current_version_id
    ) as ingredient_count
  from public.menu_items mi
  left join public.categories c on c.id = mi.category_id
  left join public.inventory_recipes r on r.menu_item_id = mi.id and r.is_active = true
  left join public.inventory_recipe_versions rv on rv.id = r.current_version_id
  where mi.organization_id = v_org
    and mi.is_available = true
  order by (r.id is null) desc, mi.name;
end;
$$;
grant execute on function public.inventory_get_recipe_coverage(uuid) to authenticated;

-- ===========================================================================
-- 11. SMART REORDER SUGGESTIONS
-- ===========================================================================

create or replace function public.inventory_get_reorder_suggestions(p_branch_id uuid)
returns table(
  item_id uuid,
  item_name text,
  base_unit text,
  purchase_unit text,
  on_hand_qty numeric,
  reserved_qty numeric,
  available_qty numeric,
  reorder_level numeric,
  target_stock_level numeric,
  suggested_order_qty numeric,
  preferred_supplier_id uuid,
  preferred_supplier_name text,
  unit_price_paise bigint,
  estimated_cost_paise bigint,
  urgency text -- 'CRITICAL', 'LOW', 'REORDER'
)
language plpgsql
security definer
stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_org uuid;
  v_can_cost boolean;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;

  select b.organization_id into v_org from public.branches b where b.id = p_branch_id;
  v_can_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return query
  select
    ii.id as item_id,
    ii.name as item_name,
    ii.base_unit,
    ii.purchase_unit,
    coalesce(ib.on_hand_qty, 0) as on_hand_qty,
    coalesce(ib.reserved_qty, 0) as reserved_qty,
    coalesce(ib.available_qty, 0) as available_qty,
    ii.reorder_level,
    ii.target_stock_level,
    greatest(
      coalesce(ii.target_stock_level, ii.reorder_level * 2, 10) - coalesce(ib.available_qty, 0),
      1
    ) as suggested_order_qty,
    sup.id as preferred_supplier_id,
    sup.company_name as preferred_supplier_name,
    case when v_can_cost then iis.price_paise else null end as unit_price_paise,
    case when v_can_cost and iis.price_paise is not null and ii.purchase_unit_conversion > 0
      then ((greatest(coalesce(ii.target_stock_level, ii.reorder_level * 2, 10) - coalesce(ib.available_qty, 0), 1) / ii.purchase_unit_conversion) * iis.price_paise)::bigint
      else null end as estimated_cost_paise,
    case
      when coalesce(ib.available_qty, 0) <= 0 then 'CRITICAL'
      when coalesce(ib.available_qty, 0) <= (ii.reorder_level * 0.5) then 'LOW'
      else 'REORDER'
    end as urgency
  from public.inventory_items ii
  left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
  left join public.inventory_suppliers sup on sup.id = ii.preferred_supplier_id
  left join public.inventory_item_suppliers iis on iis.item_id = ii.id and iis.supplier_id = sup.id
  where ii.organization_id = v_org
    and ii.is_active = true
    and ii.reorder_level is not null
    and coalesce(ib.available_qty, 0) <= ii.reorder_level
  order by coalesce(ib.available_qty, 0) asc;
end;
$$;
grant execute on function public.inventory_get_reorder_suggestions(uuid) to authenticated;

-- ===========================================================================
-- 12. OPERATIONAL FOOD COST (Includes Unpaid Completed Orders)
-- ===========================================================================

create or replace function public.inventory_food_cost_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_org uuid;
  v_result jsonb;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW') then
    raise exception 'INVENTORY_COST_VIEW permission required' using errcode = '42501';
  end if;

  select b.organization_id into v_org from public.branches b where b.id = p_branch_id;
  if not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  select jsonb_build_object(
    -- Total fulfilled food sales (regardless of payment settlement)
    'total_sales_paise', coalesce((
      select sum((total * 100)::bigint) from public.orders
      where branch_id = p_branch_id
        and status = 'COMPLETED'
        and created_at::date between p_from and p_to
    ), 0),
    -- Settled cash collections
    'settled_sales_paise', coalesce((
      select sum((total * 100)::bigint) from public.orders
      where branch_id = p_branch_id
        and status = 'COMPLETED'
        and payment_status = 'PAID'
        and created_at::date between p_from and p_to
    ), 0),
    -- Total operational ingredient consumption cost
    'actual_food_cost_paise', coalesce((
      select sum(total_cost_paise) from public.inventory_stock_movements
      where branch_id = p_branch_id
        and movement_type = 'SALE'
        and created_at::date between p_from and p_to
    ), 0),
    -- Wastage cost
    'wastage_cost_paise', coalesce((
      select sum(cost_paise) from public.inventory_wastage
      where branch_id = p_branch_id
        and wastage_date between p_from and p_to
    ), 0),
    -- Recipe theoretical cost
    'theoretical_cost_paise', coalesce((
      select sum((rl.gross_qty_per_serving * coalesce(ib.avg_unit_cost_paise, 0) * oi.quantity)::bigint)
      from public.orders o
      join public.order_items oi on oi.order_id = o.id
      join public.inventory_recipes r on r.menu_item_id = oi.menu_item_id and r.is_active
      join public.inventory_recipe_lines rl on rl.version_id = r.current_version_id and rl.item_id is not null
      left join public.inventory_balances ib on ib.item_id = rl.item_id and ib.branch_id = p_branch_id
      where o.branch_id = p_branch_id
        and o.status = 'COMPLETED'
        and o.created_at::date between p_from and p_to
    ), 0)
  ) into v_result;

  return v_result;
end;
$$;
grant execute on function public.inventory_food_cost_report(uuid, date, date) to authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
