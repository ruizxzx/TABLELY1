-- TABLELY — ALLOW STAFF SETTLEMENT OF SERVED PAY-LATER ORDERS
--
-- The Orders tab uses complete_order_with_manual_payment() for Cash/UPI
-- settlement. Its original method guard only allowed counter methods, so a
-- served PAY_LATER order returned a generic settlement failure.

begin;

create or replace function public.complete_order_with_manual_payment(
  p_order_id uuid,
  p_method text,
  p_reference text default null
)
returns table(
  id uuid,
  order_number bigint,
  table_id uuid,
  branch_id uuid,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  paid_at timestamptz,
  total numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_method text := upper(trim(coalesce(p_method, '')));
  v_allowed boolean := false;
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

  select st.* into v_staff
  from public.staff st
  where st.user_id = v_user
    and st.active = true
    and (st.branch_id = v_order.branch_id or st.role = 'OWNER')
    and exists (
      select 1 from public.branches b
      where b.id = v_order.branch_id
        and b.organization_id = st.organization_id
    )
  order by case when st.role = 'OWNER' then 0 when st.role = 'MANAGER' then 1 else 2 end,
           st.created_at
  limit 1;

  v_allowed :=
    v_staff.id is not null
    and public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
    and public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS')
    and v_staff.role in ('OWNER', 'MANAGER', 'WAITER');
  if not v_allowed then
    raise exception 'You are not authorized to complete this order' using errcode = '42501';
  end if;

  if v_order.status <> 'SERVED'::public.order_status then
    raise exception 'Only served orders can be completed' using errcode = 'P0001';
  end if;
  if v_order.payment_status = 'PAID'::public.payment_status then
    raise exception 'Order is already paid; use normal completion' using errcode = 'P0001';
  end if;
  if v_order.payment_method is not null
     and v_order.payment_method not in ('PAY_AT_COUNTER', 'PAY_LATER', 'CASH', 'UPI') then
    raise exception 'This order is not eligible for manual settlement' using errcode = 'P0001';
  end if;
  if v_method not in ('CASH', 'UPI') then
    raise exception 'Unsupported manual payment method' using errcode = 'P0001';
  end if;

  update public.orders
  set payment_status = 'PAID',
      payment_method = v_method,
      paid_at = coalesce(paid_at, now()),
      status = 'COMPLETED',
      updated_at = now()
  where id = v_order.id;

  insert into public.payment_transactions(
    order_id, branch_id, provider, amount, status, method, raw_metadata
  )
  values(
    v_order.id,
    v_order.branch_id,
    'MANUAL',
    v_order.total,
    'PAID',
    v_method,
    jsonb_build_object(
      'reference', nullif(left(trim(coalesce(p_reference, '')), 120), ''),
      'actor_user_id', v_user::text,
      'completion', 'ORDER_PAGE',
      'original_payment_method', v_order.payment_method
    )
  );

  insert into public.order_events(
    order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata
  )
  values(
    v_order.id,
    v_order.branch_id,
    'PAYMENT_MARKED_PAID_AND_ORDER_COMPLETED',
    v_order.status::text,
    'COMPLETED',
    v_user,
    jsonb_build_object('method', v_method, 'original_payment_method', v_order.payment_method)
  );

  return query
  select ord.id, ord.order_number, ord.table_id, ord.branch_id, ord.status,
         ord.payment_status, ord.payment_method, ord.paid_at, ord.total
  from public.orders ord
  where ord.id = v_order.id;
end;
$$;

grant execute on function public.complete_order_with_manual_payment(uuid, text, text) to authenticated;
revoke execute on function public.complete_order_with_manual_payment(uuid, text, text) from anon, public;
alter function public.complete_order_with_manual_payment(uuid, text, text) set search_path = public;

commit;

notify pgrst, 'reload schema';
