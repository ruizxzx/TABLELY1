-- TABLELY BUILD 35.14 — Normalize optional fulfillment payment references
-- Cash collection has no UPI reference source; empty input must remain NULL.

begin;

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
  v_reference_source text := nullif(upper(trim(coalesce(p_reference_source, ''))), '');
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if v_method not in ('CASH','UPI') then raise exception 'Payment method must be CASH or UPI'; end if;
  if v_method = 'UPI' and v_reference is null then
    raise exception 'UPI collections require a UTR or payment reference';
  end if;
  if v_reference_source is not null and v_reference_source not in ('CUSTOMER_REPORTED','STAFF_CONFIRMED','PROVIDER_VERIFIED') then
    raise exception 'Unsupported payment reference source';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select * into v_ofd from public.order_fulfillment_details ofd where ofd.order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;
  if v_order.status = 'CANCELLED' or v_order.payment_status = 'REFUNDED' then
    raise exception 'Cancelled or refunded orders cannot collect payment';
  end if;

  select * into v_actor from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_order.branch_id
  order by (s.id = v_ofd.assigned_staff_id) desc,
    case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end,
    s.created_at
  limit 1;

  if not (
    public.current_user_has_permission_for_branch(v_order.branch_id, 'MANAGE_DELIVERY')
    or public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS')
    or exists (
      select 1 from public.staff rider
      where rider.id = v_ofd.assigned_staff_id and rider.user_id = auth.uid()
        and rider.branch_id = v_order.branch_id and rider.active = true
        and exists (
          select 1 from public.staff_permissions sp
          where sp.staff_id = rider.id and sp.permission = 'COLLECT_DELIVERY_PAYMENT' and sp.allowed = true
        )
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
  if v_ofd.fulfillment_type = 'DELIVERY' and v_method = 'CASH'
    and coalesce((v_settings.delivery_settings->>'cod_enabled')::boolean, false) = false then
    raise exception 'Cash on delivery is not enabled for this branch';
  end if;
  if v_ofd.fulfillment_type = 'DELIVERY' and v_method = 'UPI'
    and coalesce((v_settings.delivery_settings->>'upi_on_delivery_enabled')::boolean, false) = false then
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
  set payment_status = 'PAID',
      payment_method = v_ofd.fulfillment_type || '_' || v_method,
      paid_at = coalesce(paid_at, now()),
      updated_at = now()
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

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status,
    actor_user_id, actor_staff_id, metadata
  ) values (
    v_order.id,
    v_order.branch_id,
    'PAYMENT_COLLECTED',
    v_order.payment_status::text,
    'PAID',
    auth.uid(),
    v_actor.id,
    jsonb_build_object(
      'method', v_method,
      'amount', v_order.total,
      'payment_reference', v_reference,
      'reference_source', coalesce(v_reference_source, 'STAFF_CONFIRMED')
    )
  );

  if v_ofd.fulfillment_status in ('DELIVERED','PICKED_UP') then
    perform public.transition_order_status(v_order.id, 'COMPLETED'::public.order_status);
  end if;

  return true;
end;
$$;

grant execute on function public.fulfillment_collect_payment(uuid, text, numeric, text, text) to authenticated;
revoke execute on function public.fulfillment_collect_payment(uuid, text, numeric, text, text) from anon, public;
notify pgrst, 'reload schema';
commit;