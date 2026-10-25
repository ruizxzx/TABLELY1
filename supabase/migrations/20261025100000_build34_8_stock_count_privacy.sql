-- Protect blind stock counts and provide scoped read operations for the UI.
-- Depends on the Build 34 foundation and wastage/count RPC migrations.

begin;

alter table public.inventory_stock_counts
  add column if not exists submitted_by uuid references auth.users(id);

revoke select on public.inventory_stock_count_lines from authenticated;
revoke select on public.inventory_goods_receipts from authenticated;
revoke select on public.inventory_goods_receipt_lines from authenticated;

create or replace function public.inventory_list_receivable_purchase_orders(p_branch_id uuid)
returns table(
  id uuid,
  po_number text,
  status text,
  supplier_id uuid,
  supplier_name text
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
  ) or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_RECEIVE') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  return query
  select po.id, po.po_number, po.status::text, po.supplier_id, s.company_name
  from public.inventory_purchase_orders po
  join public.inventory_suppliers s on s.id = po.supplier_id
  where po.branch_id = p_branch_id
    and po.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')
  order by po.created_at desc;
end;
$$;
grant execute on function public.inventory_list_receivable_purchase_orders(uuid) to authenticated;
revoke execute on function public.inventory_list_receivable_purchase_orders(uuid) from anon, public;

create or replace function public.inventory_list_receivable_po_lines(p_po_id uuid)
returns table(
  id uuid,
  item_id uuid,
  ordered_qty numeric,
  received_qty numeric,
  purchase_unit text,
  agreed_unit_price_paise bigint
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_branch_id uuid;
  v_can_view_cost boolean;
begin
  select po.branch_id into v_branch_id
  from public.inventory_purchase_orders po
  where po.id = p_po_id
    and po.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED');
  if v_branch_id is null
     or not public.organization_has_feature(
       (select b.organization_id from public.branches b where b.id = v_branch_id),
       'INVENTORY'
     )
     or not public.current_user_has_permission_for_branch(v_branch_id, 'INVENTORY_RECEIVE') then
    raise exception 'Purchase order is not available for receiving' using errcode = '42501';
  end if;
  v_can_view_cost := public.current_user_has_permission_for_branch(v_branch_id, 'INVENTORY_COST_VIEW');

  return query
  select pol.id, pol.item_id, pol.ordered_qty, pol.received_qty, pol.purchase_unit,
    case when v_can_view_cost then pol.agreed_unit_price_paise else null end
  from public.inventory_purchase_order_lines pol
  where pol.purchase_order_id = p_po_id
    and pol.received_qty < pol.ordered_qty
  order by pol.sort_order;
end;
$$;
grant execute on function public.inventory_list_receivable_po_lines(uuid) to authenticated;
revoke execute on function public.inventory_list_receivable_po_lines(uuid) from anon, public;

create or replace function public.inventory_list_pending_grns(p_branch_id uuid)
returns table(
  id uuid,
  grn_number text,
  status text,
  received_date date,
  total_accepted_value_paise bigint,
  supplier_invoice_number text,
  supplier_id uuid
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
  ) or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_RECEIVE') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return query
  select grn.id, grn.grn_number, grn.status::text, grn.received_date,
    case when v_can_view_cost then grn.total_accepted_value_paise else null end,
    grn.supplier_invoice_number, grn.supplier_id
  from public.inventory_goods_receipts grn
  where grn.branch_id = p_branch_id
    and grn.status in ('DRAFT', 'SUBMITTED')
  order by grn.created_at desc
  limit 100;
end;
$$;
grant execute on function public.inventory_list_pending_grns(uuid) to authenticated;
revoke execute on function public.inventory_list_pending_grns(uuid) from anon, public;

create or replace function public.inventory_list_receiving_locations(p_branch_id uuid)
returns table(id uuid, name text)
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
  ) or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_RECEIVE') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  return query
  select l.id, l.name from public.inventory_locations l
  where l.branch_id = p_branch_id and l.is_active
  order by l.sort_order, l.name;
end;
$$;
grant execute on function public.inventory_list_receiving_locations(uuid) to authenticated;
revoke execute on function public.inventory_list_receiving_locations(uuid) from anon, public;

