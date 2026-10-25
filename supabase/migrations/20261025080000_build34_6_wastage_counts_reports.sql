-- TABLELY BUILD 34.6 — Wastage, Stock Counts, Transfers & Reports
-- Wastage recording, physical stock counting with blind-count support,
-- inter-branch transfer workflow, and core inventory reports.
-- Depends on 20261025030000.

begin;

-- ---------------------------------------------------------------------------
-- 1) Record wastage
-- ---------------------------------------------------------------------------
create or replace function public.inventory_record_wastage(
  p_branch_id uuid,
  p_item_id uuid,
  p_qty numeric,
  p_unit text,
  p_reason text,
  p_batch_id uuid default null,
  p_location_id uuid default null,
  p_notes text default null,
  p_photo_path text default null,
  p_wastage_date date default null
)
returns public.inventory_wastage
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wastage public.inventory_wastage;
  v_item public.inventory_items;
  v_org uuid;
  v_movement_id uuid;
  v_unit_cost bigint;
  v_available_qty numeric;
  v_batch_qty numeric;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_WASTAGE') then
    raise exception 'INVENTORY_WASTAGE permission required' using errcode = '42501';
  end if;

  if p_qty <= 0 then raise exception 'Wastage quantity must be positive'; end if;

  select * into v_item from public.inventory_items where id = p_item_id;
  if v_item.id is null then raise exception 'Item not found'; end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then
    raise exception 'Branch not found' using errcode = 'P0002';
  end if;
  if v_item.organization_id <> v_org then
    raise exception 'Item does not belong to this branch organization' using errcode = '42501';
  end if;
  if p_batch_id is not null and not exists (
    select 1 from public.inventory_batches b
    where b.id = p_batch_id and b.item_id = p_item_id and b.branch_id = p_branch_id
  ) then
    raise exception 'Batch does not belong to this item and branch' using errcode = '42501';
  end if;
  select coalesce(available_qty, 0) into v_available_qty
  from public.inventory_balances
  where item_id = p_item_id and branch_id = p_branch_id
  for update;
  if coalesce(v_available_qty, 0) < p_qty then
    raise exception 'Wastage quantity exceeds available stock';
  end if;
  if p_batch_id is not null then
    select current_qty into v_batch_qty
    from public.inventory_batches
    where id = p_batch_id and item_id = p_item_id and branch_id = p_branch_id
    for update;
    if coalesce(v_batch_qty, 0) < p_qty then
      raise exception 'Wastage quantity exceeds batch stock';
    end if;
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.inventory_locations l
    where l.id = p_location_id and l.branch_id = p_branch_id
  ) then
    raise exception 'Location does not belong to this branch' using errcode = '42501';
  end if;

  -- Get current average cost for cost calculation
  select coalesce(avg_unit_cost_paise, 0) into v_unit_cost
  from public.inventory_balances
  where item_id = p_item_id and branch_id = p_branch_id;

  -- Create wastage record
  insert into public.inventory_wastage(
    organization_id, branch_id, item_id, batch_id, location_id,
    qty, unit, cost_paise, reason, notes, photo_path,
    wastage_date, created_by
  ) values (
    v_org, p_branch_id, p_item_id, p_batch_id, p_location_id,
    p_qty, p_unit, (p_qty * v_unit_cost)::bigint, p_reason, p_notes, p_photo_path,
    coalesce(p_wastage_date, current_date), auth.uid()
  ) returning * into v_wastage;

  -- Create stock movement
  insert into public.inventory_stock_movements(
    item_id, branch_id, location_id, batch_id, organization_id,
    movement_type, qty, unit, unit_cost_paise, total_cost_paise,
    source_event_type, source_event_id, notes, created_by
  ) values (
    p_item_id, p_branch_id, p_location_id, p_batch_id, v_org,
    'WASTAGE', -p_qty, p_unit,
    v_unit_cost, (p_qty * v_unit_cost)::bigint,
    'WASTAGE', v_wastage.id, p_reason, auth.uid()
  )
  on conflict (source_event_id, item_id, branch_id, movement_type) do nothing
  returning id into v_movement_id;

  -- Update balance
  if v_movement_id is not null then
    perform public.inventory_update_balance(p_item_id, p_branch_id, -p_qty, 0);
  end if;

  -- Link movement to wastage
  update public.inventory_wastage
  set stock_movement_id = v_movement_id where id = v_wastage.id;

  -- Update batch current_qty if batch tracked
  if p_batch_id is not null then
    update public.inventory_batches
    set current_qty = greatest(0, current_qty - p_qty), updated_at = now()
    where id = p_batch_id;
  end if;

  return v_wastage;
