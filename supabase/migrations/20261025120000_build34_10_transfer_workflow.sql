begin;

drop policy if exists inventory_transfers_write on public.inventory_transfers;
drop policy if exists inventory_transfer_lines_write on public.inventory_transfer_lines;
drop policy if exists inventory_transfer_lines_select on public.inventory_transfer_lines;
revoke insert, update, delete on public.inventory_transfers from authenticated, anon, public;
revoke all on public.inventory_transfer_lines from authenticated, anon, public;
alter table public.inventory_transfer_lines
  drop constraint if exists inventory_transfer_lines_from_batch_id_fkey;
alter table public.inventory_transfer_lines
  add constraint inventory_transfer_lines_from_batch_id_fkey
  foreign key (from_batch_id) references public.inventory_batches(id) on delete restrict;

drop policy if exists inventory_transfers_select on public.inventory_transfers;
create policy inventory_transfers_select on public.inventory_transfers
  for select to authenticated
  using (
    public.organization_has_feature(organization_id, 'INVENTORY')
    and (
      public.current_user_has_permission_for_branch(from_branch_id, 'INVENTORY_TRANSFER')
      or public.current_user_has_permission_for_branch(to_branch_id, 'INVENTORY_TRANSFER')
    )
  );

create or replace function public.inventory_list_transfer_branches(p_branch_id uuid)
returns table(id uuid, name text)
language plpgsql
security definer
stable
set search_path = public
as $$
declare v_org uuid;
begin
  select b.organization_id into v_org
  from public.branches b
  where b.id = p_branch_id and b.is_active;
  if v_org is null
     or not public.organization_has_feature(v_org, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_TRANSFER') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  return query
  select b.id, b.name
  from public.branches b
  where b.organization_id = v_org
    and b.is_active
    and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_TRANSFER')
  order by b.name;
end;
$$;
grant execute on function public.inventory_list_transfer_branches(uuid) to authenticated;
revoke execute on function public.inventory_list_transfer_branches(uuid) from anon, public;

create or replace function public.inventory_list_transfer_items(p_branch_id uuid)
returns table(
  id uuid,
  name text,
  base_unit text,
  available_qty numeric,
  track_batches boolean,
  batches jsonb
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
  where b.id = p_branch_id and b.is_active;
  if v_org is null
     or not public.organization_has_feature(v_org, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_TRANSFER') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  return query
  select ii.id, ii.name, ii.base_unit, coalesce(ib.available_qty, 0), ii.track_batches,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id,
        'batch_number', b.batch_number,
        'current_qty', b.current_qty,
        'expires_at', b.expires_at
      ) order by b.expires_at asc nulls last, b.received_at)
      from public.inventory_batches b
      where b.item_id = ii.id and b.branch_id = p_branch_id
        and b.is_active and b.current_qty > 0
    ), '[]'::jsonb)
  from public.inventory_items ii
  left join public.inventory_balances ib on ib.item_id = ii.id and ib.branch_id = p_branch_id
  where ii.organization_id = v_org and ii.is_active
  order by ii.name;
end;
$$;
grant execute on function public.inventory_list_transfer_items(uuid) to authenticated;
revoke execute on function public.inventory_list_transfer_items(uuid) from anon, public;

create or replace function public.inventory_list_transfer_locations(p_branch_id uuid)
returns table(id uuid, name text)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.is_active
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_TRANSFER') then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  return query
  select l.id, l.name from public.inventory_locations l
  where l.branch_id = p_branch_id and l.is_active
  order by l.sort_order, l.name;
end;
$$;
grant execute on function public.inventory_list_transfer_locations(uuid) to authenticated;
revoke execute on function public.inventory_list_transfer_locations(uuid) from anon, public;

