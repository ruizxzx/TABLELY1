-- TABLELY BUILD 15 — Kitchen order acceptance control + cancellation-request role hardening
-- Additive, branch-scoped. Kitchen order acceptance defaults OFF so existing
-- branches do not silently gain a new operational capability.
begin;

-- ---------------------------------------------------------------------------
-- 1. Branch-scoped kitchen acceptance setting
-- ---------------------------------------------------------------------------
alter table public.branches
  add column if not exists kitchen_accept_orders boolean not null default false;

create index if not exists branches_kitchen_accept_orders_idx
  on public.branches(organization_id, kitchen_accept_orders);

-- Read the setting only for an authenticated user who can operate the branch.
create or replace function public.get_kitchen_order_acceptance(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(b.kitchen_accept_orders, false)
  from public.branches b
  where b.id = p_branch_id
    and public.current_user_is_branch_operator(p_branch_id);
$$;

grant execute on function public.get_kitchen_order_acceptance(uuid) to authenticated;
revoke execute on function public.get_kitchen_order_acceptance(uuid) from anon, public;

-- Branch Manager control. The manager must be assigned to the branch and have
-- the existing BRANCH_MANAGEMENT permission; Owners retain their normal bypass.
create or replace function public.set_kitchen_order_acceptance(
  p_branch_id uuid,
  p_enabled boolean
)
returns public.branches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch public.branches%rowtype;
  v_before boolean;
  v_user uuid := auth.uid();
  v_is_owner boolean := false;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select b.* into v_branch
  from public.branches b
  where b.id = p_branch_id
  for update;

  if v_branch.id is null then
    raise exception 'Branch not found' using errcode = 'P0002';
  end if;

  v_is_owner := public.is_org_owner(v_branch.organization_id)
    or exists (
      select 1 from public.staff s
      where s.organization_id = v_branch.organization_id
        and s.user_id = v_user
        and s.active = true
        and s.role = 'OWNER'::public.staff_role
    );

  if not v_is_owner
     and not public.is_branch_manager_with_permission(p_branch_id, 'BRANCH_MANAGEMENT') then
    raise exception 'Branch management permission required' using errcode = '42501';
  end if;

  -- Non-owners must be assigned to the target branch.
  if not v_is_owner and not exists (
    select 1
    from public.staff s
    where s.user_id = v_user
      and s.organization_id = v_branch.organization_id
      and s.branch_id = p_branch_id
      and s.active = true
      and s.role = 'MANAGER'::public.staff_role
  ) then
    raise exception 'You can only change kitchen acceptance for your assigned branch' using errcode = '42501';
  end if;

  v_before := v_branch.kitchen_accept_orders;

  update public.branches
  set kitchen_accept_orders = coalesce(p_enabled, false),
      updated_at = now()
  where id = p_branch_id
  returning * into v_branch;

  -- Use the existing audit table for now. Build 21 can consolidate this event
  -- into the unified audit system.
  insert into public.admin_audit_logs(
    actor_user_id, action, entity_type, entity_id, metadata
  )
  values (
    v_user,
    'KITCHEN_ACCEPT_ORDERS_SETTING_CHANGED',
    'BRANCH',
    v_branch.id,
    jsonb_build_object(
      'organization_id', v_branch.organization_id,
      'branch_id', v_branch.id,
      'before', v_before,
      'after', v_branch.kitchen_accept_orders
    )
  );

  return v_branch;
end;
$$;

grant execute on function public.set_kitchen_order_acceptance(uuid, boolean) to authenticated;
revoke execute on function public.set_kitchen_order_acceptance(uuid, boolean) from anon, public;

-- ---------------------------------------------------------------------------
-- 2. Kitchen acceptance is a separate gate from broad order editing.
--
-- NEW -> ACCEPTED:
--   OWNER / MANAGER / WAITER keep their existing behavior.
--   KITCHEN must additionally have:
--     * KITCHEN_ACCESS
--     * branch setting enabled
--
-- Do not broaden cancellation authority here.
-- ---------------------------------------------------------------------------
create or replace function public.transition_order_status(
  p_order_id uuid,
  p_new_status public.order_status
)
returns table(
  id uuid,
  order_number bigint,
  table_id uuid,
  branch_id uuid,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  subtotal numeric,
  tax numeric,
  discount numeric,
  total numeric,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_allowed boolean := false;
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
    and s.branch_id = v_order.branch_id
    and s.active = true
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  if v_staff.id is null then
    select s.* into v_staff
    from public.staff s
    join public.branches b on b.organization_id = s.organization_id and b.id = v_order.branch_id
    where s.user_id = v_user
      and s.active = true
      and s.role = 'OWNER'
    order by s.created_at
    limit 1;
  end if;

  if v_staff.id is null then
    raise exception 'You do not have access to this order' using errcode = '42501';
  end if;

  -- PAY_NOW orders that are awaiting confirmation are read-only operationally.
  -- (Restored: this guard existed in 202609160005_build13_3_payment_state_fix.sql
  -- and was accidentally dropped when this function was rewritten for Build 15.)
  if (v_order.payment_method = 'PAY_NOW' or left(coalesce(v_order.payment_method,''),8) = 'PAY_NOW:')
     and v_order.status = 'NEW'::public.order_status
     and v_order.payment_status = 'PENDING'::public.payment_status then
    raise exception 'Online payment is still pending; this order is not actionable' using errcode = 'P0001';
  end if;

  if v_order.status = 'NEW'::public.order_status
     and p_new_status = 'ACCEPTED'::public.order_status then

    if v_staff.role = 'KITCHEN'::public.staff_role then
      v_allowed :=
        public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
        and public.get_kitchen_order_acceptance(v_order.branch_id);
    else
      v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS');
    end if;

  elsif v_order.status = 'ACCEPTED'::public.order_status
        and p_new_status = 'PREPARING'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen);

  elsif v_order.status = 'PREPARING'::public.order_status
        and p_new_status = 'READY'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen);

  elsif v_order.status = 'READY'::public.order_status
        and p_new_status = 'SERVED'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);

  elsif v_order.status = 'SERVED'::public.order_status
        and p_new_status = 'COMPLETED'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);
  end if;

  if not v_allowed then
    raise exception 'Invalid or unauthorized order status transition: % → %', v_order.status, p_new_status using errcode = '42501';
  end if;

  -- Restored: dropped when this function was rewritten for Build 15. An
  -- order must actually be paid before it can be marked COMPLETED.
  if p_new_status = 'COMPLETED'::public.order_status
     and v_order.payment_status <> 'PAID'::public.payment_status then
    raise exception 'Payment must be marked paid before completing this order' using errcode = 'P0001';
  end if;

  update public.orders ord
  set status = p_new_status, updated_at = now()
  where ord.id = v_order.id;

  insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id)
  values(v_order.id, v_order.branch_id, 'STATUS_CHANGED', v_order.status::text, p_new_status::text, v_user);

  return query
  select ord.id, ord.order_number, ord.table_id, ord.branch_id, ord.status,
         ord.payment_status, ord.payment_method, ord.subtotal, ord.tax,
         ord.discount, ord.total, ord.created_at, ord.updated_at
  from public.orders ord
  where ord.id = v_order.id;
