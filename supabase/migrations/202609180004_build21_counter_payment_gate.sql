-- TABLELY BUILD 21 — PAY NOW AT COUNTER PAYMENT GATE
--
-- Counter orders remain NEW while awaiting payment. Payment is recorded by
-- mark_order_paid(), which changes payment fields only; normal operational
-- transitions become available after payment.

begin;

create or replace function public.transition_order_status(
  p_order_id uuid,
  p_new_status public.order_status
)
returns table(
  id uuid,
  order_number bigint,
  table_id uuid,
  branch_id uuid,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  subtotal numeric,
  tax numeric,
  discount numeric,
  total numeric,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_allowed boolean := false;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select o.* into v_order
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  select s.* into v_staff
  from public.staff s
  where s.user_id = v_user
    and s.branch_id = v_order.branch_id
    and s.active = true
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  if v_staff.id is null then
    select s.* into v_staff
    from public.staff s
    join public.branches b on b.organization_id = s.organization_id and b.id = v_order.branch_id
    where s.user_id = v_user
      and s.active = true
      and s.role = 'OWNER'
    order by s.created_at
    limit 1;
  end if;

  if v_staff.id is null then
    raise exception 'You do not have access to this order' using errcode = '42501';
  end if;

  if (
    v_order.payment_method = 'PAY_NOW'
    or left(coalesce(v_order.payment_method, ''), 8) = 'PAY_NOW:'
  ) and v_order.status = 'NEW'::public.order_status
    and v_order.payment_status = 'PENDING'::public.payment_status then
    raise exception 'Online payment is still pending; this order is not actionable' using errcode = 'P0001';
  end if;

  if v_order.payment_method = 'PAY_AT_COUNTER'
     and v_order.payment_status = 'PENDING'::public.payment_status
     and (
       (v_order.status = 'NEW'::public.order_status
        and p_new_status in ('ACCEPTED'::public.order_status, 'PREPARING'::public.order_status))
       or
       (v_order.status = 'ACCEPTED'::public.order_status
        and p_new_status = 'PREPARING'::public.order_status)
     ) then
    raise exception 'Counter payment is required before this order can be prepared' using errcode = 'P0001';
  end if;

  if v_order.status = 'NEW'::public.order_status
     and p_new_status = 'ACCEPTED'::public.order_status then
    if v_staff.role = 'KITCHEN'::public.staff_role then
      v_allowed :=
        public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
        and public.get_kitchen_order_acceptance(v_order.branch_id);
    else
      v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS');
    end if;
  elsif v_order.status = 'ACCEPTED'::public.order_status
        and p_new_status = 'PREPARING'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen);
  elsif v_order.status = 'PREPARING'::public.order_status
        and p_new_status = 'READY'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen);
  elsif v_order.status = 'READY'::public.order_status
        and p_new_status = 'SERVED'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);
  elsif v_order.status = 'SERVED'::public.order_status
        and p_new_status = 'COMPLETED'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);
  end if;

  if not v_allowed then
    raise exception 'Invalid or unauthorized order status transition: % → %', v_order.status, p_new_status using errcode = '42501';
  end if;

  if p_new_status = 'COMPLETED'::public.order_status
     and v_order.payment_status <> 'PAID'::public.payment_status then
    raise exception 'Payment must be marked paid before completing this order' using errcode = 'P0001';
  end if;

  update public.orders
  set status = p_new_status, updated_at = now()
  where id = v_order.id;

  insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id)
  values(v_order.id, v_order.branch_id, 'STATUS_CHANGED', v_order.status::text, p_new_status::text, v_user);

  return query
  select ord.id, ord.order_number, ord.table_id, ord.branch_id, ord.status,
         ord.payment_status, ord.payment_method, ord.subtotal, ord.tax,
         ord.discount, ord.total, ord.created_at, ord.updated_at
  from public.orders ord
  where ord.id = v_order.id;
end;
$$;

grant execute on function public.transition_order_status(uuid, public.order_status) to authenticated;
revoke execute on function public.transition_order_status(uuid, public.order_status) from anon, public;
alter function public.transition_order_status(uuid, public.order_status) set search_path = public;

create or replace function public.transition_order_item_status(p_order_item_id uuid, p_new_status text)
returns public.order_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_user uuid := auth.uid();
  v_new text := upper(trim(coalesce(p_new_status, '')));
  v_current text;
  v_staff_id uuid;
  v_allowed_station boolean := true;
  v_now timestamptz := now();
