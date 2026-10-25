-- TABLELY BUILD 34.4 — Purchase Orders, GRN & Stock Receiving RPCs
-- Full PO workflow (Draft → Closed) and GRN receiving that creates
-- stock movements and batch records. Only approved GRN receipts add stock.
-- Additive/idempotent. Depends on 20261025030000.

begin;

alter table public.inventory_purchase_order_lines
  add column if not exists received_qty numeric(15, 4) not null default 0
  check (received_qty >= 0);

-- ---------------------------------------------------------------------------
-- 1) Auto-generate PO and GRN numbers (org-scoped sequences)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_next_po_number(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year text := to_char(now(), 'YY');
  v_seq bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('inventory-po:' || p_organization_id::text, 0));
  select count(*) + 1 into v_seq
  from public.inventory_purchase_orders
  where organization_id = p_organization_id;
  return 'PO-' || v_year || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

create or replace function public.inventory_next_grn_number(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year text := to_char(now(), 'YY');
  v_seq bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('inventory-grn:' || p_organization_id::text, 0));
  select count(*) + 1 into v_seq
  from public.inventory_goods_receipts
  where organization_id = p_organization_id;
  return 'GRN-' || v_year || '-' || lpad(v_seq::text, 4, '0');
end;
$$;
revoke all on function public.inventory_next_po_number(uuid) from public, anon, authenticated;
revoke all on function public.inventory_next_grn_number(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Create / update purchase order
-- ---------------------------------------------------------------------------
create or replace function public.inventory_upsert_purchase_order(
  p_branch_id uuid,
  p_supplier_id uuid,
  p_id uuid default null,
  p_expected_delivery_date date default null,
  p_notes text default null,
  p_status text default null,  -- only used for cancellation
  p_cancellation_reason text default null,
  -- Lines: [{item_id, ordered_qty, purchase_unit, agreed_unit_price_paise, discount_pct, tax_pct, notes}]
  p_lines jsonb default '[]'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.inventory_purchase_orders;
  v_org uuid;
  v_line jsonb;
  v_subtotal bigint := 0;
  v_tax bigint := 0;
  v_total bigint := 0;
  v_line_total bigint;
  v_line_tax bigint;
  v_item public.inventory_items;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Purchase order lines must be a JSON array';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_PURCHASE') then
    raise exception 'INVENTORY_PURCHASE permission required' using errcode = '42501';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null or not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  if p_id is not null then
    -- Update existing PO
    select * into v_po from public.inventory_purchase_orders
    where id = p_id and branch_id = p_branch_id for update;

    if v_po.id is null then raise exception 'Purchase order not found' using errcode = 'P0002'; end if;

    -- Handle cancellation
    if p_status = 'CANCELLED' then
      if v_po.status not in ('DRAFT','PENDING_APPROVAL','APPROVED') then
        raise exception 'Cannot cancel a PO in status: %', v_po.status;
      end if;
      update public.inventory_purchase_orders
      set status = 'CANCELLED', cancellation_reason = p_cancellation_reason, updated_at = now()
      where id = p_id returning * into v_po;
      return jsonb_build_object('purchase_order', row_to_json(v_po), 'lines', '[]'::jsonb);
    end if;

    -- Only allow editing DRAFT / PENDING_APPROVAL POs
    if v_po.status not in ('DRAFT','PENDING_APPROVAL') then
      raise exception 'Only DRAFT or PENDING_APPROVAL orders can be edited';
    end if;

    update public.inventory_purchase_orders
    set supplier_id = coalesce(p_supplier_id, supplier_id),
        expected_delivery_date = p_expected_delivery_date,
        notes = p_notes,
        updated_at = now()
    where id = p_id returning * into v_po;

    -- Replace lines if provided
    if jsonb_array_length(coalesce(p_lines,'[]')) > 0 then
      delete from public.inventory_purchase_order_lines where purchase_order_id = p_id;
    end if;
  else
    if coalesce(jsonb_array_length(p_lines), 0) = 0 then
      raise exception 'At least one purchase order line is required';
    end if;
    -- Create new PO
    insert into public.inventory_purchase_orders(
      organization_id, branch_id, supplier_id, po_number,
      status, expected_delivery_date, notes, created_by
    ) values (
      v_org, p_branch_id, p_supplier_id,
      public.inventory_next_po_number(v_org),
      'DRAFT', p_expected_delivery_date, p_notes, auth.uid()
    ) returning * into v_po;
  end if;

  if not exists (
    select 1 from public.inventory_suppliers s
    where s.id = coalesce(p_supplier_id, v_po.supplier_id)
      and s.organization_id = v_org
  ) then
    raise exception 'Supplier does not belong to this organization' using errcode = '42501';
  end if;

  if coalesce(jsonb_array_length(p_lines), 0) = 0 then
    return jsonb_build_object(
      'purchase_order', row_to_json(v_po),
      'lines', (
        select coalesce(jsonb_agg(l order by l.sort_order), '[]'::jsonb)
        from public.inventory_purchase_order_lines l
        where l.purchase_order_id = v_po.id
      )
    );
  end if;

  -- Insert lines
  for v_line in select * from jsonb_array_elements(coalesce(p_lines,'[]'))
  loop
    if coalesce((v_line->>'ordered_qty')::numeric, 0) <= 0
       or coalesce((v_line->>'agreed_unit_price_paise')::bigint, -1) < 0
       or coalesce((v_line->>'discount_pct')::numeric, 0) < 0
       or coalesce((v_line->>'discount_pct')::numeric, 0) > 100
       or coalesce((v_line->>'tax_pct')::numeric, 0) < 0
       or coalesce((v_line->>'tax_pct')::numeric, 0) > 100 then
      raise exception 'Purchase order line quantity, price, discount, or tax is invalid';
    end if;
    select * into v_item from public.inventory_items
    where id = nullif(v_line->>'item_id', '')::uuid
      and organization_id = v_org
      and is_active;
    if v_item.id is null or v_item.purchase_unit <> v_line->>'purchase_unit' then
      raise exception 'Purchase item must be active, belong to this organization, and use its purchase unit'
        using errcode = '42501';
    end if;

    v_line_total := (
      (v_line->>'ordered_qty')::numeric
      * (v_line->>'agreed_unit_price_paise')::bigint
      * (1 - coalesce((v_line->>'discount_pct')::numeric, 0) / 100)
    )::bigint;
    v_line_tax := (v_line_total * coalesce((v_line->>'tax_pct')::numeric, 0) / 100)::bigint;
    v_subtotal := v_subtotal + v_line_total;
    v_tax := v_tax + v_line_tax;

    insert into public.inventory_purchase_order_lines(
      purchase_order_id, item_id, organization_id,
      ordered_qty, purchase_unit, agreed_unit_price_paise,
      discount_pct, tax_pct, line_total_paise, notes, sort_order
    ) values (
      v_po.id,
      (v_line->>'item_id')::uuid,
      v_org,
      (v_line->>'ordered_qty')::numeric,
      v_line->>'purchase_unit',
      (v_line->>'agreed_unit_price_paise')::bigint,
      coalesce((v_line->>'discount_pct')::numeric, 0),
      coalesce((v_line->>'tax_pct')::numeric, 0),
      v_line_total + v_line_tax,
      v_line->>'notes',
      coalesce((v_line->>'sort_order')::integer, 0)
    );
  end loop;

  v_total := v_subtotal + v_tax;
  update public.inventory_purchase_orders
  set subtotal_paise = v_subtotal, tax_paise = v_tax, total_paise = v_total, updated_at = now()
  where id = v_po.id returning * into v_po;

  return jsonb_build_object(
    'purchase_order', row_to_json(v_po),
    'lines', (
      select coalesce(jsonb_agg(l order by l.sort_order), '[]')
      from public.inventory_purchase_order_lines l
      where l.purchase_order_id = v_po.id
    )
  );
end;
$$;
grant execute on function public.inventory_upsert_purchase_order to authenticated;
revoke execute on function public.inventory_upsert_purchase_order from anon, public;

-- ---------------------------------------------------------------------------
-- 3) Approve / advance PO status
-- ---------------------------------------------------------------------------
create or replace function public.inventory_advance_po_status(
  p_po_id uuid,
  p_new_status text  -- PENDING_APPROVAL, APPROVED, SENT, CLOSED, CANCELLED
)
returns public.inventory_purchase_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_po public.inventory_purchase_orders;
  v_allowed boolean := false;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  select * into v_po from public.inventory_purchase_orders where id = p_po_id for update;
  if v_po.id is null then raise exception 'Purchase order not found' using errcode = 'P0002'; end if;
  if not public.organization_has_feature(v_po.organization_id, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  if not public.current_user_has_permission_for_branch(v_po.branch_id, 'INVENTORY_PURCHASE') then
    raise exception 'INVENTORY_PURCHASE permission required' using errcode = '42501';
  end if;

  v_allowed := case
    when v_po.status = 'DRAFT' and p_new_status = 'PENDING_APPROVAL' then true
    when v_po.status = 'DRAFT' and p_new_status = 'APPROVED'
      then public.is_org_owner(v_po.organization_id)
    when v_po.status = 'PENDING_APPROVAL' and p_new_status in ('APPROVED','CANCELLED') then true
    when v_po.status = 'APPROVED' and p_new_status in ('SENT','CANCELLED') then true
    when v_po.status = 'SENT' and p_new_status in ('CANCELLED') then true
    when v_po.status = 'PARTIALLY_RECEIVED' and p_new_status = 'CLOSED' then true
    when v_po.status = 'RECEIVED' and p_new_status = 'CLOSED' then true
    else false
  end;

  if not v_allowed then
    raise exception 'Invalid PO status transition: % → %', v_po.status, p_new_status;
  end if;

  update public.inventory_purchase_orders
  set status = p_new_status::public.inventory_po_status,
      approved_by = case when p_new_status = 'APPROVED' then auth.uid() else approved_by end,
      approved_at = case when p_new_status = 'APPROVED' then now() else approved_at end,
      updated_at = now()
  where id = p_po_id returning * into v_po;

  return v_po;
end;
$$;
grant execute on function public.inventory_advance_po_status(uuid, text) to authenticated;
revoke execute on function public.inventory_advance_po_status(uuid, text) from anon, public;

-- ---------------------------------------------------------------------------
-- 4) Create GRN (Goods Received Note)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_create_grn(
  p_branch_id uuid,
  p_supplier_id uuid,
  p_purchase_order_id uuid default null,
  p_received_date date default null,
  p_supplier_invoice_number text default null,
  p_supplier_invoice_date date default null,
  p_notes text default null,
  -- Lines: [{item_id, po_line_id, location_id, ordered_qty, received_qty, damaged_qty, accepted_qty,
  --          purchase_unit, actual_unit_price_paise, batch_number, manufactured_at, expires_at, notes}]
  p_lines jsonb default '[]'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grn public.inventory_goods_receipts;
  v_org uuid;
  v_line jsonb;
  v_total_accepted bigint := 0;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Goods receipt lines must be a JSON array';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_RECEIVE') then
    raise exception 'INVENTORY_RECEIVE permission required' using errcode = '42501';
  end if;

  if jsonb_array_length(coalesce(p_lines,'[]')) = 0 then
    raise exception 'At least one GRN line is required';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null or not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.inventory_suppliers s
    where s.id = p_supplier_id and s.organization_id = v_org
  ) then
    raise exception 'Supplier does not belong to this organization' using errcode = '42501';
  end if;
  if p_purchase_order_id is not null and not exists (
    select 1 from public.inventory_purchase_orders po
    where po.id = p_purchase_order_id
      and po.branch_id = p_branch_id
      and po.organization_id = v_org
      and po.supplier_id = p_supplier_id
      and po.status in ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')
  ) then
    raise exception 'Purchase order is not available for this branch and supplier' using errcode = '42501';
  end if;

  -- Calculate total accepted value
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    if coalesce((v_line->>'received_qty')::numeric, -1) < 0
       or coalesce((v_line->>'damaged_qty')::numeric, 0) < 0
       or coalesce((v_line->>'accepted_qty')::numeric, -1) < 0
       or coalesce((v_line->>'accepted_qty')::numeric, 0)
          + coalesce((v_line->>'damaged_qty')::numeric, 0)
          > coalesce((v_line->>'received_qty')::numeric, 0)
       or coalesce((v_line->>'actual_unit_price_paise')::bigint, -1) < 0 then
      raise exception 'Goods receipt quantities or price are invalid';
    end if;
    if not exists (
      select 1 from public.inventory_items ii
      where ii.id = nullif(v_line->>'item_id', '')::uuid
        and ii.organization_id = v_org
        and ii.is_active
        and ii.purchase_unit = v_line->>'purchase_unit'
    ) then
      raise exception 'Goods receipt item must be active, belong to this organization, and use its purchase unit'
        using errcode = '42501';
    end if;
    if nullif(v_line->>'location_id', '') is not null and not exists (
      select 1 from public.inventory_locations l
      where l.id = (v_line->>'location_id')::uuid and l.branch_id = p_branch_id
    ) then
      raise exception 'Goods receipt location does not belong to this branch' using errcode = '42501';
    end if;
    if nullif(v_line->>'po_line_id', '') is not null and not exists (
      select 1 from public.inventory_purchase_order_lines pol
      where pol.id = (v_line->>'po_line_id')::uuid
        and pol.purchase_order_id = p_purchase_order_id
        and pol.item_id = (v_line->>'item_id')::uuid
        and pol.organization_id = v_org
        and pol.purchase_unit = v_line->>'purchase_unit'
        and pol.ordered_qty - pol.received_qty >= (v_line->>'accepted_qty')::numeric
    ) then
      raise exception 'Purchase order line does not match the order, item, unit, or remaining quantity'
        using errcode = '42501';
    end if;
    v_total_accepted := v_total_accepted + (
      (v_line->>'accepted_qty')::numeric * (v_line->>'actual_unit_price_paise')::bigint
    )::bigint;
  end loop;

  insert into public.inventory_goods_receipts(
    organization_id, branch_id, purchase_order_id, supplier_id, grn_number,
    status, received_date, supplier_invoice_number, supplier_invoice_date,
    notes, total_accepted_value_paise, created_by
  ) values (
    v_org, p_branch_id, p_purchase_order_id, p_supplier_id,
    public.inventory_next_grn_number(v_org),
    'DRAFT', coalesce(p_received_date, current_date),
    p_supplier_invoice_number, p_supplier_invoice_date,
    p_notes, v_total_accepted, auth.uid()
  ) returning * into v_grn;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into public.inventory_goods_receipt_lines(
      goods_receipt_id, po_line_id, item_id, organization_id, location_id,
      ordered_qty, received_qty, damaged_qty, accepted_qty,
      purchase_unit, actual_unit_price_paise, line_total_paise,
      batch_number, manufactured_at, expires_at, notes
    ) values (
      v_grn.id,
      nullif((v_line->>'po_line_id')::text, '')::uuid,
      (v_line->>'item_id')::uuid,
      v_org,
      nullif((v_line->>'location_id')::text, '')::uuid,
      (v_line->>'ordered_qty')::numeric,
      (v_line->>'received_qty')::numeric,
      coalesce((v_line->>'damaged_qty')::numeric, 0),
      (v_line->>'accepted_qty')::numeric,
      v_line->>'purchase_unit',
      (v_line->>'actual_unit_price_paise')::bigint,
      ((v_line->>'accepted_qty')::numeric * (v_line->>'actual_unit_price_paise')::bigint)::bigint,
      nullif(v_line->>'batch_number', ''),
      nullif(v_line->>'manufactured_at', '')::date,
      nullif(v_line->>'expires_at', '')::date,
      v_line->>'notes'
    );
  end loop;

  return jsonb_build_object(
    'grn', row_to_json(v_grn),
    'lines', (
      select coalesce(jsonb_agg(l), '[]')
      from public.inventory_goods_receipt_lines l
      where l.goods_receipt_id = v_grn.id
    )
  );