end;
$$;
grant execute on function public.inventory_record_wastage to authenticated;
revoke execute on function public.inventory_record_wastage from anon, public;

-- ---------------------------------------------------------------------------
-- 2) Stock count session management
-- ---------------------------------------------------------------------------
create or replace function public.inventory_create_stock_count(
  p_branch_id uuid,
  p_location_id uuid default null,
  p_is_blind boolean default true,
  p_notes text default null,
  p_count_date date default null
)
returns public.inventory_stock_counts
language plpgsql
security definer
set search_path = public
as $$
declare v_count public.inventory_stock_counts; v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_ADJUST') then
    raise exception 'INVENTORY_ADJUST permission required' using errcode = '42501';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;

  insert into public.inventory_stock_counts(
    organization_id, branch_id, location_id, is_blind, notes, count_date, created_by
  ) values (
    v_org, p_branch_id, p_location_id, coalesce(p_is_blind, true), p_notes,
    coalesce(p_count_date, current_date), auth.uid()
  ) returning * into v_count;

  -- Pre-populate lines with all active items for this branch (expected from balance)
  insert into public.inventory_stock_count_lines(count_id, item_id, branch_id, unit, expected_qty)
  select
    v_count.id, ii.id, p_branch_id, ii.base_unit,
    case when not v_count.is_blind then coalesce(ib.on_hand_qty, 0) else null end
  from public.inventory_items ii
  left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
  where ii.organization_id = v_org and ii.is_active = true
    and (p_location_id is null or exists (
      select 1 from public.inventory_batches bat
      where bat.item_id = ii.id and bat.branch_id = p_branch_id
        and bat.location_id = p_location_id and bat.current_qty > 0
    ))
  on conflict (count_id, item_id) do nothing;

  return v_count;
end;
$$;
grant execute on function public.inventory_create_stock_count to authenticated;
revoke execute on function public.inventory_create_stock_count from anon, public;