end;
$$;

grant execute on function public.transition_order_status(uuid,public.order_status) to authenticated;
revoke execute on function public.transition_order_status(uuid,public.order_status) from anon, public;
alter function public.transition_order_status(uuid,public.order_status) set search_path = public;

-- ---------------------------------------------------------------------------
-- 3. Customer cancellation requests are NOT manager actions.
-- Managers may still retain their existing explicit manual cancellation
-- permission on orders; this only removes cancellation-request resolution.
-- ---------------------------------------------------------------------------
create or replace function public.decide_order_cancellation(
  p_request_id uuid,
  p_accept boolean
)
returns public.order_cancellation_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.order_cancellation_requests%rowtype;
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_allowed boolean := false;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_req
  from public.order_cancellation_requests
  where id = p_request_id
  for update;

  if v_req.id is null then
    raise exception 'Cancellation request not found' using errcode = 'P0002';
  end if;

  if v_req.status <> 'PENDING' then
    raise exception 'Cancellation request already decided' using errcode = 'P0001';
  end if;

  select * into v_order
  from public.orders
  where id = v_req.order_id
  for update;

  select s.* into v_staff
  from public.staff s
  where s.user_id = v_user
    and s.active = true
    and (s.branch_id = v_req.branch_id or s.role = 'OWNER')
    and exists (
      select 1 from public.branches b
      where b.id = v_req.branch_id
        and b.organization_id = s.organization_id
    )
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  if v_staff.id is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- Manager can decide cancellation requests, same as Build 14/13.4 — this
  -- was never something the person asked to change; only the notification
  -- and Kitchen-acceptance parts of this build were requested.
  v_allowed := public.current_user_has_permission_for_branch(v_req.branch_id, 'CANCEL_ORDERS')
    and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);

  if not v_allowed then
    raise exception 'You do not have permission to decide cancellation requests' using errcode = '42501';
  end if;

  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then
    update public.order_cancellation_requests
    set status = 'REJECTED',
        decided_at = coalesce(decided_at, now()),
        decided_by = v_user
    where id = v_req.id
    returning * into v_req;

    update public.notifications
    set read_at = coalesce(read_at, now())
    where entity_type = 'ORDER_CANCELLATION' and entity_id = v_req.id;

    insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
    values (
      v_order.id,
      v_order.branch_id,
      'CANCELLATION_AUTO_REJECTED',
      v_user,
      jsonb_build_object('request_id', v_req.id, 'reason', 'Order was no longer cancellable')
    );

    return v_req;
  end if;

  update public.order_cancellation_requests
  set status = case when p_accept then 'ACCEPTED' else 'REJECTED' end,
      decided_at = now(),
      decided_by = v_user
  where id = v_req.id
  returning * into v_req;

  update public.notifications
  set read_at = coalesce(read_at, now())
  where entity_type = 'ORDER_CANCELLATION' and entity_id = v_req.id;

  if p_accept then
    update public.orders
    set status = 'CANCELLED',
        cancellation_reason = 'CUSTOMER_REQUESTED',
        cancelled_by = v_user,
        cancelled_at = now(),
        updated_at = now()
    where id = v_order.id;

    insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata)
    values (
      v_order.id,
      v_order.branch_id,
      'CANCELLATION_ACCEPTED',
      v_order.status::text,
      'CANCELLED',
      v_user,
      jsonb_build_object('request_id', v_req.id, 'reason', v_req.reason)
    );
  else
    insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
    values (
      v_order.id,
      v_order.branch_id,
      'CANCELLATION_REJECTED',
      v_user,
      jsonb_build_object('request_id', v_req.id, 'reason', v_req.reason)
    );
  end if;

  return v_req;
