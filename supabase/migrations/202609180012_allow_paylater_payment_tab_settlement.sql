-- TABLELY — ALLOW PAY-LATER COLLECTION FROM THE PAYMENTS TAB
--
-- The Payments page uses settle_counter_payment(). Pay-Later orders are
-- intentionally excluded from the counter-only guard, but they still need a
-- staff-authorized manual collection path after service.

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
  v_is_pay_later boolean;
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

  v_is_pay_later := upper(coalesce(v_order.payment_method, '')) = 'PAY_LATER';

  if not v_is_pay_later
     and upper(coalesce(v_order.payment_method, '')) <> 'PAY_AT_COUNTER' then
    if upper(coalesce(v_order.payment_method, '')) = 'PAY_NOW'
       or left(coalesce(v_order.payment_method, ''), 8) = 'PAY_NOW:' then
      raise exception 'Online orders must be settled by the online payment flow' using errcode = 'P0001';
    end if;
    raise exception 'This order is not a pay-at-counter order' using errcode = 'P0001';
  end if;

  if v_order.status in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status) then
    raise exception 'Cancelled or rejected orders cannot be marked paid' using errcode = 'P0001';
  end if;

  if v_order.payment_status = 'PAID'::public.payment_status then
    return query
    select o.id, o.payment_status, o.payment_method, o.paid_at
    from public.orders o
    where o.id = v_order.id;
    return;
  end if;

  update public.orders o
  set payment_status = 'PAID',
      payment_method = v_method,
      paid_at = coalesce(o.paid_at, now()),
      updated_at = now()
  where o.id = v_order.id;

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
        'source', case when v_is_pay_later
          then 'BUILD23_PAY_LATER_PAYMENT_TAB'
          else 'BUILD17_COUNTER_SETTLEMENT'
        end,
        'original_payment_method', v_order.payment_method
      )
    );

  insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
  values (
    v_order.id,
    v_order.branch_id,
    'PAYMENT_MARKED_PAID',
    v_user,
    jsonb_build_object(
      'method', v_method,
      'source', case when v_is_pay_later
        then 'BUILD23_PAY_LATER_PAYMENT_TAB'
        else 'BUILD17_COUNTER_SETTLEMENT'
      end
    )
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

commit;

notify pgrst, 'reload schema';
