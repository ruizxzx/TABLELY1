-- TABLELY BUILD 35.15 — Repair rider assignment name fallback
-- Replaces stale deployed function bodies that reference staff.full_name.

begin;

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
  v_actor_staff_id uuid;
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
  if v_order.status in ('CANCELLED', 'COMPLETED') then
    raise exception 'Order cannot be assigned in its current state';
  end if;
  if v_ofd.fulfillment_status not in (
    'WAITING_FOR_DRIVER', 'ASSIGNED', 'READY_FOR_DISPATCH', 'DELIVERY_FAILED', 'RETURNED_TO_RESTAURANT'
  ) then
    raise exception 'Delivery is not eligible for assignment';
  end if;
  if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'ASSIGN_DELIVERY') then
    raise exception 'Permission denied: ASSIGN_DELIVERY required' using errcode = '42501';
  end if;

  select s.* into v_staff
  from public.staff s
  where s.id = p_staff_id and s.branch_id = v_ofd.branch_id and s.active = true
  limit 1;
  if v_staff.id is null then
    raise exception 'Active delivery staff member not found in this branch';
  end if;
  if v_staff.role <> 'OWNER' and not exists (
    select 1 from public.staff_permissions sp
    where sp.staff_id = v_staff.id
      and sp.permission = 'UPDATE_DELIVERY_STATUS'
      and sp.allowed = true
  ) then
    raise exception 'Selected staff member is not authorized for delivery work';
  end if;

  if v_ofd.assigned_staff_id = p_staff_id then return true; end if;

  v_new_status := case when v_order.status = 'READY' then 'READY_FOR_DISPATCH' else 'ASSIGNED' end;
  if v_ofd.fulfillment_status in ('DELIVERY_FAILED', 'RETURNED_TO_RESTAURANT') then
    v_new_status := 'WAITING_FOR_DRIVER';
  end if;

  select s.id into v_actor_staff_id
  from public.staff s
  where s.user_id = auth.uid() and s.branch_id = v_ofd.branch_id and s.active = true
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

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

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status,
    actor_user_id, actor_staff_id, metadata
  ) values (
    p_order_id,
    v_ofd.branch_id,
    'RIDER_ASSIGNED',
    v_ofd.fulfillment_status,
    v_new_status,
    auth.uid(),
    v_actor_staff_id,
    jsonb_build_object(
      'assigned_staff_id', p_staff_id,
      'rider_name', coalesce(
        v_staff.display_name,
        (select profile.full_name from public.profiles profile where profile.id = v_staff.user_id),
        'Staff'
      )
    )
  );

  return true;
end;
$$;

revoke all on function public.fulfillment_assign_rider(uuid, uuid) from public, anon;
grant execute on function public.fulfillment_assign_rider(uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
commit;