-- TABLELY BUILD 35.13 — Atomic pickup handover, payment collection, and completion
-- The staff member confirms an actually received cash/UPI payment during handover.

begin;

drop function if exists public.fulfillment_confirm_pickup(uuid, text, boolean, text, text, text);
drop function if exists public.fulfillment_confirm_pickup(uuid, text, boolean, text);
drop function if exists public.fulfillment_confirm_pickup(uuid, text, boolean);

create function public.fulfillment_confirm_pickup(
  p_order_id uuid,
  p_pickup_code text default null,
  p_manager_override boolean default false,
  p_override_reason text default null,
  p_payment_method text default null,
  p_payment_reference text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_actor_staff_id uuid;
  v_code_hash text;
  v_method text := upper(trim(coalesce(p_payment_method, '')));
  v_reference text := nullif(left(trim(coalesce(p_payment_reference, '')), 128), '');
  v_was_picked_up boolean;
  v_collect_payment boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_ofd
  from public.order_fulfillment_details ofd
  where ofd.order_id = p_order_id
  for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'PICKUP' then
    raise exception 'Pickup order not found';
  end if;

  select * into v_order
  from public.orders o
  where o.id = p_order_id
  for update;
  if v_order.id is null then raise exception 'Order not found' using errcode = 'P0002'; end if;
  if v_order.status in ('CANCELLED', 'REJECTED') then
    raise exception 'Cancelled or rejected orders cannot be handed over';
  end if;

  if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_PICKUP') then
    raise exception 'Permission denied: MANAGE_PICKUP required' using errcode = '42501';
  end if;

  v_was_picked_up := v_ofd.fulfillment_status = 'PICKED_UP';
  if v_order.status = 'COMPLETED' and v_was_picked_up and v_order.payment_status = 'PAID' then
    return true;
  end if;
  if not v_was_picked_up then
    if v_ofd.fulfillment_status <> 'READY_FOR_PICKUP' then
      raise exception 'Pickup is not ready for handover';
    end if;
    if v_order.status <> 'READY'::public.order_status then
      raise exception 'Order must be READY before pickup handover';
    end if;
  elsif v_order.status not in ('READY', 'SERVED') then
    raise exception 'Pickup order cannot be completed in its current state';
  end if;

  select s.id into v_actor_staff_id
  from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by s.created_at
  limit 1;

  if not v_was_picked_up then
    if p_manager_override then
      if length(trim(coalesce(p_override_reason, ''))) < 8 then
        raise exception 'Manager override requires an audit reason of at least 8 characters';
      end if;
    else
      if v_ofd.pickup_code_hash is null or v_ofd.pickup_code_used_at is not null
        or v_ofd.pickup_code_expires_at is null or v_ofd.pickup_code_expires_at <= now()
        or v_ofd.pickup_verification_attempts >= 5 then
        update public.order_fulfillment_details
        set pickup_verification_attempts = 5, updated_at = now()
        where id = v_ofd.id;
        return false;
      end if;
      v_code_hash := crypt(p_order_id::text || ':' || trim(coalesce(p_pickup_code, '')), v_ofd.pickup_code_hash);
      if v_code_hash is distinct from v_ofd.pickup_code_hash then
        update public.order_fulfillment_details
        set pickup_verification_attempts = least(pickup_verification_attempts + 1, 5), updated_at = now()
        where id = v_ofd.id;
        return false;
      end if;
    end if;
  end if;

  v_collect_payment := v_order.payment_status <> 'PAID'::public.payment_status;
  if v_collect_payment then
    if upper(coalesce(v_order.payment_method, '')) not in ('PICKUP_CASH', 'PICKUP_UPI') then
      raise exception 'This pickup order is not eligible for manual payment collection';
    end if;
    if v_method not in ('CASH', 'UPI') then
      raise exception 'Choose Cash or UPI after receiving the payment';
    end if;
    if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'PAYMENTS') then
      raise exception 'Permission denied: PAYMENTS required to collect pickup payment' using errcode = '42501';
    end if;
    if v_method = 'UPI' and v_reference is null then
      raise exception 'UPI handover requires a UTR or payment reference';
    end if;
    if v_ofd.payment_collected_at is not null then
      raise exception 'Pickup payment collection is already recorded; refresh the order';
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
        'fulfillment_type', 'PICKUP',
        'actor_user_id', auth.uid(),
        'source', 'PICKUP_HANDOVER',
        'payment_reference', v_reference,
        'reference_source', case when v_reference is null then null else 'STAFF_CONFIRMED' end
      )
    );

    update public.orders
    set payment_status = 'PAID',
        payment_method = 'PICKUP_' || v_method,
        paid_at = coalesce(paid_at, now()),
        updated_at = now()
    where id = v_order.id;

    update public.order_fulfillment_details
    set payment_collected_at = now(),
        payment_collected_by = v_actor_staff_id,
        payment_collection_method = v_method,
        payment_collected_amount = v_order.total,
        payment_reference = v_reference,
        reference_source = case when v_reference is null then null else 'STAFF_CONFIRMED' end,
        updated_at = now()
    where id = v_ofd.id;

    insert into public.order_fulfillment_events(
      order_id, branch_id, event_type, from_status, to_status,
      actor_user_id, actor_staff_id, metadata
    ) values (
      v_order.id, v_order.branch_id, 'PAYMENT_COLLECTED', v_order.payment_status::text, 'PAID',
      auth.uid(), v_actor_staff_id,
      jsonb_build_object('method', v_method, 'amount', v_order.total,
        'payment_reference', v_reference, 'source', 'PICKUP_HANDOVER')
    );
  end if;

  if not v_was_picked_up then
    update public.order_fulfillment_details
    set fulfillment_status = 'PICKED_UP',
        picked_up_at = now(),
        pickup_code_hash = null,
        pickup_code_used_at = now(),
        updated_at = now()
    where id = v_ofd.id;

    insert into public.order_fulfillment_events(
      order_id, branch_id, event_type, from_status, to_status,
      actor_user_id, actor_staff_id, metadata
    ) values (
      v_order.id, v_ofd.branch_id, 'PICKED_UP', v_ofd.fulfillment_status, 'PICKED_UP',
      auth.uid(), v_actor_staff_id,
      jsonb_build_object(
        'manager_override', p_manager_override,
        'override_reason', case when p_manager_override then left(trim(p_override_reason), 500) end,
        'payment_method', case when v_collect_payment then v_method else null end
      )
    );
  end if;

  if v_order.payment_status = 'PAID' or v_collect_payment then
    perform public.transition_order_status(p_order_id, 'COMPLETED'::public.order_status);
  end if;
  return true;
end;
$$;

revoke all on function public.fulfillment_confirm_pickup(uuid, text, boolean, text, text, text) from public, anon;
grant execute on function public.fulfillment_confirm_pickup(uuid, text, boolean, text, text, text) to authenticated;

notify pgrst, 'reload schema';
commit;