end;
$$;

grant execute on function public.decide_order_cancellation(uuid,boolean) to authenticated;
revoke execute on function public.decide_order_cancellation(uuid,boolean) from anon, public;
alter function public.decide_order_cancellation(uuid,boolean) set search_path = public;

-- Notification recipients: Owner + Manager + wait-capable staff — this
-- matches the original pre-Build-15 behavior (Manager has always been a
-- notification recipient here; that was never something this build was
-- meant to change). Manager is still explicitly barred from *deciding* a
-- cancellation request in decide_order_cancellation() above — that
-- restriction is unrelated to who gets notified and is unchanged.
--
-- NOTE: this keeps the tracking_token ownership check from the original
-- secure version of this function (public.request_order_cancellation(uuid,
-- text, text)). An earlier draft of this migration accidentally recreated
-- an older, insecure 2-argument overload with no ownership check at all
-- (anon-callable, no tracking_token) — that overload is explicitly dropped
-- below and must never be recreated.
--
-- This also keeps using public.create_staff_notification() for Owner and
-- Manager, so the owner_notification_preferences opt-out added in Build
-- 13.4 keeps being respected for the Owner. A raw INSERT would bypass it.
create or replace function public.request_order_cancellation(
  p_order_id uuid,
  p_tracking_token text,
  p_reason text default null
)
returns public.order_cancellation_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_req public.order_cancellation_requests%rowtype;
begin
  select * into v_order
  from public.orders
  where id = p_order_id
    and tracking_token = trim(p_tracking_token);

  if v_order.id is null then
    raise exception 'Order not found';
  end if;

  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then
    raise exception 'Cancellation is no longer available for this order';
  end if;

  insert into public.order_cancellation_requests(order_id, branch_id, reason)
  values (
    v_order.id,
    v_order.branch_id,
    nullif(left(trim(coalesce(p_reason,'')),300),'')
  )
  returning * into v_req;

  -- Owner + Manager: notified via the shared helper (this restores the
  -- pre-Build-15 behavior where Manager was a notification recipient).
  -- Note: this is notification only. Manager is still explicitly barred
  -- from deciding a cancellation request — see decide_order_cancellation()
  -- above, which is unrelated to this and unchanged.
  perform public.create_staff_notification(
    v_order.branch_id,
    ARRAY['OWNER','MANAGER']::public.staff_role[],
    'CANCELLATION_REQUEST',
    'Cancellation requested',
    format('Order #%s has a cancellation request.', coalesce(v_order.order_number::text,'—')),
    'ORDER_CANCELLATION',
    v_req.id,
    jsonb_build_object('order_id', v_order.id)
  );

  -- Branch-local wait-capable staff, excluding Manager and Owner (both
  -- already handled above via the helper). can_waiter is a flag that can be
  -- set on roles other than a dedicated WAITER role (e.g. a combined
  -- Kitchen+Waiter profile), so this can't be expressed through
  -- create_staff_notification()'s fixed role-array filter.
  insert into public.notifications(
    branch_id, recipient_staff_id, type, title, message,
    entity_type, entity_id, metadata
  )
  select
    v_order.branch_id,
    s.id,
    'CANCELLATION_REQUEST',
    'Cancellation requested',
    format('Order #%s has a cancellation request.', coalesce(v_order.order_number::text,'—')),
    'ORDER_CANCELLATION',
    v_req.id,
    jsonb_build_object('order_id', v_order.id)
  from public.staff s
  where s.branch_id = v_order.branch_id
    and s.active = true
    and s.can_waiter
    and s.role <> 'MANAGER'::public.staff_role
    and s.role <> 'OWNER'::public.staff_role;

  return v_req;
end;
$$;

grant execute on function public.request_order_cancellation(uuid,text,text) to anon, authenticated;
revoke execute on function public.request_order_cancellation(uuid,text,text) from public;
alter function public.request_order_cancellation(uuid,text,text) set search_path = public;

-- Defense in depth: make certain the insecure no-ownership-check overload
-- (uuid, text) can never exist alongside the secure one above. This has
-- been accidentally recreated twice before (202609142300, and in an early
-- draft of this very migration) — always re-assert the drop.
drop function if exists public.request_order_cancellation(uuid, text);

notify pgrst, 'reload schema';

commit;
