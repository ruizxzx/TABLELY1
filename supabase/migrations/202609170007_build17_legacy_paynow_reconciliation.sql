-- TABLELY BUILD 17.3 — legacy PAY_NOW reconciliation
-- Additive migration for orders created by the pre-payment-first flow.
-- These are rare historical records such as SERVED + PAY_NOW + PENDING.
-- New PAY_NOW orders are not eligible for this path.

begin;

alter table public.orders
  add column if not exists legacy_payment_reconciliation_required boolean not null default false;

create index if not exists orders_legacy_payment_reconciliation_idx
  on public.orders(branch_id, legacy_payment_reconciliation_required)
  where legacy_payment_reconciliation_required = true;

-- Mark only already-existing impossible legacy combinations at migration time.
-- New records cannot opt themselves into this exception path.
update public.orders
set legacy_payment_reconciliation_required = true
where legacy_payment_reconciliation_required = false
  and payment_status = 'PENDING'::public.payment_status
  and (payment_method = 'PAY_NOW' or left(coalesce(payment_method,''),8) = 'PAY_NOW:')
  and status in ('SERVED'::public.order_status, 'COMPLETED'::public.order_status);

create or replace function public.resolve_legacy_paynow_payment(
  p_order_id uuid,
  p_method text,
  p_reference text default null
)
returns table(
  id uuid,
  order_number bigint,
  status public.order_status,
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
  v_method text := upper(trim(coalesce(p_method,'')));
  v_ref text := nullif(left(trim(coalesce(p_reference,'')),120),'');
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode='42501';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Order not found' using errcode='P0002';
  end if;

  select s.* into v_staff
  from public.staff s
  where s.user_id = v_user
    and s.active = true
    and (s.branch_id = v_order.branch_id or s.role = 'OWNER')
    and exists (
      select 1 from public.branches b
      where b.id = v_order.branch_id
        and b.organization_id = s.organization_id
    )
  order by case when s.role='OWNER' then 0 when s.role='MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  if v_staff.id is null or not public.current_user_has_permission_for_branch(v_order.branch_id,'PAYMENTS') then
    raise exception 'You are not authorized to reconcile payments' using errcode='42501';
  end if;

  if not v_order.legacy_payment_reconciliation_required then
    raise exception 'This order is not eligible for legacy payment reconciliation' using errcode='P0001';
  end if;

  if v_order.payment_method is null
     or not (v_order.payment_method = 'PAY_NOW' or left(coalesce(v_order.payment_method,''),8) = 'PAY_NOW:') then
    raise exception 'This order is not a legacy PAY_NOW order' using errcode='P0001';
  end if;

  if v_order.payment_status = 'PAID'::public.payment_status then
    return query
      select o.id,o.order_number,o.status,o.payment_status,o.payment_method,o.paid_at
      from public.orders o where o.id=v_order.id;
    return;
  end if;

  if v_order.payment_status <> 'PENDING'::public.payment_status then
    raise exception 'Only pending legacy PAY_NOW payments can be reconciled' using errcode='P0001';
  end if;

  if v_order.status not in ('SERVED'::public.order_status,'COMPLETED'::public.order_status) then
    raise exception 'Only fulfilled legacy orders can use this reconciliation path' using errcode='P0001';
  end if;

  if v_method not in ('CASH','UPI','CARD') then
    raise exception 'Unsupported reconciliation payment method' using errcode='P0001';
  end if;

  update public.orders o
  set payment_status = 'PAID'::public.payment_status,
      payment_method = v_method,
      paid_at = coalesce(o.paid_at,now()),
      legacy_payment_reconciliation_required = false,
      updated_at = now()
  where o.id = v_order.id
    and o.payment_status = 'PENDING'::public.payment_status
    and o.legacy_payment_reconciliation_required = true
  returning * into v_order;

  if v_order.id is null then
    raise exception 'Payment state changed before reconciliation' using errcode='P0001';
  end if;

  insert into public.payment_transactions
    (order_id, branch_id, provider, amount, status, method, raw_metadata)
  values
    (v_order.id, v_order.branch_id, 'MANUAL_LEGACY_RECONCILIATION', v_order.total, 'PAID', v_method,
     jsonb_build_object(
       'source','BUILD17_LEGACY_PAYNOW_RECONCILIATION',
       'reference',v_ref,
       'actor_user_id',v_user::text,
       'legacy_payment_reconciliation',true
     ));

  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'LEGACY_PAYMENT_RECONCILED',v_user,
         jsonb_build_object('method',v_method,'reference',v_ref,'source','BUILD17_LEGACY_PAYNOW_RECONCILIATION'));

  perform public.build17_sync_table_operational_state(v_order.table_id);

  return query
    select o.id,o.order_number,o.status,o.payment_status,o.payment_method,o.paid_at
    from public.orders o where o.id=v_order.id;
end;
$$;

grant execute on function public.resolve_legacy_paynow_payment(uuid,text,text) to authenticated;
revoke execute on function public.resolve_legacy_paynow_payment(uuid,text,text) from anon,public;
alter function public.resolve_legacy_paynow_payment(uuid,text,text) set search_path=public;

commit;