begin
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if v_item.id is null then raise exception 'Order item not found'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  v_current := coalesce(v_item.preparation_status, 'PENDING');
  if not public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
     and not public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS') then
    raise exception 'Kitchen access denied' using errcode = '42501';
  end if;
  if (
    v_order.payment_method = 'PAY_NOW'
    or left(coalesce(v_order.payment_method, ''), 8) = 'PAY_NOW:'
  ) and v_order.payment_status = 'PENDING'::public.payment_status then
    raise exception 'PAY_NOW order must be paid before kitchen action' using errcode = '42501';
  end if;
  if v_order.payment_method = 'PAY_AT_COUNTER'
     and v_order.payment_status = 'PENDING'::public.payment_status
     and v_new in ('PREPARING', 'READY', 'SERVED') then
    raise exception 'Counter payment is required before kitchen action' using errcode = '42501';
  end if;
  if v_new not in ('PENDING', 'PREPARING', 'READY', 'SERVED', 'CANCELLED') then raise exception 'Invalid item status'; end if;
  if v_item.preparation_status = v_new then return v_item; end if;
  select s.id into v_staff_id
  from public.staff s
  where s.organization_id = (select organization_id from public.branches where id = v_order.branch_id)
    and s.user_id = auth.uid() and s.active = true
    and (s.role = 'OWNER' or s.branch_id = v_order.branch_id)
  limit 1;
  if v_staff_id is not null and v_item.station_id is not null then
    select exists(select 1 from public.kitchen_station_staff kss where kss.station_id = v_item.station_id and kss.staff_id = v_staff_id)
    into v_allowed_station;
    if not v_allowed_station and not public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS') then
      raise exception 'Unauthorized station';
    end if;
  end if;
  if v_new = 'PREPARING' and v_current not in ('PENDING', 'CANCELLED') then raise exception 'Invalid item state transition'; end if;
  if v_new = 'READY' and v_current <> 'PREPARING' then raise exception 'Item must be preparing before it can be ready'; end if;
  if v_new = 'SERVED' and v_current <> 'READY' then raise exception 'Item must be ready before it can be served'; end if;
  if v_new = 'CANCELLED' and v_current not in ('PENDING', 'PREPARING') then raise exception 'Item can no longer be cancelled'; end if;

  update public.order_items
  set preparation_status = v_new,
      started_at = case when v_new = 'PREPARING' then coalesce(started_at, v_now) else started_at end,
      ready_at = case when v_new = 'READY' then v_now else ready_at end,
      served_at = case when v_new = 'SERVED' then v_now else served_at end,
      completed_at = case when v_new = 'SERVED' then v_now else completed_at end,
      actual_prep_seconds = case when v_new = 'READY' and started_at is not null then greatest(0, extract(epoch from (v_now - started_at))::int) else actual_prep_seconds end
  where id = v_item.id
  returning * into v_item;

  insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
  values(v_order.id, v_order.branch_id, 'ORDER_ITEM_STATUS_CHANGED', v_user, jsonb_build_object('order_item_id', v_item.id, 'preparation_status', v_new));

  if v_new = 'PREPARING' and v_order.status in ('ACCEPTED', 'NEW') then
    update public.orders
    set status = 'PREPARING'::public.order_status, started_at = coalesce(started_at, v_now),
        accepted_at = coalesce(accepted_at, v_now), updated_at = v_now
    where id = v_order.id and status in ('ACCEPTED', 'NEW');
    insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata)
    select v_order.id, v_order.branch_id, 'STATUS_CHANGED', v_order.status::text, 'PREPARING', v_user, jsonb_build_object('source', 'ITEM_STATUS');
  elsif v_new = 'READY' and not exists(select 1 from public.order_items oi where oi.order_id = v_order.id and oi.preparation_status not in ('READY', 'SERVED', 'CANCELLED')) then
    if v_order.status = 'PREPARING' then
      update public.orders set status = 'READY'::public.order_status, ready_at = v_now, updated_at = v_now where id = v_order.id and status = 'PREPARING';
      insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata)
      values(v_order.id, v_order.branch_id, 'STATUS_CHANGED', 'PREPARING', 'READY', v_user, jsonb_build_object('source', 'ITEM_STATUS'));
    end if;
  elsif v_new = 'SERVED' and not exists(select 1 from public.order_items oi where oi.order_id = v_order.id and oi.preparation_status not in ('SERVED', 'CANCELLED')) then
    if v_order.status = 'READY' then
      update public.orders set status = 'SERVED'::public.order_status, served_at = v_now, updated_at = v_now where id = v_order.id and status = 'READY';
      insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata)
      values(v_order.id, v_order.branch_id, 'STATUS_CHANGED', 'READY', 'SERVED', v_user, jsonb_build_object('source', 'ITEM_STATUS'));
    end if;
  end if;

  perform public.build17_sync_table_operational_state(v_order.table_id);
  return v_item;
end;
$$;
grant execute on function public.transition_order_item_status(uuid, text) to authenticated;
revoke execute on function public.transition_order_item_status(uuid, text) from anon, public;

commit;

notify pgrst, 'reload schema';