create or replace function public.inventory_list_stock_counts(
  p_branch_id uuid,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table(
  id uuid,
  status text,
  is_blind boolean,
  count_date date,
  notes text,
  created_at timestamptz,
  line_count bigint
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
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;

  return query
  select c.id, c.status::text, c.is_blind, c.count_date, c.notes, c.created_at,
    count(cl.id)
  from public.inventory_stock_counts c
  left join public.inventory_stock_count_lines cl on cl.count_id = c.id
  where c.branch_id = p_branch_id
  group by c.id
  order by c.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;
grant execute on function public.inventory_list_stock_counts(uuid, integer, integer) to authenticated;
revoke execute on function public.inventory_list_stock_counts(uuid, integer, integer) from anon, public;

create or replace function public.inventory_get_stock_count(p_count_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_count public.inventory_stock_counts;
  v_can_see_expected boolean;
begin
  select * into v_count
  from public.inventory_stock_counts
  where id = p_count_id;
  if v_count.id is null then
    raise exception 'Stock count not found' using errcode = 'P0002';
  end if;
  if not public.organization_has_feature(v_count.organization_id, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(v_count.branch_id, 'INVENTORY_VIEW') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  v_can_see_expected := not v_count.is_blind
    or v_count.status = 'APPROVED'
    or public.is_org_owner(v_count.organization_id)
    or (
      v_count.submitted_by is not null
      and v_count.submitted_by <> auth.uid()
      and public.current_user_has_permission_for_branch(v_count.branch_id, 'INVENTORY_ADJUST')
    );

  return jsonb_build_object(
    'count', jsonb_build_object(
      'id', v_count.id,
      'status', v_count.status,
      'is_blind', v_count.is_blind,
      'count_date', v_count.count_date,
      'notes', v_count.notes,
      'branch_id', v_count.branch_id
    ),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'item_id', cl.item_id,
        'item_name', ii.name,
        'unit', cl.unit,
        'counted_qty', cl.counted_qty,
        'expected_qty', case when v_can_see_expected then cl.expected_qty else null end,
        'variance_qty', case when v_can_see_expected then cl.variance_qty else null end,
        'notes', cl.notes
      ) order by ii.name), '[]'::jsonb)
      from public.inventory_stock_count_lines cl
      join public.inventory_items ii on ii.id = cl.item_id
      where cl.count_id = p_count_id
    )
  );
end;
$$;
grant execute on function public.inventory_get_stock_count(uuid) to authenticated;
revoke execute on function public.inventory_get_stock_count(uuid) from anon, public;