create or replace function public.inventory_list_transfers(p_branch_id uuid, p_limit integer default 100)
returns table(
  id uuid,
  transfer_number text,
  status text,
  from_branch_id uuid,
  from_branch_name text,
  to_branch_id uuid,
  to_branch_name text,
  requested_at timestamptz,
  line_count bigint
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare v_org uuid;
begin
  if p_limit < 1 or p_limit > 200 then raise exception 'Invalid limit' using errcode = '22023'; end if;
  select b.organization_id into v_org
  from public.branches b
  where b.id = p_branch_id and b.is_active;
  if v_org is null
     or not public.organization_has_feature(v_org, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_TRANSFER') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  return query
  select t.id, t.transfer_number, t.status::text,
    t.from_branch_id, fb.name, t.to_branch_id, tb.name,
    t.requested_at, count(tl.id)
  from public.inventory_transfers t
  join public.branches fb on fb.id = t.from_branch_id
  join public.branches tb on tb.id = t.to_branch_id
  left join public.inventory_transfer_lines tl on tl.transfer_id = t.id
  where t.organization_id = v_org
    and (t.from_branch_id = p_branch_id or t.to_branch_id = p_branch_id)
  group by t.id, fb.name, tb.name
  order by t.requested_at desc
  limit p_limit;
end;
$$;
grant execute on function public.inventory_list_transfers(uuid, integer) to authenticated;
revoke execute on function public.inventory_list_transfers(uuid, integer) from anon, public;

create or replace function public.inventory_get_transfer(p_transfer_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_transfer public.inventory_transfers;
  v_can_view_cost boolean;
  v_lines jsonb;
begin
  select * into v_transfer from public.inventory_transfers where id = p_transfer_id;
  if v_transfer.id is null
     or not public.organization_has_feature(v_transfer.organization_id, 'INVENTORY')
     or not (
       public.current_user_has_permission_for_branch(v_transfer.from_branch_id, 'INVENTORY_TRANSFER')
       or public.current_user_has_permission_for_branch(v_transfer.to_branch_id, 'INVENTORY_TRANSFER')
     ) then
    raise exception 'Transfer not found or access denied' using errcode = '42501';
  end if;
  v_can_view_cost :=
    public.current_user_has_permission_for_branch(v_transfer.from_branch_id, 'INVENTORY_COST_VIEW')
    or public.current_user_has_permission_for_branch(v_transfer.to_branch_id, 'INVENTORY_COST_VIEW');

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', tl.id,
    'item_id', tl.item_id,
    'item_name', ii.name,
    'requested_qty', tl.requested_qty,
    'dispatched_qty', tl.dispatched_qty,
    'received_qty', tl.received_qty,
    'damaged_in_transit_qty', tl.damaged_in_transit_qty,
    'unit', tl.unit,
    'unit_cost_paise', case when v_can_view_cost then tl.unit_cost_paise else null end,
    'from_location_id', tl.from_location_id,
    'to_location_id', tl.to_location_id,
    'from_batch_id', tl.from_batch_id
  ) order by ii.name), '[]'::jsonb)
  into v_lines
  from public.inventory_transfer_lines tl
  join public.inventory_items ii on ii.id = tl.item_id
  where tl.transfer_id = p_transfer_id;

  return jsonb_build_object(
    'id', v_transfer.id,
    'transfer_number', v_transfer.transfer_number,
    'status', v_transfer.status,
    'from_branch_id', v_transfer.from_branch_id,
    'to_branch_id', v_transfer.to_branch_id,
    'notes', v_transfer.notes,
    'requested_at', v_transfer.requested_at,
    'lines', v_lines
  );
end;
$$;
grant execute on function public.inventory_get_transfer(uuid) to authenticated;
revoke execute on function public.inventory_get_transfer(uuid) from anon, public;