end;
$$;
grant execute on function public.inventory_create_grn to authenticated;
revoke execute on function public.inventory_create_grn from anon, public;

-- ---------------------------------------------------------------------------
-- 5) Approve GRN — this is the ONLY action that increases stock
-- ---------------------------------------------------------------------------
create or replace function public.inventory_approve_grn(p_grn_id uuid)
returns public.inventory_goods_receipts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grn public.inventory_goods_receipts;
  v_line public.inventory_goods_receipt_lines;
  v_item public.inventory_items;
  v_batch_id uuid;
  v_movement_id uuid;
  v_accepted_base_qty numeric;
  v_unit_cost_paise_in_base bigint;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  select * into v_grn from public.inventory_goods_receipts where id = p_grn_id for update;
  if v_grn.id is null then raise exception 'GRN not found' using errcode = 'P0002'; end if;

  if not public.current_user_has_permission_for_branch(v_grn.branch_id, 'INVENTORY_RECEIVE') then
    raise exception 'INVENTORY_RECEIVE permission required' using errcode = '42501';
  end if;
  if not public.organization_has_feature(v_grn.organization_id, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  if v_grn.status not in ('DRAFT','SUBMITTED') then
    raise exception 'GRN is already % — cannot approve again', v_grn.status;
  end if;

  if v_grn.purchase_order_id is not null then
    perform 1 from public.inventory_purchase_orders
    where id = v_grn.purchase_order_id and branch_id = v_grn.branch_id
    for update;
    perform 1 from public.inventory_purchase_order_lines
    where purchase_order_id = v_grn.purchase_order_id
    order by id
    for update;
  end if;

  -- Process each line: create batch + stock movement + update balance
  for v_line in
    select * from public.inventory_goods_receipt_lines
    where goods_receipt_id = p_grn_id and accepted_qty > 0
  loop
    select * into v_item from public.inventory_items where id = v_line.item_id;

    -- Convert accepted_qty from purchase_unit to base_unit
    v_accepted_base_qty := v_line.accepted_qty * v_item.purchase_unit_conversion;

    -- Cost per base_unit in paise
    v_unit_cost_paise_in_base := (v_line.actual_unit_price_paise::numeric / v_item.purchase_unit_conversion)::bigint;

    -- Create or update batch record
    if v_item.track_batches or v_item.track_expiry then
      insert into public.inventory_batches(
        item_id, branch_id, location_id, organization_id,
        goods_receipt_line_id, batch_number,
        manufactured_at, expires_at,
        received_qty, current_qty, unit_cost_paise, received_at
      ) values (
        v_line.item_id, v_grn.branch_id, v_line.location_id, v_grn.organization_id,
        v_line.id, v_line.batch_number,
        v_line.manufactured_at, v_line.expires_at,
        v_accepted_base_qty, v_accepted_base_qty, v_unit_cost_paise_in_base, v_grn.received_date::timestamptz
      ) returning id into v_batch_id;
    else
      -- Simple: update or create a single catch-all batch for this item/location
      insert into public.inventory_batches(
        item_id, branch_id, location_id, organization_id,
        received_qty, current_qty, unit_cost_paise
      ) values (
        v_line.item_id, v_grn.branch_id, v_line.location_id, v_grn.organization_id,
        v_accepted_base_qty, v_accepted_base_qty, v_unit_cost_paise_in_base
      ) returning id into v_batch_id;
    end if;

    -- Create stock movement (PURCHASE type, idempotent via unique constraint)
    insert into public.inventory_stock_movements(
      item_id, branch_id, location_id, batch_id, organization_id,
      movement_type, qty, unit, unit_cost_paise, total_cost_paise,
      source_event_type, source_event_id, created_by
    ) values (
      v_line.item_id, v_grn.branch_id, v_line.location_id, v_batch_id, v_grn.organization_id,
      'PURCHASE', v_accepted_base_qty, v_item.base_unit,
      v_unit_cost_paise_in_base,
      (v_accepted_base_qty * v_unit_cost_paise_in_base)::bigint,
      'GRN', v_line.id, auth.uid()
    )
    on conflict (source_event_id, item_id, branch_id, movement_type) do nothing
    returning id into v_movement_id;

    -- Update balance cache
    if v_movement_id is not null then
      perform public.inventory_update_balance(
        v_line.item_id, v_grn.branch_id,
        v_accepted_base_qty,
        (v_accepted_base_qty * v_unit_cost_paise_in_base)::bigint,
        v_grn.received_date::timestamptz
      );
    end if;

    -- Link movement back to GRN line
    update public.inventory_goods_receipt_lines
    set stock_movement_id = v_movement_id
    where id = v_line.id;

    -- Update PO line received status if linked
    if v_line.po_line_id is not null then
      if not exists (
        select 1 from public.inventory_purchase_order_lines pol
        where pol.id = v_line.po_line_id
          and pol.purchase_order_id = v_grn.purchase_order_id
          and pol.ordered_qty - pol.received_qty >= v_line.accepted_qty
      ) then
        raise exception 'Accepted quantity exceeds the remaining purchase order quantity';
      end if;
      update public.inventory_purchase_order_lines
      set received_qty = received_qty + v_line.accepted_qty
      where id = v_line.po_line_id;
    end if;
  end loop;

  -- Mark GRN approved
  update public.inventory_goods_receipts
  set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where id = p_grn_id returning * into v_grn;

  -- Update linked PO status if all lines received
  if v_grn.purchase_order_id is not null then
    update public.inventory_purchase_orders
    set status = case when exists (
          select 1 from public.inventory_purchase_order_lines pol
          where pol.purchase_order_id = v_grn.purchase_order_id
            and pol.received_qty < pol.ordered_qty
        ) then 'PARTIALLY_RECEIVED'::public.inventory_po_status
        else 'RECEIVED'::public.inventory_po_status
      end,
      updated_at = now()
    where id = v_grn.purchase_order_id
      and status in ('SENT','PARTIALLY_RECEIVED','APPROVED');
  end if;

  return v_grn;
end;
$$;
grant execute on function public.inventory_approve_grn(uuid) to authenticated;
revoke execute on function public.inventory_approve_grn(uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- 6) List POs for a branch
-- ---------------------------------------------------------------------------
create or replace function public.inventory_list_purchase_orders(
  p_branch_id uuid,
  p_status text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table(
  id uuid, po_number text, status text, supplier_name text,
  expected_delivery_date date, total_paise bigint,
  created_at timestamptz, updated_at timestamptz
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
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_PURCHASE') then
    raise exception 'INVENTORY_PURCHASE permission required' using errcode = '42501';
  end if;

  return query
  select po.id, po.po_number, po.status::text, sup.company_name,
    po.expected_delivery_date, po.total_paise, po.created_at, po.updated_at
  from public.inventory_purchase_orders po
  join public.inventory_suppliers sup on sup.id = po.supplier_id
  where po.branch_id = p_branch_id
    and (p_status is null or po.status::text = p_status)
  order by po.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;
grant execute on function public.inventory_list_purchase_orders(uuid, text, integer, integer) to authenticated;
revoke execute on function public.inventory_list_purchase_orders(uuid, text, integer, integer) from anon, public;

-- ---------------------------------------------------------------------------
-- 7) Opening stock entry (directly add stock without a PO/GRN)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_add_opening_stock(
  p_branch_id uuid,
  p_item_id uuid,
  p_location_id uuid default null,
  p_qty numeric default 0,      -- in base_unit
  p_unit_cost_paise bigint default 0,
  p_batch_number text default null,
  p_expires_at date default null,
  p_notes text default null,
  p_idempotency_key uuid default null
)
returns public.inventory_stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.inventory_items;
  v_org uuid;
  v_batch_id uuid;
  v_movement public.inventory_stock_movements;
  v_existing public.inventory_stock_movements;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;

  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  if coalesce(p_qty, 0) <= 0
     or coalesce(p_unit_cost_paise, -1) < 0
     or p_idempotency_key is null then
    raise exception 'Quantity, cost, and idempotency key are required and must be valid';
  end if;

  select * into v_item from public.inventory_items where id = p_item_id;
  if v_item.id is null then raise exception 'Inventory item not found'; end if;

  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_item.organization_id <> v_org then
    raise exception 'Inventory item does not belong to this branch organization' using errcode = '42501';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.inventory_locations l
    where l.id = p_location_id and l.branch_id = p_branch_id
  ) then
    raise exception 'Location does not belong to this branch' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select * into v_existing from public.inventory_stock_movements
  where source_event_type = 'OPENING_STOCK'
    and source_event_id = p_idempotency_key
    and item_id = p_item_id
    and branch_id = p_branch_id
    and movement_type = 'OPENING'
  for update;
  if v_existing.id is not null then
    if v_existing.qty <> p_qty or v_existing.unit_cost_paise <> p_unit_cost_paise
       or v_existing.location_id is distinct from p_location_id then
      raise exception 'Idempotency key was already used for a different opening stock adjustment';
    end if;
    return v_existing;
  end if;

  -- Create batch
  insert into public.inventory_batches(
    item_id, branch_id, location_id, organization_id,
    batch_number, expires_at, received_qty, current_qty, unit_cost_paise
  ) values (
    p_item_id, p_branch_id, p_location_id, v_org,
    p_batch_number, p_expires_at, p_qty, p_qty, p_unit_cost_paise
  ) returning id into v_batch_id;

  -- Create movement
  insert into public.inventory_stock_movements(
    item_id, branch_id, location_id, batch_id, organization_id,
    movement_type, qty, unit, unit_cost_paise, total_cost_paise,
    source_event_type, source_event_id, notes, created_by
  ) values (
    p_item_id, p_branch_id, p_location_id, v_batch_id, v_org,
    'OPENING', p_qty, v_item.base_unit,
    p_unit_cost_paise, (p_qty * p_unit_cost_paise)::bigint,
    'OPENING_STOCK', p_idempotency_key, p_notes, auth.uid()
  ) returning * into v_movement;

  -- Update balance
  perform public.inventory_update_balance(
    p_item_id, p_branch_id, p_qty, (p_qty * p_unit_cost_paise)::bigint
  );

  return v_movement;
end;
$$;
grant execute on function public.inventory_add_opening_stock to authenticated;
revoke execute on function public.inventory_add_opening_stock from anon, public;

select pg_notify('pgrst', 'reload schema');
commit;
