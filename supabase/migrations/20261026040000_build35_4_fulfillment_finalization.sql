-- TABLELY BUILD 35.4 — Fulfillment finalization, failed-delivery retry, return workflow and payment references
-- Forward-only corrective migration. Historical migrations remain intact.

begin;

alter table public.order_fulfillment_details
  add column if not exists return_reason text,
  add column if not exists return_notes text,
  add column if not exists returned_at timestamptz,
  add column if not exists returning_staff_id uuid references public.staff(id) on delete set null,
  add column if not exists payment_reference text,
  add column if not exists reference_source text,
  add column if not exists last_retry_at timestamptz,
  add column if not exists retry_count integer not null default 0;

alter table public.order_fulfillment_details
  drop constraint if exists fulfillment_retry_count_check;
alter table public.order_fulfillment_details
  add constraint fulfillment_retry_count_check
    check (retry_count >= 0);

alter table public.order_fulfillment_details
  add constraint order_fulfillment_details_reference_source_check
    check (reference_source is null or reference_source in ('CUSTOMER_REPORTED', 'STAFF_CONFIRMED', 'PROVIDER_VERIFIED'));

-- Build 35.4 preserves a real return state as a fulfillment milestone rather than a failure reason.
create or replace function public.fulfillment_retry_delivery(p_order_id uuid, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_actor_staff_id uuid;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'DELIVERY' then
    raise exception 'Delivery order not found';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.status in ('CANCELLED', 'COMPLETED') then
    raise exception 'Order cannot be retried in its current state';
  end if;

  if not (
    public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_DELIVERY')
    or public.current_user_has_permission_for_branch(v_ofd.branch_id, 'ASSIGN_DELIVERY')
    or exists (
      select 1 from public.staff s
      where s.user_id = auth.uid()
        and s.branch_id = v_ofd.branch_id
        and s.active = true
        and s.id = coalesce(v_ofd.assigned_staff_id, s.id)
        and exists (
          select 1 from public.staff_permissions sp
          where sp.staff_id = s.id and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true
        )
    )
  ) then
    raise exception 'Permission denied: delivery retry requires delivery management or assigned rider permissions' using errcode = '42501';
  end if;

  if v_ofd.fulfillment_status not in ('DELIVERY_FAILED', 'RETURNED_TO_RESTAURANT') then
    raise exception 'Only failed or returned deliveries can be retried';
  end if;

  select s.id into v_actor_staff_id from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  update public.order_fulfillment_details
  set fulfillment_status = 'WAITING_FOR_DRIVER',
      failed_at = null,
      failure_reason = null,
      returned_at = null,
      return_reason = null,
      return_notes = null,
      returning_staff_id = null,
      retry_count = coalesce(retry_count, 0) + 1,
      last_retry_at = now(),
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (
    p_order_id,
    v_ofd.branch_id,
    'DELIVERY_RETRY',
    v_ofd.fulfillment_status,
    'WAITING_FOR_DRIVER',
    auth.uid(),
    v_actor_staff_id,
    jsonb_build_object('reason', v_reason, 'retry_count', coalesce(v_ofd.retry_count, 0) + 1)
  );

  return true;
end;
$$;

grant execute on function public.fulfillment_retry_delivery(uuid, text) to authenticated;
revoke execute on function public.fulfillment_retry_delivery(uuid, text) from anon, public;

create or replace function public.fulfillment_return_to_restaurant(p_order_id uuid, p_reason text, p_notes text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_actor_staff_id uuid;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
  v_notes text := nullif(left(trim(coalesce(p_notes, '')), 1000), '');
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'A return reason is required';
  end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'DELIVERY' then
    raise exception 'Delivery order not found';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.status in ('CANCELLED', 'COMPLETED') then
    raise exception 'This delivery cannot be returned in its current state';
  end if;

  if not (
    public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_DELIVERY')
    or exists (
      select 1 from public.staff s
      where s.user_id = auth.uid()
        and s.branch_id = v_ofd.branch_id
        and s.active = true
        and s.id = coalesce(v_ofd.assigned_staff_id, s.id)
        and exists (
          select 1 from public.staff_permissions sp
          where sp.staff_id = s.id and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true
        )
    )
  ) then
    raise exception 'Permission denied: returning a delivery requires delivery management or assigned rider status access' using errcode = '42501';
  end if;

  if v_ofd.fulfillment_status not in ('OUT_FOR_DELIVERY', 'DELIVERY_FAILED') then
    raise exception 'Only active or failed deliveries can be returned to the restaurant';
  end if;

  select s.id into v_actor_staff_id from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  update public.order_fulfillment_details
  set fulfillment_status = 'RETURNED_TO_RESTAURANT',
      returned_at = now(),
      return_reason = v_reason,
      return_notes = v_notes,
      returning_staff_id = v_actor_staff_id,
      failed_at = coalesce(failed_at, now()),
      failure_reason = coalesce(failure_reason, v_reason),
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (
    p_order_id,
    v_ofd.branch_id,
    'RETURNED_TO_RESTAURANT',
    v_ofd.fulfillment_status,
    'RETURNED_TO_RESTAURANT',
    auth.uid(),
    v_actor_staff_id,
    jsonb_build_object('reason', v_reason, 'notes', v_notes)
  );

  return true;
end;
$$;

grant execute on function public.fulfillment_return_to_restaurant(uuid, text, text) to authenticated;
revoke execute on function public.fulfillment_return_to_restaurant(uuid, text, text) from anon, public;

-- Allow reassignment after a failed or returned delivery so the same order can be retried safely.
create or replace function public.fulfillment_assign_rider(p_order_id uuid, p_staff_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_new_status text;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'DELIVERY' then raise exception 'Delivery order not found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.status in ('CANCELLED','COMPLETED') then raise exception 'Order cannot be assigned in its current state'; end if;
  if v_ofd.fulfillment_status not in ('WAITING_FOR_DRIVER','ASSIGNED','READY_FOR_DISPATCH','DELIVERY_FAILED','RETURNED_TO_RESTAURANT') then
    raise exception 'Delivery is not eligible for assignment';
  end if;
  if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'ASSIGN_DELIVERY') then
    raise exception 'Permission denied: ASSIGN_DELIVERY required' using errcode = '42501';
  end if;

  select s.* into v_staff from public.staff s
  where s.id = p_staff_id and s.branch_id = v_ofd.branch_id and s.active = true
  limit 1;
  if v_staff.id is null then raise exception 'Active delivery staff member not found in this branch'; end if;
  if v_staff.role <> 'OWNER' and not exists (
    select 1 from public.staff_permissions sp
    where sp.staff_id = v_staff.id and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true
  ) then
    raise exception 'Selected staff member is not authorized for delivery work';
  end if;

  if v_ofd.assigned_staff_id = p_staff_id then return true; end if;

  v_new_status := case when v_order.status = 'READY' then 'READY_FOR_DISPATCH' else 'ASSIGNED' end;
  if v_ofd.fulfillment_status in ('DELIVERY_FAILED', 'RETURNED_TO_RESTAURANT') then
    v_new_status := 'WAITING_FOR_DRIVER';
  end if;

  update public.order_fulfillment_details
  set assigned_staff_id = p_staff_id,
      assigned_at = coalesce(assigned_at, now()),
      fulfillment_status = v_new_status,
      failure_reason = case when v_ofd.fulfillment_status = 'DELIVERY_FAILED' then failure_reason else null end,
      failed_at = case when v_ofd.fulfillment_status = 'DELIVERY_FAILED' then failed_at else null end,
      returned_at = case when v_ofd.fulfillment_status = 'RETURNED_TO_RESTAURANT' then null else returned_at end,
      return_reason = case when v_ofd.fulfillment_status = 'RETURNED_TO_RESTAURANT' then null else return_reason end,
      return_notes = case when v_ofd.fulfillment_status = 'RETURNED_TO_RESTAURANT' then null else return_notes end,
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (
    p_order_id,
    v_ofd.branch_id,
    'RIDER_ASSIGNED',
    v_ofd.fulfillment_status,
    v_new_status,
    auth.uid(),
    (select id from public.staff where user_id = auth.uid() and branch_id = v_ofd.branch_id order by created_at limit 1),
    jsonb_build_object('assigned_staff_id', p_staff_id, 'rider_name', coalesce(v_staff.display_name, (select pr.full_name from public.profiles pr where pr.id = v_staff.user_id), 'Staff'))
  );
  return true;
end;
$$;

grant execute on function public.fulfillment_assign_rider(uuid, uuid) to authenticated;
revoke execute on function public.fulfillment_assign_rider(uuid, uuid) from anon, public;

create or replace function public.fulfillment_collect_payment(
  p_order_id uuid,
  p_method text,
  p_amount numeric,
  p_reference text default null,
  p_reference_source text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_settings public.branch_ordering_settings%rowtype;
  v_actor public.staff%rowtype;
  v_method text := upper(trim(coalesce(p_method, '')));
  v_reference text := nullif(left(trim(coalesce(p_reference, '')), 128), '');
  v_reference_source text := upper(trim(coalesce(p_reference_source, '')));
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if v_method not in ('CASH','UPI') then raise exception 'Payment method must be CASH or UPI'; end if;
  if v_method = 'UPI' and v_reference is null then
    raise exception 'UPI collections require a UTR or payment reference';
  end if;
  if v_reference_source is not null and v_reference_source not in ('CUSTOMER_REPORTED','STAFF_CONFIRMED','PROVIDER_VERIFIED') then
    raise exception 'Unsupported payment reference source';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;
  if v_order.status = 'CANCELLED' or v_order.payment_status = 'REFUNDED' then raise exception 'Cancelled or refunded orders cannot collect payment'; end if;

  select * into v_actor from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_order.branch_id
  order by (s.id = v_ofd.assigned_staff_id) desc,
    case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end,
    s.created_at limit 1;

  if not (
    public.current_user_has_permission_for_branch(v_order.branch_id, 'MANAGE_DELIVERY')
    or public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS')
    or exists (
      select 1 from public.staff rider
      where rider.id = v_ofd.assigned_staff_id and rider.user_id = auth.uid()
        and rider.branch_id = v_order.branch_id and rider.active = true
        and exists (select 1 from public.staff_permissions sp where sp.staff_id = rider.id and sp.permission = 'COLLECT_DELIVERY_PAYMENT' and sp.allowed = true)
    )
  ) then
    raise exception 'Only finance or authorized delivery staff can collect payment' using errcode = '42501';
  end if;

  if p_amount is null or round(p_amount, 2) <> round(v_order.total, 2) then
    raise exception 'Collected amount must exactly match the order total';
  end if;

  if v_order.payment_status = 'PAID' then
    if v_ofd.payment_collected_at is not null then return true; end if;
    raise exception 'Payment was already settled through another payment flow';
  end if;

  v_settings := public.ensure_branch_ordering_settings(v_order.branch_id);
  if v_ofd.fulfillment_type = 'DELIVERY' and v_method = 'CASH' and coalesce((v_settings.delivery_settings->>'cod_enabled')::boolean, false) = false then
    raise exception 'Cash on delivery is not enabled for this branch';
  end if;
  if v_ofd.fulfillment_type = 'DELIVERY' and v_method = 'UPI' and coalesce((v_settings.delivery_settings->>'upi_on_delivery_enabled')::boolean, false) = false then
    raise exception 'UPI on delivery is not enabled for this branch';
  end if;

  insert into public.payment_transactions(order_id, branch_id, provider, amount, status, method, raw_metadata)
  values (
    v_order.id,
    v_order.branch_id,
    'MANUAL',
    v_order.total,
    'PAID',
    v_method,
    jsonb_build_object(
      'fulfillment_type', v_ofd.fulfillment_type,
      'actor_user_id', auth.uid(),
      'source', 'FULFILLMENT_COLLECTION',
      'payment_reference', v_reference,
      'reference_source', coalesce(v_reference_source, 'STAFF_CONFIRMED')
    )
  );

  update public.orders
  set payment_status = 'PAID', payment_method = v_ofd.fulfillment_type || '_' || v_method,
      paid_at = coalesce(paid_at, now()), updated_at = now()
  where id = v_order.id;

  update public.order_fulfillment_details
  set payment_collected_at = now(),
      payment_collected_by = v_actor.id,
      payment_collection_method = v_method,
      payment_collected_amount = v_order.total,
      payment_reference = v_reference,
      reference_source = coalesce(v_reference_source, 'STAFF_CONFIRMED'),
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (
    v_order.id,
    v_order.branch_id,
    'PAYMENT_COLLECTED',
    v_order.payment_status::text,
    'PAID',
    auth.uid(),
    v_actor.id,
    jsonb_build_object('method', v_method, 'amount', v_order.total, 'payment_reference', v_reference, 'reference_source', coalesce(v_reference_source, 'STAFF_CONFIRMED'))
  );

  if v_ofd.fulfillment_status in ('DELIVERED','PICKED_UP') then
    perform public.transition_order_status(v_order.id, 'COMPLETED'::public.order_status);
  end if;

  return true;
end;
$$;

grant execute on function public.fulfillment_collect_payment(uuid, text, numeric, text, text) to authenticated;
revoke execute on function public.fulfillment_collect_payment(uuid, text, numeric, text, text) from anon, public;

commit;

select pg_notify('pgrst', 'reload schema');
