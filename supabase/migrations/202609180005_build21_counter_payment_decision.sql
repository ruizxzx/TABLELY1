-- TABLELY BUILD 21 — COUNTER PAYMENT DECISION IN ORDERS
--
-- The manager confirms counter collection from the Orders tab. Received
-- records the existing manual payment and accepts the order. Not received
-- cancels the unpaid order with a customer-visible reason.

begin;

create or replace function public.decide_counter_payment(
  p_order_id uuid,
  p_received boolean,
  p_method text default null
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_user uuid := auth.uid();
  v_method text := upper(trim(coalesce(p_method, '')));
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if not public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
     or not public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS') then
    raise exception 'Payment and order permissions are required' using errcode = '42501';
  end if;

  if v_order.status <> 'NEW'::public.order_status
     or v_order.payment_method <> 'PAY_AT_COUNTER'
     or v_order.payment_status <> 'PENDING'::public.payment_status then
    raise exception 'This order is not awaiting counter payment' using errcode = 'P0001';
  end if;

  if not p_received then
    update public.orders
    set status = 'CANCELLED'::public.order_status,
        cancellation_reason = 'COUNTER_PAYMENT_NOT_RECEIVED',
        cancelled_by = v_user,
        cancelled_at = now(),
        updated_at = now()
    where id = v_order.id
    returning * into v_order;

    insert into public.order_events(
      order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata
    )
    values(
      v_order.id, v_order.branch_id, 'COUNTER_PAYMENT_NOT_RECEIVED',
      'NEW', 'CANCELLED', v_user,
      jsonb_build_object('reason', 'COUNTER_PAYMENT_NOT_RECEIVED')
    );

    perform public.build17_sync_table_operational_state(v_order.table_id);
    return v_order;
  end if;

  if v_method not in ('CASH', 'UPI') then
    raise exception 'Choose CASH or UPI for the received counter payment' using errcode = 'P0001';
  end if;

  -- Reuse the existing audited manual-payment path. It changes payment fields
  -- only and therefore leaves the order NEW until the transition below.
  perform public.mark_order_paid(v_order.id, v_method, null);

  -- The existing transition function preserves staff authorization, audit,
  -- realtime, and the normal NEW -> ACCEPTED lifecycle.
  perform public.transition_order_status(v_order.id, 'ACCEPTED'::public.order_status);

  select * into v_order from public.orders where id = p_order_id;
  return v_order;
end;
$$;

revoke execute on function public.decide_counter_payment(uuid, boolean, text) from anon, public;
grant execute on function public.decide_counter_payment(uuid, boolean, text) to authenticated;
alter function public.decide_counter_payment(uuid, boolean, text) set search_path = public;

commit;

notify pgrst, 'reload schema';
