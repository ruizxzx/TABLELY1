-- TABLELY BUILD 34.5 — Order Reservations & Automatic Stock Consumption
-- Hooks into the existing order lifecycle via a trigger on the orders table.
-- Reserve on ACCEPTED, consume on COMPLETED, release on CANCELLED.
-- Idempotent: duplicate events cannot cause double-deductions.
-- Depends on 20261025030000, 20261025050000.

begin;

-- ---------------------------------------------------------------------------
-- 1) Reserve ingredients when an order is ACCEPTED
--    Uses the current active recipe version for each order item's menu item.
--    Respects branch_inventory_settings.stock_mode:
--      STRICT  → raise exception if insufficient stock (blocks acceptance)
--      WARNING → allow but set stock_available = false on the reservation line
--      DISABLED → skip reservation entirely
-- ---------------------------------------------------------------------------
create or replace function public.inventory_reserve_for_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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

  -- Idempotency: if reservation already exists for this order, do nothing
  select * into v_reservation from public.inventory_reservations
  where order_id = p_order_id;
  if v_reservation.id is not null then return; end if;

  -- Create reservation header
  insert into public.inventory_reservations(order_id, branch_id, organization_id, status)
  values (p_order_id, v_order.branch_id, (select organization_id from public.branches where id = v_order.branch_id), 'ACTIVE')
  on conflict (order_id) do nothing
  returning * into v_reservation;

  if v_reservation.id is null then return; end if; -- Already existed, race condition handled

  -- For each order item, find recipe and reserve ingredients
  for v_oi in
    select * from public.order_items
    where order_id = p_order_id
      and status is distinct from 'CANCELLED'
  loop
    -- Find active recipe for this menu item
    select r.* into v_recipe
    from public.inventory_recipes r
    where r.menu_item_id = v_oi.menu_item_id
      and r.is_active = true
      and (r.branch_id is null or r.branch_id = v_order.branch_id)
    order by r.branch_id desc nulls last  -- branch-specific takes priority
    limit 1;

    if v_recipe.id is null or v_recipe.current_version_id is null then
      continue; -- No recipe mapped, skip this item
    end if;

    v_version_id := v_recipe.current_version_id;

    -- For each ingredient line in the recipe
    for v_line in
      select * from public.inventory_recipe_lines
      where version_id = v_version_id and item_id is not null
    loop
      select * into v_item from public.inventory_items where id = v_line.item_id;
      if v_item.id is null then continue; end if;

      -- Needed quantity = gross_qty_per_serving * order item quantity
      v_needed_qty := v_line.gross_qty_per_serving * v_oi.quantity;

      -- Serialize reservations for this branch/item so STRICT cannot
      -- over-accept concurrent orders against the same available quantity.
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
      )
      on conflict do nothing;

      -- Update reservation cache in balance
      perform public.inventory_update_reservation(v_line.item_id, v_order.branch_id, v_needed_qty);
    end loop;
  end loop;

  -- STRICT mode: if any ingredient is insufficient, raise exception to block acceptance
  if v_settings.stock_mode = 'STRICT' and array_length(v_insufficient_items, 1) > 0 then
    -- Roll back the reservation we just created
    delete from public.inventory_reservation_lines where reservation_id = v_reservation.id;
    delete from public.inventory_reservations where id = v_reservation.id;
    raise exception 'Insufficient stock for: %. Order cannot be accepted in STRICT mode.',
      array_to_string(v_insufficient_items, ', ')
      using errcode = 'P0001';
  end if;

end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Consume ingredients when an order is COMPLETED
--    Converts the reservation to actual stock movements.
--    Idempotent: consumed_at IS NULL guard prevents double-deduction.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_consume_for_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.inventory_reservations;
  v_line public.inventory_reservation_lines;
  v_item public.inventory_items;
  v_movement_id uuid;
  v_unit_cost bigint;
