-- TABLELY BUILD 35.11 — Restore order details and pickup handoff RPCs
-- Forward-only recovery for databases missing Build 35.3 RPCs from PostgREST.

begin;

create or replace function public.get_branch_order_customer_details(
  p_branch_id uuid,
  p_order_ids uuid[]
)
returns table (
  order_id uuid,
  customer_name text,
  customer_phone text,
  customer_note text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_can_view_customer boolean;
  v_can_view_notes boolean;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_branch_id is null or coalesce(array_length(p_order_ids, 1), 0) = 0
    or array_length(p_order_ids, 1) > 500 then
    raise exception 'A branch and between 1 and 500 order IDs are required';
  end if;
  if not (
    public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_ORDERS')
    or public.current_user_has_permission_for_branch(p_branch_id, 'KITCHEN_ACCESS')
    or public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_ONLINE_ORDERS')
    or public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_CUSTOMER_DETAILS')
  ) then
    raise exception 'Order access denied' using errcode = '42501';
  end if;

  v_can_view_customer := public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_CUSTOMER_DETAILS');
  v_can_view_notes := v_can_view_customer
    or public.current_user_has_permission_for_branch(p_branch_id, 'KITCHEN_ACCESS');

  return query
  select o.id,
    case when v_can_view_customer then o.customer_name else null end,
    case when v_can_view_customer then o.customer_phone else null end,
    case when v_can_view_notes then o.customer_note else null end
  from public.orders o
  where o.branch_id = p_branch_id and o.id = any(p_order_ids);
end;
$$;
revoke all on function public.get_branch_order_customer_details(uuid, uuid[]) from public, anon;
grant execute on function public.get_branch_order_customer_details(uuid, uuid[]) to authenticated;

drop function if exists public.fulfillment_confirm_pickup(uuid, text, boolean, text);
drop function if exists public.fulfillment_confirm_pickup(uuid, text, boolean);
create function public.fulfillment_confirm_pickup(
  p_order_id uuid,
  p_pickup_code text default null,
  p_manager_override boolean default false,
  p_override_reason text default null
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

  select * into v_order from public.orders o where o.id = p_order_id for update;
  select s.id into v_actor_staff_id
  from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by s.created_at
  limit 1;

  if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_PICKUP') then
    raise exception 'Permission denied: MANAGE_PICKUP required' using errcode = '42501';
  end if;
  if v_ofd.fulfillment_status = 'PICKED_UP' then return true; end if;
  if v_ofd.fulfillment_status <> 'READY_FOR_PICKUP' then
    raise exception 'Pickup is not ready for handover';
  end if;
  if v_order.status <> 'READY'::public.order_status then
    raise exception 'Order must be READY before pickup handover';
  end if;
  if v_order.status in ('CANCELLED', 'COMPLETED') then
    raise exception 'Order cannot be picked up in its current state';
  end if;

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

  update public.order_fulfillment_details
  set fulfillment_status = 'PICKED_UP',
      picked_up_at = now(),
      pickup_code_hash = null,
      pickup_code_used_at = now(),
      updated_at = now()
  where id = v_ofd.id;
  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata
  ) values (
    p_order_id, v_ofd.branch_id, 'PICKED_UP', v_ofd.fulfillment_status, 'PICKED_UP',
    auth.uid(), v_actor_staff_id,
    jsonb_build_object(
      'manager_override', p_manager_override,
      'override_reason', case when p_manager_override then left(trim(p_override_reason), 500) end
    )
  );
  if v_order.payment_status = 'PAID' then
    perform public.transition_order_status(p_order_id, 'COMPLETED'::public.order_status);
  end if;
  return true;
end;
$$;
revoke all on function public.fulfillment_confirm_pickup(uuid, text, boolean, text) from public, anon;
grant execute on function public.fulfillment_confirm_pickup(uuid, text, boolean, text) to authenticated;

notify pgrst, 'reload schema';
commit;