create or replace function public.inventory_create_transfer(
  p_from_branch_id uuid,
  p_to_branch_id uuid,
  p_lines jsonb,
  p_notes text default null
)
returns public.inventory_transfers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer public.inventory_transfers;
  v_org uuid;
  v_line jsonb;
  v_item public.inventory_items;
  v_qty numeric;
  v_seen uuid[] := '{}';
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_from_branch_id = p_to_branch_id then raise exception 'Transfer branches must be different' using errcode = '22023'; end if;
  select b.organization_id into v_org
  from public.branches b
  where b.id = p_from_branch_id and b.is_active;
  if v_org is null
     or not exists (
       select 1 from public.branches b
       where b.id = p_to_branch_id and b.organization_id = v_org and b.is_active
     )
     or not public.organization_has_feature(v_org, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(p_from_branch_id, 'INVENTORY_TRANSFER')
     or not public.current_user_has_permission_for_branch(p_to_branch_id, 'INVENTORY_TRANSFER') then
    raise exception 'Both branches must be active, in the same organization, and authorized for inventory transfers' using errcode = '42501';
  end if;
  if length(coalesce(p_notes, '')) > 1000 then
    raise exception 'Transfer notes are limited to 1000 characters' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Transfer lines must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100 then
    raise exception 'Transfer must contain between 1 and 100 item lines' using errcode = '22023';
  end if;

  insert into public.inventory_transfers(
    organization_id, from_branch_id, to_branch_id, transfer_number, notes, created_by
  ) values (v_org, p_from_branch_id, p_to_branch_id, 'TRF-' || upper(replace(gen_random_uuid()::text, '-', '')),
    nullif(trim(coalesce(p_notes, '')), ''), auth.uid())
  returning * into v_transfer;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line) <> 'object'
       or nullif(v_line->>'item_id', '') is null
       or nullif(v_line->>'requested_qty', '') is null then
      raise exception 'Each transfer line needs an item and positive quantity' using errcode = '22023';
    end if;
    if (v_line->>'item_id')::uuid = any(v_seen) then
      raise exception 'Duplicate items are not allowed in a transfer' using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, (v_line->>'item_id')::uuid);
    v_qty := (v_line->>'requested_qty')::numeric;
    if v_qty <= 0 or v_qty > 1000000000 or v_qty <> round(v_qty, 4) then
      raise exception 'Transfer quantity is out of range or has more than four decimals' using errcode = '22023';
    end if;
    select * into v_item from public.inventory_items
    where id = (v_line->>'item_id')::uuid and organization_id = v_org and is_active;
    if v_item.id is null then raise exception 'Transfer item is not active in this organization' using errcode = '42501'; end if;
    if v_line ? 'from_location_id' and nullif(v_line->>'from_location_id', '') is not null
       and not exists (select 1 from public.inventory_locations l where l.id = (v_line->>'from_location_id')::uuid and l.branch_id = p_from_branch_id and l.is_active) then
      raise exception 'Source location is not active in the source branch' using errcode = '42501';
    end if;
    if v_line ? 'to_location_id' and nullif(v_line->>'to_location_id', '') is not null
       and not exists (select 1 from public.inventory_locations l where l.id = (v_line->>'to_location_id')::uuid and l.branch_id = p_to_branch_id and l.is_active) then
      raise exception 'Destination location is not active in the destination branch' using errcode = '42501';
    end if;
    if v_line ? 'from_batch_id' and nullif(v_line->>'from_batch_id', '') is not null
       and not exists (select 1 from public.inventory_batches b where b.id = (v_line->>'from_batch_id')::uuid and b.item_id = v_item.id and b.branch_id = p_from_branch_id and b.is_active) then
      raise exception 'Source batch does not belong to this item and branch' using errcode = '42501';
    end if;
    insert into public.inventory_transfer_lines(
      transfer_id, item_id, organization_id, from_batch_id, from_location_id, to_location_id,
      requested_qty, unit, notes
    ) values (
      v_transfer.id, v_item.id, v_org, nullif(v_line->>'from_batch_id', '')::uuid,
      nullif(v_line->>'from_location_id', '')::uuid, nullif(v_line->>'to_location_id', '')::uuid,
      v_qty, v_item.base_unit, nullif(trim(coalesce(v_line->>'notes', '')), '')
    );
  end loop;

  return v_transfer;
end;
$$;
grant execute on function public.inventory_create_transfer(uuid, uuid, jsonb, text) to authenticated;
revoke execute on function public.inventory_create_transfer(uuid, uuid, jsonb, text) from anon, public;

