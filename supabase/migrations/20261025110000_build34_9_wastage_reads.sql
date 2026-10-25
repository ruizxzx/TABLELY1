begin;

alter table public.inventory_wastage
  add column if not exists idempotency_key uuid;

create unique index if not exists inventory_wastage_org_idempotency_uidx
  on public.inventory_wastage(organization_id, idempotency_key)
  where idempotency_key is not null;

drop function public.inventory_record_wastage(uuid, uuid, numeric, text, text, uuid, uuid, text, text, date);

create function public.inventory_record_wastage(
  p_idempotency_key uuid,
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
  v_effective_date date := coalesce(p_wastage_date, current_date);
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_idempotency_key is null then raise exception 'Idempotency key is required' using errcode = '22023'; end if;
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
  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then raise exception 'Branch not found' using errcode = 'P0002'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_wastage
  from public.inventory_wastage
  where organization_id = v_org and idempotency_key = p_idempotency_key;
  if found then
    if v_wastage.branch_id <> p_branch_id
       or v_wastage.item_id <> p_item_id
       or v_wastage.qty <> p_qty
       or v_wastage.unit <> p_unit
       or v_wastage.reason <> p_reason
       or v_wastage.batch_id is distinct from p_batch_id
       or v_wastage.location_id is distinct from p_location_id
       or v_wastage.notes is distinct from nullif(trim(coalesce(p_notes, '')), '')
       or v_wastage.photo_path is distinct from p_photo_path
       or v_wastage.wastage_date <> v_effective_date then
      raise exception 'Idempotency key was already used for a different wastage request' using errcode = '22023';
    end if;
    return v_wastage;
  end if;

  if p_qty is null or p_qty <= 0 then raise exception 'Wastage quantity must be positive' using errcode = '22023'; end if;
  if p_reason not in ('EXPIRED', 'SPOILED', 'BURNT', 'SPILLED', 'DAMAGED', 'STAFF_MEAL', 'OTHER') then
    raise exception 'Invalid wastage reason' using errcode = '22023';
  end if;
  select * into v_item from public.inventory_items where id = p_item_id;
  if v_item.id is null or v_item.organization_id <> v_org or not v_item.is_active then
    raise exception 'Item does not belong to this branch organization' using errcode = '42501';
  end if;
  if p_unit is distinct from v_item.base_unit then
    raise exception 'Wastage unit must match the inventory base unit' using errcode = '22023';
  end if;
  if p_batch_id is not null and not exists (
    select 1 from public.inventory_batches b
    where b.id = p_batch_id and b.item_id = p_item_id and b.branch_id = p_branch_id
  ) then
    raise exception 'Batch does not belong to this item and branch' using errcode = '42501';
  end if;
  select available_qty, avg_unit_cost_paise into v_available_qty, v_unit_cost
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
    where l.id = p_location_id and l.branch_id = p_branch_id and l.is_active
  ) then
    raise exception 'Location does not belong to this active branch' using errcode = '42501';
  end if;

  insert into public.inventory_wastage(
    organization_id, branch_id, item_id, batch_id, location_id,
    qty, unit, cost_paise, reason, notes, photo_path,
    wastage_date, created_by, idempotency_key
  ) values (
    v_org, p_branch_id, p_item_id, p_batch_id, p_location_id,
    p_qty, p_unit, (p_qty * coalesce(v_unit_cost, 0))::bigint, p_reason,
    nullif(trim(coalesce(p_notes, '')), ''), p_photo_path,
    v_effective_date, auth.uid(), p_idempotency_key
  ) returning * into v_wastage;

  insert into public.inventory_stock_movements(
    item_id, branch_id, location_id, batch_id, organization_id,
    movement_type, qty, unit, unit_cost_paise, total_cost_paise,
    source_event_type, source_event_id, notes, created_by
  ) values (
    p_item_id, p_branch_id, p_location_id, p_batch_id, v_org,
    'WASTAGE', -p_qty, p_unit, coalesce(v_unit_cost, 0),
    (p_qty * coalesce(v_unit_cost, 0))::bigint,
    'WASTAGE', v_wastage.id, p_reason, auth.uid()
  ) returning id into v_movement_id;

  perform public.inventory_update_balance(p_item_id, p_branch_id, -p_qty, 0);
  update public.inventory_wastage
  set stock_movement_id = v_movement_id
  where id = v_wastage.id;
  v_wastage.stock_movement_id := v_movement_id;

  if p_batch_id is not null then
    update public.inventory_batches
    set current_qty = current_qty - p_qty, updated_at = now()
    where id = p_batch_id;
  end if;
  return v_wastage;
