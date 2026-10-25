-- TABLELY BUILD 35.17 — Restore delivery OTP confirmation RPC
-- Forward-only recovery for databases where PostgREST cannot find the RPC.

begin;

drop function if exists public.fulfillment_confirm_delivered(uuid, text, boolean, text);
drop function if exists public.fulfillment_confirm_delivered(uuid, text, boolean);
create function public.fulfillment_confirm_delivered(
  p_order_id uuid,
  p_delivery_otp text default null,
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
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'DELIVERY' then
    raise exception 'Delivery order not found';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.id is null then raise exception 'Delivery order not found'; end if;

  select s.id into v_actor_staff_id
  from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by (s.id = v_ofd.assigned_staff_id) desc,
    case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end,
    s.created_at
  limit 1;

  if p_manager_override then
    if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_DELIVERY') then
      raise exception 'Manager override requires MANAGE_DELIVERY permission' using errcode = '42501';
    end if;
    if length(trim(coalesce(p_override_reason, ''))) < 8 then
      raise exception 'Manager override requires an audit reason of at least 8 characters';
    end if;
  else
    if not exists (
      select 1 from public.staff rider
      where rider.id = v_ofd.assigned_staff_id
        and rider.user_id = auth.uid()
        and rider.branch_id = v_ofd.branch_id
        and rider.active = true
        and exists (
          select 1 from public.staff_permissions sp
          where sp.staff_id = rider.id
            and sp.permission = 'UPDATE_DELIVERY_STATUS'
            and sp.allowed = true
        )
    ) then
      raise exception 'Only the assigned authorized delivery person can confirm delivery' using errcode = '42501';
    end if;
  end if;

  if v_ofd.fulfillment_status = 'DELIVERED' then return true; end if;
  if v_ofd.fulfillment_status <> 'OUT_FOR_DELIVERY' then
    raise exception 'Only dispatched orders can be delivered';
  end if;
  if v_order.status in ('CANCELLED', 'COMPLETED') then
    raise exception 'Order cannot be delivered in its current state';
  end if;

  if not p_manager_override then
    if v_ofd.delivery_otp_hash is null
      or v_ofd.delivery_otp_used_at is not null
      or v_ofd.delivery_otp_expires_at is null
      or v_ofd.delivery_otp_expires_at <= now()
      or v_ofd.delivery_verification_attempts >= 5 then
      update public.order_fulfillment_details
      set delivery_verification_attempts = 5, updated_at = now()
      where id = v_ofd.id;
      return false;
    end if;

    v_code_hash := crypt(p_order_id::text || ':' || trim(coalesce(p_delivery_otp, '')), v_ofd.delivery_otp_hash);
    if v_code_hash is distinct from v_ofd.delivery_otp_hash then
      update public.order_fulfillment_details
      set delivery_verification_attempts = least(delivery_verification_attempts + 1, 5), updated_at = now()
      where id = v_ofd.id;
      return false;
    end if;
  end if;

  update public.order_fulfillment_details
  set fulfillment_status = 'DELIVERED',
      delivered_at = now(),
      delivery_otp_hash = null,
      delivery_otp_used_at = now(),
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status,
    actor_user_id, actor_staff_id, metadata
  ) values (
    p_order_id, v_ofd.branch_id, 'DELIVERED', v_ofd.fulfillment_status, 'DELIVERED',
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

revoke all on function public.fulfillment_confirm_delivered(uuid, text, boolean, text) from public, anon;
grant execute on function public.fulfillment_confirm_delivered(uuid, text, boolean, text) to authenticated;
notify pgrst, 'reload schema';
commit;