create or replace function public.inventory_transition_transfer(
  p_transfer_id uuid,
  p_action text,
  p_receipts jsonb default null
)
returns public.inventory_transfers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transfer public.inventory_transfers;
  v_line public.inventory_transfer_lines;
  v_receipt jsonb;
  v_receipt_map jsonb := '{}'::jsonb;
  v_accepted numeric;
  v_damaged numeric;
  v_available numeric;
  v_cost bigint;
  v_movement_id uuid;
  v_batch public.inventory_batches;
  v_location uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_transfer from public.inventory_transfers where id = p_transfer_id for update;
  if v_transfer.id is null
     or not public.organization_has_feature(v_transfer.organization_id, 'INVENTORY') then
    raise exception 'Transfer not found' using errcode = 'P0002';
  end if;
  if p_action is null or p_action not in ('APPROVE', 'DISPATCH', 'MARK_IN_TRANSIT', 'RECEIVE', 'CANCEL') then
    raise exception 'Invalid transfer action' using errcode = '22023';
  end if;

  if p_action = 'APPROVE' then
    if v_transfer.status <> 'REQUESTED' or not public.current_user_has_permission_for_branch(v_transfer.to_branch_id, 'INVENTORY_TRANSFER') then
      raise exception 'Only an authorized destination branch may approve a requested transfer' using errcode = '42501';
    end if;
    update public.inventory_transfers set status = 'APPROVED', approved_at = now(), approved_by = auth.uid()
    where id = p_transfer_id returning * into v_transfer;
  elsif p_action = 'DISPATCH' then
    if v_transfer.status <> 'APPROVED' or not public.current_user_has_permission_for_branch(v_transfer.from_branch_id, 'INVENTORY_TRANSFER') then
      raise exception 'Only the authorized source branch may dispatch an approved transfer' using errcode = '42501';
    end if;
    perform 1
    from public.inventory_balances ib
    join public.inventory_transfer_lines tl on tl.item_id = ib.item_id
    where tl.transfer_id = p_transfer_id and ib.branch_id = v_transfer.from_branch_id
    order by ib.item_id
    for update of ib;
    for v_line in
      select * from public.inventory_transfer_lines
      where transfer_id = p_transfer_id order by item_id
    loop
      select available_qty, avg_unit_cost_paise into v_available, v_cost
      from public.inventory_balances
      where item_id = v_line.item_id and branch_id = v_transfer.from_branch_id;
      if coalesce(v_available, 0) < v_line.requested_qty then
        raise exception 'Insufficient available stock for item %', v_line.item_id using errcode = '23514';
      end if;
      if v_line.from_batch_id is not null then
        select * into v_batch from public.inventory_batches
        where id = v_line.from_batch_id and branch_id = v_transfer.from_branch_id
        for update;
        if v_batch.current_qty < v_line.requested_qty then
          raise exception 'Insufficient quantity in selected source batch for item %', v_line.item_id using errcode = '23514';
        end if;
        update public.inventory_batches
        set current_qty = current_qty - v_line.requested_qty, updated_at = now()
        where id = v_batch.id;
      elsif (select track_batches from public.inventory_items where id = v_line.item_id) then
        raise exception 'Select a source batch for every batch-tracked item' using errcode = '22023';
      end if;
      update public.inventory_transfer_lines
      set dispatched_qty = requested_qty, unit_cost_paise = coalesce(v_cost, 0)
      where id = v_line.id
      returning * into v_line;

      insert into public.inventory_stock_movements(
        item_id, branch_id, location_id, batch_id, organization_id, movement_type,
        qty, unit, unit_cost_paise, total_cost_paise, source_event_type, source_event_id, notes, created_by
      ) values (
        v_line.item_id, v_transfer.from_branch_id, v_line.from_location_id, v_line.from_batch_id,
        v_transfer.organization_id, 'TRANSFER_OUT', -v_line.dispatched_qty, v_line.unit,
        v_line.unit_cost_paise, (v_line.dispatched_qty * v_line.unit_cost_paise)::bigint,
        'TRANSFER', v_transfer.id, v_transfer.transfer_number, auth.uid()
      ) returning id into v_movement_id;
      update public.inventory_transfer_lines set dispatch_movement_id = v_movement_id where id = v_line.id;
      perform public.inventory_update_balance(v_line.item_id, v_transfer.from_branch_id, -v_line.dispatched_qty, 0);
    end loop;
    update public.inventory_transfers set status = 'DISPATCHED', dispatched_at = now()
    where id = p_transfer_id returning * into v_transfer;
  elsif p_action = 'MARK_IN_TRANSIT' then
    if v_transfer.status <> 'DISPATCHED' or not public.current_user_has_permission_for_branch(v_transfer.from_branch_id, 'INVENTORY_TRANSFER') then
      raise exception 'Only the source branch may mark a dispatched transfer in transit' using errcode = '42501';
    end if;
    update public.inventory_transfers set status = 'IN_TRANSIT'
    where id = p_transfer_id returning * into v_transfer;
  elsif p_action = 'RECEIVE' then
    if v_transfer.status <> 'IN_TRANSIT'
       or not public.current_user_has_permission_for_branch(v_transfer.to_branch_id, 'INVENTORY_TRANSFER') then
      raise exception 'Only the authorized destination branch may receive an in-transit transfer' using errcode = '42501';
    end if;
    if jsonb_typeof(p_receipts) is distinct from 'array' then
      raise exception 'Transfer receipts must be a JSON array' using errcode = '22023';
    end if;
    if jsonb_array_length(p_receipts) <> (select count(*) from public.inventory_transfer_lines where transfer_id = p_transfer_id) then
      raise exception 'Provide accepted and damaged quantities for every transfer line' using errcode = '22023';
    end if;
    for v_receipt in select value from jsonb_array_elements(p_receipts)
    loop
      if nullif(v_receipt->>'line_id', '') is null
         or nullif(v_receipt->>'accepted_qty', '') is null
         or nullif(v_receipt->>'damaged_qty', '') is null then
        raise exception 'Each receipt line needs an ID, accepted quantity, and damaged quantity' using errcode = '22023';
      end if;
      if v_receipt_map ? (v_receipt->>'line_id') then raise exception 'Duplicate receipt line' using errcode = '22023'; end if;
      v_receipt_map := v_receipt_map || jsonb_build_object(v_receipt->>'line_id', v_receipt);
    end loop;
    for v_line in
      select * from public.inventory_transfer_lines
      where transfer_id = p_transfer_id order by item_id
    loop
      if not v_receipt_map ? v_line.id::text then raise exception 'Receipt is missing a transfer line' using errcode = '22023'; end if;
      v_receipt := v_receipt_map->v_line.id::text;
      v_accepted := (v_receipt->>'accepted_qty')::numeric;
      v_damaged := (v_receipt->>'damaged_qty')::numeric;
      if v_accepted < 0 or v_damaged < 0
         or v_accepted <> round(v_accepted, 4)
         or v_damaged <> round(v_damaged, 4)
         or v_accepted + v_damaged <> v_line.dispatched_qty then
        raise exception 'Accepted plus damaged quantity must equal dispatched quantity' using errcode = '22023';
      end if;
      v_location := coalesce(nullif(v_receipt->>'to_location_id', '')::uuid, v_line.to_location_id);
      if v_location is not null and not exists (
        select 1 from public.inventory_locations l
        where l.id = v_location and l.branch_id = v_transfer.to_branch_id and l.is_active
      ) then
        raise exception 'Destination location is not active in the receiving branch' using errcode = '42501';
      end if;
      update public.inventory_transfer_lines
      set received_qty = v_accepted, damaged_in_transit_qty = v_damaged, to_location_id = v_location
      where id = v_line.id
      returning * into v_line;

      if v_accepted > 0 then
        if v_line.from_batch_id is not null then
          select * into v_batch from public.inventory_batches where id = v_line.from_batch_id;
          insert into public.inventory_batches(
            item_id, branch_id, location_id, organization_id, batch_number, manufactured_at,
            expires_at, received_qty, current_qty, unit_cost_paise, is_active
          ) values (
            v_line.item_id, v_transfer.to_branch_id, v_location, v_transfer.organization_id,
            v_transfer.transfer_number || '-' || substr(v_line.id::text, 1, 8),
            v_batch.manufactured_at, v_batch.expires_at, v_accepted, v_accepted,
            v_line.unit_cost_paise, true
          ) returning * into v_batch;
        elsif (select track_batches from public.inventory_items where id = v_line.item_id) then
          raise exception 'Batch-tracked transfers must preserve a source batch' using errcode = '22023';
        end if;
        insert into public.inventory_stock_movements(
          item_id, branch_id, location_id, batch_id, organization_id, movement_type,
          qty, unit, unit_cost_paise, total_cost_paise, source_event_type, source_event_id, notes, created_by
        ) values (
          v_line.item_id, v_transfer.to_branch_id, v_location,
          case when v_line.from_batch_id is not null then v_batch.id else null end,
          v_transfer.organization_id, 'TRANSFER_IN', v_accepted, v_line.unit,
          v_line.unit_cost_paise, (v_accepted * v_line.unit_cost_paise)::bigint,
          'TRANSFER', v_transfer.id, v_transfer.transfer_number, auth.uid()
        ) returning id into v_movement_id;
        update public.inventory_transfer_lines set receive_movement_id = v_movement_id where id = v_line.id;
        perform public.inventory_update_balance(
          v_line.item_id, v_transfer.to_branch_id, v_accepted,
          (v_accepted * v_line.unit_cost_paise)::bigint
        );
      end if;
    end loop;
    update public.inventory_transfers set status = 'RECEIVED', received_at = now(), received_by = auth.uid()
    where id = p_transfer_id returning * into v_transfer;
  elsif p_action = 'CANCEL' then
    if v_transfer.status not in ('REQUESTED', 'APPROVED')
       or not public.current_user_has_permission_for_branch(v_transfer.from_branch_id, 'INVENTORY_TRANSFER') then
      raise exception 'Only the source branch may cancel a transfer before dispatch' using errcode = '42501';
    end if;
    update public.inventory_transfers set status = 'CANCELLED', cancellation_reason = 'Cancelled before dispatch'
    where id = p_transfer_id returning * into v_transfer;
  end if;

  return v_transfer;
end;
$$;
grant execute on function public.inventory_transition_transfer(uuid, text, jsonb) to authenticated;
revoke execute on function public.inventory_transition_transfer(uuid, text, jsonb) from anon, public;

select pg_notify('pgrst', 'reload schema');
commit;
