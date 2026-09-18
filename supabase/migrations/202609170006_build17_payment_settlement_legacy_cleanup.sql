-- TABLELY BUILD 17.2 — payment settlement safety + legacy PAY_NOW cleanup
-- Additive only. Do not replace the existing Build 13/14 payment RPCs.
--
-- Two operational edge cases are handled here:
-- 1) The Payments screen must never manually settle PAY_NOW orders.
-- 2) Legacy data can contain a PAY_AT_COUNTER order that reached COMPLETED
--    while payment_status remained PENDING. Such an order is not "paid again";
--    it still needs its outstanding counter payment recorded.
--
-- Existing mark_order_paid() is intentionally preserved. The Payments screen
-- uses the narrower counter-only RPC below.

begin;

create or replace function public.settle_counter_payment(
  p_order_id uuid,
  p_method text,
  p_reference text default null
)
returns table (
  id uuid,
  payment_status public.payment_status,
  payment_method text,
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_method text := upper(trim(coalesce(p_method, 'CASH')));
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
    and s.active = true
    and (s.branch_id = v_order.branch_id or s.role = 'OWNER')
    and exists (
      select 1
      from public.branches b
      where b.id = v_order.branch_id
        and b.organization_id = s.organization_id
    )
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end,
           s.created_at
  limit 1;

  if v_staff.id is null
     or not public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS') then
    raise exception 'You are not authorized to mark payments' using errcode = '42501';
  end if;

  if v_method not in ('CASH', 'UPI', 'CARD') then
    raise exception 'Unsupported manual payment method' using errcode = 'P0001';
  end if;

  -- Only counter orders can be settled here. Online payments must be finalized
  -- by the existing authoritative online-payment flow.
  if v_order.payment_method is null
     or upper(v_order.payment_method) <> 'PAY_AT_COUNTER' then
    if v_order.payment_method = 'PAY_NOW'
       or left(coalesce(v_order.payment_method, ''), 8) = 'PAY_NOW:' then
      raise exception 'Online orders must be settled by the online payment flow' using errcode = 'P0001';
    end if;
    raise exception 'This order is not a pay-at-counter order' using errcode = 'P0001';
  end if;

  if v_order.status in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status) then
    raise exception 'Cancelled or rejected orders cannot be marked paid' using errcode = 'P0001';
  end if;

  -- Idempotent for an already-settled order. The row lock above prevents two
  -- simultaneous staff actions from creating two manual payment records.
  if v_order.payment_status = 'PAID'::public.payment_status then
    return query
    select o.id, o.payment_status, o.payment_method, o.paid_at
    from public.orders o
    where o.id = v_order.id;
    return;
  end if;

  -- COMPLETED + UNPAID can exist in older databases because the completion
  -- rule was tightened after those rows were created. It is safe to settle the
  -- outstanding counter payment without changing the historical order state.
  update public.orders o
  set payment_status = 'PAID',
      payment_method = v_method,
      paid_at = coalesce(o.paid_at, now()),
      updated_at = now()
  where o.id = v_order.id
    and o.payment_status <> 'PAID'::public.payment_status;

  insert into public.payment_transactions
    (order_id, branch_id, provider, amount, status, method, raw_metadata)
  values
    (
      v_order.id,
      v_order.branch_id,
      'MANUAL',
      v_order.total,
      'PAID',
      v_method,
      jsonb_build_object(
        'reference', nullif(left(trim(coalesce(p_reference, '')), 120), ''),
        'actor_user_id', v_user::text,
        'source', 'BUILD17_COUNTER_SETTLEMENT'
      )
    );

  insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
  values (
    v_order.id,
    v_order.branch_id,
    'PAYMENT_MARKED_PAID',
    v_user,
    jsonb_build_object('method', v_method, 'source', 'BUILD17_COUNTER_SETTLEMENT')
  );

  return query
  select o.id, o.payment_status, o.payment_method, o.paid_at
  from public.orders o
  where o.id = v_order.id;
end;
$$;

grant execute on function public.settle_counter_payment(uuid, text, text) to authenticated;
revoke execute on function public.settle_counter_payment(uuid, text, text) from anon, public;
alter function public.settle_counter_payment(uuid, text, text) set search_path = public;

-- Managers/authorized payment staff can trigger a safe server-side cleanup of
-- expired legacy PAY_NOW rows in their own branch. This does not cancel a
-- currently valid payment and cannot touch another branch.
create or replace function public.expire_branch_paynow_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_branch uuid;
  v_count integer := 0;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select s.branch_id into v_branch
  from public.staff s
  where s.user_id = v_user
    and s.active = true
    and s.branch_id is not null
    and public.current_user_has_permission_for_branch(s.branch_id, 'PAYMENTS')
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end,
           s.created_at
  limit 1;

  if v_branch is null then
    raise exception 'You are not authorized to manage payments' using errcode = '42501';
  end if;

  update public.orders o
  set payment_status = 'FAILED'::public.payment_status,
      status = 'CANCELLED'::public.order_status,
      cancellation_reason = 'ONLINE_PAYMENT_TIMEOUT',
      cancelled_by = null,
      cancelled_at = coalesce(o.cancelled_at, now()),
      updated_at = now()
  where o.branch_id = v_branch
    and o.status = 'NEW'::public.order_status
    and o.payment_status = 'PENDING'::public.payment_status
    and (o.payment_method = 'PAY_NOW'
         or left(coalesce(o.payment_method, ''), 8) = 'PAY_NOW:')
    and o.payment_expires_at is not null
    and o.payment_expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.expire_branch_paynow_orders() to authenticated;
revoke execute on function public.expire_branch_paynow_orders() from anon, public;
alter function public.expire_branch_paynow_orders() set search_path = public;

commit;

select pg_notify('pgrst', 'reload schema');