create or replace function public.inventory_submit_count_lines(
  p_count_id uuid,
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
  v_item_id uuid;
  v_counted_qty numeric;
  v_expected_count bigint;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(p_lines), '') <> 'array' then
    raise exception 'Count lines must be a JSON array';
  end if;

  select * into v_count
  from public.inventory_stock_counts
  where id = p_count_id
  for update;
  if v_count.id is null then
    raise exception 'Stock count not found' using errcode = 'P0002';
  end if;
  if not public.organization_has_feature(v_count.organization_id, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(v_count.branch_id, 'INVENTORY_ADJUST') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if v_count.status not in ('OPEN', 'IN_PROGRESS') then
    raise exception 'Cannot submit lines for a count in status: %', v_count.status;
  end if;

  select count(*) into v_expected_count
  from public.inventory_stock_count_lines
  where count_id = p_count_id;
  if jsonb_array_length(p_lines) <> v_expected_count
     or (select count(distinct value->>'item_id') from jsonb_array_elements(p_lines)) <> v_expected_count then
    raise exception 'Submit exactly one count for each listed inventory item';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_item_id := nullif(v_line->>'item_id', '')::uuid;
    v_counted_qty := nullif(v_line->>'counted_qty', '')::numeric;
    if v_item_id is null or v_counted_qty is null or v_counted_qty < 0
       or not exists (
         select 1 from public.inventory_stock_count_lines cl
         where cl.count_id = p_count_id and cl.item_id = v_item_id
       ) then
      raise exception 'Count quantity must be non-negative and reference an item in this count';
    end if;

    perform 1 from public.inventory_balances ib
    where ib.item_id = v_item_id and ib.branch_id = v_count.branch_id
    for update;

    update public.inventory_stock_count_lines cl
    set counted_qty = v_counted_qty,
        expected_qty = coalesce((
          select ib.on_hand_qty
          from public.inventory_balances ib
          where ib.item_id = v_item_id and ib.branch_id = v_count.branch_id
        ), 0),
        notes = nullif(trim(v_line->>'notes'), '')
    where cl.count_id = p_count_id and cl.item_id = v_item_id;
  end loop;

  update public.inventory_stock_counts
  set status = 'PENDING_APPROVAL', submitted_by = auth.uid(), updated_at = now()
  where id = p_count_id
  returning * into v_count;
  return v_count;
end;
$$;
grant execute on function public.inventory_submit_count_lines(uuid, jsonb) to authenticated;
revoke execute on function public.inventory_submit_count_lines(uuid, jsonb) from anon, public;

create or replace function public.inventory_approve_stock_count(p_count_id uuid)
returns public.inventory_stock_counts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count public.inventory_stock_counts;
  v_line public.inventory_stock_count_lines;
  v_unit_cost bigint;
  v_movement_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_count
  from public.inventory_stock_counts
  where id = p_count_id
  for update;
  if v_count.id is null then
    raise exception 'Stock count not found' using errcode = 'P0002';
  end if;
  if not public.organization_has_feature(v_count.organization_id, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(v_count.branch_id, 'INVENTORY_ADJUST') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if v_count.status <> 'PENDING_APPROVAL' then
    raise exception 'Stock count must be in PENDING_APPROVAL status to approve';
  end if;
  if v_count.submitted_by = auth.uid()
     and not public.is_org_owner(v_count.organization_id) then
    raise exception 'A different authorized staff member must approve this stock count'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from public.inventory_stock_count_lines cl
    where cl.count_id = p_count_id
      and (cl.counted_qty is null or cl.expected_qty is null)
  ) then
    raise exception 'Every stock count line must have expected and counted quantities';
  end if;

  for v_line in
    select * from public.inventory_stock_count_lines
    where count_id = p_count_id
      and counted_qty <> expected_qty
    order by item_id
  loop
    perform 1 from public.inventory_balances ib
    where ib.item_id = v_line.item_id and ib.branch_id = v_count.branch_id
    for update;
    select coalesce(avg_unit_cost_paise, 0) into v_unit_cost
    from public.inventory_balances
    where item_id = v_line.item_id and branch_id = v_count.branch_id;

    insert into public.inventory_stock_movements(
      item_id, branch_id, organization_id,
      movement_type, qty, unit, unit_cost_paise, total_cost_paise,
      source_event_type, source_event_id, notes, created_by
    ) values (
      v_line.item_id, v_count.branch_id, v_count.organization_id,
      'ADJUSTMENT', v_line.variance_qty, v_line.unit,
      v_unit_cost, (abs(v_line.variance_qty) * v_unit_cost)::bigint,
      'STOCK_COUNT', p_count_id,
      'Stock count adjustment: counted ' || v_line.counted_qty || ', expected ' || v_line.expected_qty,
      auth.uid()
    )
    on conflict (source_event_id, item_id, branch_id, movement_type) do nothing
    returning id into v_movement_id;

    if v_movement_id is not null then
      perform public.inventory_update_balance(v_line.item_id, v_count.branch_id, v_line.variance_qty, 0);
      update public.inventory_stock_count_lines
      set stock_movement_id = v_movement_id
      where id = v_line.id;
    end if;
  end loop;

  update public.inventory_stock_counts
  set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where id = p_count_id
  returning * into v_count;
  return v_count;
end;
$$;
grant execute on function public.inventory_approve_stock_count(uuid) to authenticated;
revoke execute on function public.inventory_approve_stock_count(uuid) from anon, public;

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
declare
  v_count public.inventory_stock_counts;
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  select b.organization_id into v_org
  from public.branches b
  where b.id = p_branch_id
    and public.organization_has_feature(b.organization_id, 'INVENTORY');
  if v_org is null then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_ADJUST') then
    raise exception 'INVENTORY_ADJUST permission required' using errcode = '42501';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.inventory_locations l
    where l.id = p_location_id and l.branch_id = p_branch_id and l.is_active
  ) then
    raise exception 'Location does not belong to this branch or is inactive' using errcode = '42501';
  end if;

  insert into public.inventory_stock_counts(
    organization_id, branch_id, location_id, is_blind, notes, count_date, created_by
  ) values (
    v_org, p_branch_id, p_location_id, coalesce(p_is_blind, true), p_notes,
    coalesce(p_count_date, current_date), auth.uid()
  ) returning * into v_count;

  insert into public.inventory_stock_count_lines(count_id, item_id, branch_id, unit, expected_qty)
  select v_count.id, ii.id, p_branch_id, ii.base_unit,
    case when not v_count.is_blind then coalesce(ib.on_hand_qty, 0) else null end
  from public.inventory_items ii
  left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
  where ii.organization_id = v_org and ii.is_active
    and (p_location_id is null or exists (
      select 1 from public.inventory_batches bat
      where bat.item_id = ii.id and bat.branch_id = p_branch_id
        and bat.location_id = p_location_id and bat.current_qty > 0
    ))
  on conflict (count_id, item_id) do nothing;

  return v_count;
end;
$$;
grant execute on function public.inventory_create_stock_count(uuid, uuid, boolean, text, date) to authenticated;
revoke execute on function public.inventory_create_stock_count(uuid, uuid, boolean, text, date) from anon, public;

select pg_notify('pgrst', 'reload schema');
commit;