-- ---------------------------------------------------------------------------
-- 3) Submit counted quantities for a stock count session
-- ---------------------------------------------------------------------------
create or replace function public.inventory_submit_count_lines(
  p_count_id uuid,
  -- [{item_id, counted_qty, notes}]
  p_lines jsonb
)
returns public.inventory_stock_counts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count public.inventory_stock_counts;
  v_line jsonb;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  select * into v_count from public.inventory_stock_counts where id = p_count_id;
  if v_count.id is null then raise exception 'Stock count not found'; end if;
  if not public.organization_has_feature(v_count.organization_id, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  if not public.current_user_has_permission_for_branch(v_count.branch_id, 'INVENTORY_ADJUST') then
    raise exception 'INVENTORY_ADJUST permission required' using errcode = '42501';
  end if;

  if v_count.status not in ('OPEN','IN_PROGRESS') then
    raise exception 'Cannot submit lines for a count in status: %', v_count.status;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    -- Set expected_qty now (showing expected after submission for review)
    update public.inventory_stock_count_lines
    set counted_qty = (v_line->>'counted_qty')::numeric,
        expected_qty = coalesce(
          (select on_hand_qty from public.inventory_balances
           where item_id = (v_line->>'item_id')::uuid and branch_id = v_count.branch_id),
          0
        ),
        notes = v_line->>'notes'
    where count_id = p_count_id
      and item_id = (v_line->>'item_id')::uuid;
  end loop;

  -- Advance status
  update public.inventory_stock_counts
  set status = 'PENDING_APPROVAL', updated_at = now()
  where id = p_count_id returning * into v_count;

  return v_count;
end;
$$;
grant execute on function public.inventory_submit_count_lines to authenticated;
revoke execute on function public.inventory_submit_count_lines from anon, public;

-- ---------------------------------------------------------------------------
-- 4) Approve stock count — creates ADJUSTMENT movements for variances
-- ---------------------------------------------------------------------------
create or replace function public.inventory_approve_stock_count(p_count_id uuid)
returns public.inventory_stock_counts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count public.inventory_stock_counts;
  v_line public.inventory_stock_count_lines;
  v_item public.inventory_items;
  v_unit_cost bigint;
  v_movement_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  select * into v_count from public.inventory_stock_counts where id = p_count_id for update;
  if v_count.id is null then raise exception 'Stock count not found'; end if;
  if not public.organization_has_feature(v_count.organization_id, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  if not public.current_user_has_permission_for_branch(v_count.branch_id, 'INVENTORY_ADJUST') then
    raise exception 'INVENTORY_ADJUST permission required' using errcode = '42501';
  end if;

  if v_count.status <> 'PENDING_APPROVAL' then
    raise exception 'Stock count must be in PENDING_APPROVAL status to approve';
  end if;

  -- Create adjustment movements for each line with a variance
  for v_line in
    select * from public.inventory_stock_count_lines
    where count_id = p_count_id
      and counted_qty is not null
      and expected_qty is not null
      and counted_qty <> expected_qty
  loop
    select * into v_item from public.inventory_items where id = v_line.item_id;

    select coalesce(avg_unit_cost_paise, 0) into v_unit_cost
    from public.inventory_balances
    where item_id = v_line.item_id and branch_id = v_count.branch_id;

    -- Variance = counted - expected (positive = found more, negative = found less)
    insert into public.inventory_stock_movements(
      item_id, branch_id, organization_id,
      movement_type, qty, unit, unit_cost_paise, total_cost_paise,
      source_event_type, source_event_id,
      notes, created_by
    ) values (
      v_line.item_id, v_count.branch_id, v_count.organization_id,
      'ADJUSTMENT', v_line.variance_qty, v_line.unit,
      v_unit_cost, (abs(v_line.variance_qty) * v_unit_cost)::bigint,
      'STOCK_COUNT', p_count_id,
      'Stock count adjustment: counted ' || v_line.counted_qty || ', expected ' || v_line.expected_qty,
      auth.uid()
    ) returning id into v_movement_id;

    -- Update balance
    perform public.inventory_update_balance(
      v_line.item_id, v_count.branch_id, v_line.variance_qty, 0
    );

    -- Link movement to count line
    update public.inventory_stock_count_lines
    set stock_movement_id = v_movement_id
    where id = v_line.id;
  end loop;

  update public.inventory_stock_counts
  set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where id = p_count_id returning * into v_count;

  return v_count;
end;
$$;
grant execute on function public.inventory_approve_stock_count(uuid) to authenticated;
revoke execute on function public.inventory_approve_stock_count(uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- 5) Stock movement history for an item
-- ---------------------------------------------------------------------------
create or replace function public.inventory_get_item_movements(
  p_item_id uuid,
  p_branch_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(
  id uuid, movement_type text, qty numeric, unit text,
  unit_cost_paise bigint, total_cost_paise bigint,
  source_event_type text, source_event_id uuid,
  notes text, created_at timestamptz, created_by uuid
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_can_view_cost boolean;
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

  return query
  select m.id, m.movement_type::text, m.qty, m.unit,
    case when v_can_view_cost then m.unit_cost_paise else null end,
    case when v_can_view_cost then m.total_cost_paise else null end,
    m.source_event_type, m.source_event_id, m.notes,
    m.created_at, m.created_by
  from public.inventory_stock_movements m
  where m.item_id = p_item_id
    and m.branch_id = p_branch_id
    and (p_from is null or m.created_at >= p_from)
    and (p_to is null or m.created_at <= p_to)
  order by m.created_at desc
  limit p_limit offset p_offset;
end;
$$;
grant execute on function public.inventory_get_item_movements to authenticated;
revoke execute on function public.inventory_get_item_movements from anon, public;

-- ---------------------------------------------------------------------------
-- 6) Food cost report (actual recipe cost vs net food sales per period)
-- ---------------------------------------------------------------------------
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
declare v_result jsonb;
begin
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW') then
    raise exception 'INVENTORY_COST_VIEW permission required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'period_from', p_from,
    'period_to', p_to,
    -- Total ingredient cost of all SALE movements in period (in paise)
    'total_ingredient_cost_paise', (
      select coalesce(sum(total_cost_paise), 0)
      from public.inventory_stock_movements
      where branch_id = p_branch_id
        and movement_type = 'SALE'
        and created_at::date between p_from and p_to
    ),
    -- Net food sales in paise (from completed, paid orders in period)
    'net_food_sales_paise', (
      select coalesce(sum(total * 100), 0)::bigint
      from public.orders
      where branch_id = p_branch_id
        and status = 'COMPLETED'
        and created_at::date between p_from and p_to
    ),
    -- Wastage cost in period
    'total_wastage_cost_paise', (
      select coalesce(sum(cost_paise), 0)
      from public.inventory_wastage
      where branch_id = p_branch_id
        and wastage_date between p_from and p_to
    ),
    -- Top consumed items by cost
    'top_consumed_items', (
      select coalesce(jsonb_agg(x order by x.total_cost_paise desc), '[]')
      from (
        select ii.id, ii.name, ii.base_unit,
          sum(abs(m.qty)) as total_qty,
          sum(m.total_cost_paise) as total_cost_paise
        from public.inventory_stock_movements m
        join public.inventory_items ii on ii.id = m.item_id
        where m.branch_id = p_branch_id
          and m.movement_type = 'SALE'
          and m.created_at::date between p_from and p_to
        group by ii.id, ii.name, ii.base_unit
        order by sum(m.total_cost_paise) desc
        limit 10
      ) x
    )
  ) into v_result;

  return v_result;
end;
$$;
grant execute on function public.inventory_food_cost_report(uuid, date, date) to authenticated;
revoke execute on function public.inventory_food_cost_report(uuid, date, date) from anon, public;

-- ---------------------------------------------------------------------------
-- 7) Theoretical vs actual consumption variance report
-- ---------------------------------------------------------------------------
create or replace function public.inventory_variance_report(
  p_branch_id uuid,
  p_from date,
  p_to date
)
returns table(
  item_id uuid,
  item_name text,
  base_unit text,
  theoretical_qty numeric,  -- based on orders completed × recipe quantities
  actual_qty numeric,        -- from SALE stock movements
  variance_qty numeric,      -- actual - theoretical
  variance_pct numeric
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
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW') then
    raise exception 'INVENTORY_COST_VIEW permission required' using errcode = '42501';
  end if;

  return query
  with theoretical as (
    select
      rl.item_id,
      sum(rl.gross_qty_per_serving * oi.quantity) as theoretical_qty
    from public.orders o
    join public.order_items oi on oi.order_id = o.id
    join public.inventory_recipes r on r.menu_item_id = oi.menu_item_id and r.is_active
    join public.inventory_recipe_lines rl on rl.version_id = r.current_version_id and rl.item_id is not null
    where o.branch_id = p_branch_id
      and o.status = 'COMPLETED'
      and o.created_at::date between p_from and p_to
    group by rl.item_id
  ),
  actual as (
    select
      item_id,
      sum(abs(qty)) as actual_qty
    from public.inventory_stock_movements
    where branch_id = p_branch_id
      and movement_type = 'SALE'
      and created_at::date between p_from and p_to
    group by item_id
  )
  select
    ii.id,
    ii.name,
    ii.base_unit,
    coalesce(t.theoretical_qty, 0) as theoretical_qty,
    coalesce(a.actual_qty, 0) as actual_qty,
    coalesce(a.actual_qty, 0) - coalesce(t.theoretical_qty, 0) as variance_qty,
    case when coalesce(t.theoretical_qty, 0) > 0
      then round(
        ((coalesce(a.actual_qty, 0) - coalesce(t.theoretical_qty, 0))
        / t.theoretical_qty) * 100, 2)
      else null
    end as variance_pct
  from (
    select item_id from theoretical
    union
    select item_id from actual
  ) combined
  join public.inventory_items ii on ii.id = combined.item_id
  left join theoretical t on t.item_id = combined.item_id
  left join actual a on a.item_id = combined.item_id
  where ii.organization_id = v_org
  order by abs(coalesce(a.actual_qty, 0) - coalesce(t.theoretical_qty, 0)) desc;
end;
$$;
grant execute on function public.inventory_variance_report(uuid, date, date) to authenticated;
revoke execute on function public.inventory_variance_report(uuid, date, date) from anon, public;

-- ---------------------------------------------------------------------------
-- 8) Generate stock alerts
-- ---------------------------------------------------------------------------
create or replace function public.inventory_generate_alerts(p_branch_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.branch_inventory_settings;
  v_org uuid;
  v_count integer := 0;
begin
  select * into v_settings from public.branch_inventory_settings where branch_id = p_branch_id;
  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null or not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if auth.uid() is null then
    if coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'Not authenticated' using errcode = '42501';
    end if;
  elsif not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  -- Low/critical/out-of-stock alerts
  insert into public.inventory_alerts(
    organization_id, branch_id, item_id, alert_type, severity, message, alert_value, threshold_value, alert_date
  )
  select
    v_org, p_branch_id, ii.id,
    case
      when coalesce(ib.available_qty, 0) <= 0 then 'OUT_OF_STOCK'
      when coalesce(ib.available_qty, 0) <= (ii.reorder_level * 0.5) then 'CRITICAL_STOCK'
      else 'LOW_STOCK'
    end::public.inventory_alert_type,
    case
      when coalesce(ib.available_qty, 0) <= 0 then 'CRITICAL'
      when coalesce(ib.available_qty, 0) <= (ii.reorder_level * 0.5) then 'CRITICAL'
      else 'WARNING'
    end,
    case
      when coalesce(ib.available_qty, 0) <= 0 then ii.name || ' is out of stock'
      else ii.name || ' is below reorder level (' || coalesce(ib.available_qty, 0)::text || ' ' || ii.base_unit || ' available, ' || ii.reorder_level::text || ' minimum)'
    end,
    coalesce(ib.available_qty, 0),
    ii.reorder_level,
    current_date
  from public.inventory_items ii
  left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
  where ii.organization_id = v_org and ii.is_active = true
    and ii.reorder_level is not null
    and coalesce(ib.available_qty, 0) <= ii.reorder_level
  on conflict (branch_id, item_id, alert_type, alert_date) do nothing;

  get diagnostics v_count = row_count;

  -- Expiry alerts (using configured alert windows)
  insert into public.inventory_alerts(
    organization_id, branch_id, item_id, batch_id, alert_type, severity, message, alert_value, alert_date
  )
  select
    v_org, p_branch_id, bat.item_id, bat.id,
    'EXPIRING_SOON'::public.inventory_alert_type,
    case when bat.expires_at <= current_date + coalesce(v_settings.expiry_alert_days_3, 1) then 'CRITICAL'
         when bat.expires_at <= current_date + coalesce(v_settings.expiry_alert_days_2, 3) then 'WARNING'
         else 'INFO' end,
    ii.name || ' batch expires ' || to_char(bat.expires_at, 'DD Mon YYYY')
      || ' (' || bat.current_qty::text || ' ' || ii.base_unit || ' remaining)',
    (bat.expires_at - current_date),
    current_date
  from public.inventory_batches bat
  join public.inventory_items ii on ii.id = bat.item_id
  where bat.branch_id = p_branch_id
    and bat.is_active = true and bat.current_qty > 0
    and bat.expires_at is not null
    and bat.expires_at >= current_date
    and bat.expires_at <= current_date + coalesce(v_settings.expiry_alert_days_1, 7)
  on conflict (branch_id, item_id, alert_type, alert_date) do nothing;

  return v_count;
end;
$$;
grant execute on function public.inventory_generate_alerts(uuid) to authenticated, service_role;
revoke execute on function public.inventory_generate_alerts(uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- 9) Dismiss an alert
-- ---------------------------------------------------------------------------
create or replace function public.inventory_dismiss_alert(p_alert_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_alert public.inventory_alerts;
begin
  select * into v_alert from public.inventory_alerts where id = p_alert_id;
  if v_alert.id is null then raise exception 'Alert not found'; end if;
  if auth.uid() is null
     or not public.organization_has_feature(v_alert.organization_id, 'INVENTORY') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(v_alert.branch_id, 'INVENTORY_VIEW') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  update public.inventory_alerts
  set is_dismissed = true, dismissed_by = auth.uid(), dismissed_at = now()
  where id = p_alert_id;
end;
$$;
grant execute on function public.inventory_dismiss_alert(uuid) to authenticated;
revoke execute on function public.inventory_dismiss_alert(uuid) from anon, public;

select pg_notify('pgrst', 'reload schema');
commit;