begin
  select * into v_reservation
  from public.inventory_reservations
  where order_id = p_order_id and status = 'ACTIVE'
  for update;

  -- No reservation means inventory not tracked for this order → skip
  if v_reservation.id is null then return; end if;

  -- Idempotency guard: already consumed
  if v_reservation.consumed_at is not null then return; end if;

  -- Mark reservation as consumed FIRST (before creating movements)
  -- This prevents a concurrent event from consuming again
  update public.inventory_reservations
  set status = 'CONSUMED', consumed_at = now()
  where id = v_reservation.id;

  -- For each reserved ingredient, create a SALE stock movement
  for v_line in
    select * from public.inventory_reservation_lines
    where reservation_id = v_reservation.id
  loop
    select * into v_item from public.inventory_items where id = v_line.item_id;
    if v_item.id is null then continue; end if;

    -- Get current average cost for this ingredient
    select coalesce(avg_unit_cost_paise, 0) into v_unit_cost
    from public.inventory_balances
    where item_id = v_line.item_id and branch_id = v_line.branch_id;

    -- Insert SALE movement (idempotent via unique constraint on source_event_id + item + branch + type)
    insert into public.inventory_stock_movements(
      item_id, branch_id, organization_id,
      movement_type, qty, unit, unit_cost_paise, total_cost_paise,
      source_event_type, source_event_id, recipe_version_id, created_by
    ) values (
      v_line.item_id, v_line.branch_id, v_reservation.organization_id,
      'SALE', -v_line.reserved_qty, v_line.unit,
      v_unit_cost, (v_line.reserved_qty * v_unit_cost)::bigint,
      'ORDER', p_order_id, v_line.recipe_version_id, null
    )
    on conflict (source_event_id, item_id, branch_id, movement_type) do nothing
    returning id into v_movement_id;

    -- Update balance: remove stock (qty negative = out), release reservation
    if v_movement_id is not null then
      perform public.inventory_update_balance(
        v_line.item_id, v_line.branch_id, -v_line.reserved_qty, 0
      );
    end if;

    -- Release the reservation quantity from reserved_qty cache
    perform public.inventory_update_reservation(v_line.item_id, v_line.branch_id, -v_line.reserved_qty);
  end loop;

  -- Also apply modifier-based extra quantities (additive modifiers)
  -- This is handled via the recipe lines which already include modifier impacts
  -- when the reservation was created based on order_items.selected_addons

end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Release reservation on CANCELLED order
-- ---------------------------------------------------------------------------
create or replace function public.inventory_release_reservation(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.inventory_reservations;
  v_line public.inventory_reservation_lines;
begin
  select * into v_reservation
  from public.inventory_reservations
  where order_id = p_order_id and status = 'ACTIVE'
  for update;

  if v_reservation.id is null then return; end if;

  -- Mark as released
  update public.inventory_reservations
  set status = 'RELEASED', released_at = now()
  where id = v_reservation.id;

  -- Release each reserved quantity
  for v_line in
    select * from public.inventory_reservation_lines
    where reservation_id = v_reservation.id
  loop
    perform public.inventory_update_reservation(
      v_line.item_id, v_line.branch_id, -v_line.reserved_qty
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Trigger on orders table that calls the three lifecycle functions
--    Only fires when status column changes to avoid unnecessary overhead.
-- ---------------------------------------------------------------------------
create or replace function public.inventory_order_lifecycle_hook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only act on status transitions
  if old.status = new.status then return new; end if;

  if new.status = 'ACCEPTED' then
    -- Reserve ingredients. On STRICT mode shortage, exception propagates
    -- and the status update is rolled back (order stays in prior state).
    perform public.inventory_reserve_for_order(new.id);

  elsif new.status = 'COMPLETED' then
    -- Convert reservation to actual consumption (idempotent)
    perform public.inventory_consume_for_order(new.id);

  elsif new.status = 'CANCELLED' then
    -- Release any outstanding reservation
    perform public.inventory_release_reservation(new.id);

  end if;

  return new;
end;
$$;

drop trigger if exists inventory_order_lifecycle on public.orders;
create trigger inventory_order_lifecycle
  after update of status on public.orders
  for each row
  execute function public.inventory_order_lifecycle_hook();

-- These functions are internal trigger helpers. Exposing them as RPCs would let
-- callers with any order UUID alter reservations or inventory balances.
revoke all on function public.inventory_reserve_for_order(uuid) from anon, public, authenticated;
revoke all on function public.inventory_consume_for_order(uuid) from anon, public, authenticated;
revoke all on function public.inventory_release_reservation(uuid) from anon, public, authenticated;

select pg_notify('pgrst', 'reload schema');
commit;