end;
$$;
grant execute on function public.inventory_record_wastage(uuid, uuid, uuid, numeric, text, text, uuid, uuid, text, text, date) to authenticated;
revoke execute on function public.inventory_record_wastage(uuid, uuid, uuid, numeric, text, text, uuid, uuid, text, text, date) from anon, public;

create or replace function public.inventory_list_wastage_items(p_branch_id uuid)
returns table(
  id uuid,
  name text,
  base_unit text,
  available_qty numeric
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_WASTAGE') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  return query
  select ii.id, ii.name, ii.base_unit, coalesce(ib.available_qty, 0)
  from public.inventory_items ii
  left join public.inventory_balances ib
    on ib.item_id = ii.id and ib.branch_id = p_branch_id
  join public.branches b on b.id = p_branch_id
  where ii.organization_id = b.organization_id
    and ii.is_active
  order by ii.name;
end;
$$;
grant execute on function public.inventory_list_wastage_items(uuid) to authenticated;
revoke execute on function public.inventory_list_wastage_items(uuid) from anon, public;

create or replace function public.inventory_list_wastage(
  p_branch_id uuid,
  p_from date default null,
  p_to date default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table(
  id uuid,
  item_id uuid,
  item_name text,
  qty numeric,
  unit text,
  reason text,
  notes text,
  wastage_date date,
  created_at timestamptz,
  cost_paise bigint
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_can_view_cost boolean;
begin
  if p_limit < 1 or p_limit > 200 or p_offset < 0 then
    raise exception 'Invalid pagination' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'Start date must not be after end date' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) or not (
    public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_WASTAGE')
    or public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW')
  ) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return query
  select w.id, w.item_id, ii.name, w.qty, w.unit, w.reason, w.notes,
    w.wastage_date, w.created_at,
    case when v_can_view_cost then w.cost_paise else null end
  from public.inventory_wastage w
  join public.inventory_items ii on ii.id = w.item_id
  where w.branch_id = p_branch_id
    and (p_from is null or w.wastage_date >= p_from)
    and (p_to is null or w.wastage_date <= p_to)
  order by w.wastage_date desc, w.created_at desc
  limit p_limit offset p_offset;
end;
$$;
grant execute on function public.inventory_list_wastage(uuid, date, date, integer, integer) to authenticated;
revoke execute on function public.inventory_list_wastage(uuid, date, date, integer, integer) from anon, public;

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
  v_result jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'A valid report date range is required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW') then
    raise exception 'INVENTORY_COST_VIEW permission required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'period_from', p_from,
    'period_to', p_to,
    'total_ingredient_cost_paise', (
      select coalesce(sum(m.total_cost_paise), 0)
      from public.inventory_stock_movements m
      where m.branch_id = p_branch_id
        and m.movement_type = 'SALE'
        and m.created_at::date between p_from and p_to
    ),
    'net_food_sales_paise', (
      select coalesce(sum(o.total * 100), 0)::bigint
      from public.orders o
      where o.branch_id = p_branch_id
        and o.status = 'COMPLETED'
        and o.payment_status = 'PAID'
        and o.created_at::date between p_from and p_to
    ),
    'total_wastage_cost_paise', (
      select coalesce(sum(w.cost_paise), 0)
      from public.inventory_wastage w
      where w.branch_id = p_branch_id
        and w.wastage_date between p_from and p_to
    ),
    'top_consumed_items', (
      select coalesce(jsonb_agg(x order by x.total_cost_paise desc), '[]'::jsonb)
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

select pg_notify('pgrst', 'reload schema');
commit;
