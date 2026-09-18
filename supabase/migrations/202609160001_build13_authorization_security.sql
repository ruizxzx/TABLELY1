-- TABLELY BUILD 13 — Authorization Core & Security Hardening
-- Additive, data-preserving migration for the current Build 12 database.
--
-- Goals:
--   1. Unify organization + branch + role + staff-permission checks.
--   2. Make fine-grained permissions authoritative on protected operations.
--   3. Remove anonymous access to the generic entitlement engine.
--   4. Protect custom-domain verification tokens.
--   5. Fix subscription read RPC volatility by separating state resolution.
--   6. Correct Growth/basic-vs-advanced analytics access paths.
--   7. Centralize owner staff branch assignment.
--
-- This migration intentionally does NOT change the Build 14 pricing catalog.

begin;

-- ---------------------------------------------------------------------------
-- 1) Central authorization helpers
-- ---------------------------------------------------------------------------

create or replace function public.current_user_has_permission_for_branch(
  p_branch_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.branches b
    join public.staff s
      on s.organization_id = b.organization_id
     and s.user_id = auth.uid()
     and s.active = true
     and (
       s.role = 'OWNER'::public.staff_role
       or s.branch_id = b.id
     )
    where b.id = p_branch_id
      and (
        s.role = 'OWNER'::public.staff_role
        or exists (
          select 1
          from public.staff_permissions sp
          where sp.staff_id = s.id
            and upper(trim(sp.permission)) = upper(trim(coalesce(p_permission, '')))
            and sp.allowed = true
        )
      )
  );
$$;

grant execute on function public.current_user_has_permission_for_branch(uuid,text) to authenticated;
revoke execute on function public.current_user_has_permission_for_branch(uuid,text) from anon, public;

create or replace function public.current_user_is_branch_operator(
  p_branch_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.branches b
    join public.staff s
      on s.organization_id = b.organization_id
     and s.user_id = auth.uid()
     and s.active = true
     and (
       s.role = 'OWNER'::public.staff_role
       or s.branch_id = b.id
     )
    where b.id = p_branch_id
  );
$$;

grant execute on function public.current_user_is_branch_operator(uuid) to authenticated;
revoke execute on function public.current_user_is_branch_operator(uuid) from anon, public;

-- Owner is a deliberate bypass for staff-level permissions.  Non-owner staff
-- must have the explicit permission on the branch they are operating in.
create or replace function public.can_manage_branch_for_current_user(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.current_user_has_permission_for_branch(p_branch_id, 'BRANCH_MANAGEMENT');
$$;

grant execute on function public.can_manage_branch_for_current_user(uuid) to authenticated;
revoke execute on function public.can_manage_branch_for_current_user(uuid) from anon, public;

-- Keep the existing manager helper, but route it through the unified model.
create or replace function public.is_branch_manager_with_permission(
  target_branch uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.branches b
    join public.staff s
      on s.organization_id = b.organization_id
     and s.branch_id = b.id
     and s.user_id = auth.uid()
     and s.role = 'MANAGER'::public.staff_role
     and s.active = true
    join public.staff_permissions sp
      on sp.staff_id = s.id
     and sp.allowed = true
     and upper(trim(sp.permission)) = upper(trim(coalesce(p_permission, '')))
    where b.id = target_branch
  );
$$;

grant execute on function public.is_branch_manager_with_permission(uuid,text) to authenticated;
revoke execute on function public.is_branch_manager_with_permission(uuid,text) from anon, public;

-- ---------------------------------------------------------------------------
-- 2) Fine-grained permission management
-- ---------------------------------------------------------------------------

create or replace function public.can_manage_permissions(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff target
    join public.staff caller
      on caller.organization_id = target.organization_id
     and caller.user_id = auth.uid()
     and caller.active = true
     and caller.role = 'OWNER'::public.staff_role
    where target.id = p_staff_id
      and public.organization_has_feature(target.organization_id, 'ADVANCED_PERMISSIONS')
  );
$$;

grant execute on function public.can_manage_permissions(uuid) to authenticated;
revoke execute on function public.can_manage_permissions(uuid) from anon, public;

create or replace function public.set_staff_permission(
  p_staff_id uuid,
  p_permission text,
  p_allowed boolean
)
returns public.staff_permissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff_permissions;
  v_target public.staff%rowtype;
  v_permission text := upper(trim(coalesce(p_permission, '')));
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if v_permission not in (
    'VIEW_ORDERS',
    'EDIT_ORDERS',
    'CANCEL_ORDERS',
    'KITCHEN_ACCESS',
    'BILLING',
    'CHARGES',
    'PAYMENTS',
    'STAFF_MANAGEMENT',
    'ANALYTICS',
    'SETTINGS',
    'MENU_MANAGEMENT',
    'BRANCH_MANAGEMENT',
    'SUBSCRIPTION_MANAGEMENT'
  ) then
    raise exception 'Unsupported permission';
  end if;

  select * into v_target
  from public.staff s
  where s.id = p_staff_id
  for update;

  if v_target.id is null then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  if v_target.role = 'OWNER'::public.staff_role then
    raise exception 'Owner permissions cannot be modified' using errcode = '42501';
  end if;

  if not public.can_manage_permissions(p_staff_id) then
    raise exception 'Only an authorized owner can manage advanced permissions' using errcode = '42501';
  end if;

  insert into public.staff_permissions(staff_id, permission, allowed)
  values (p_staff_id, v_permission, coalesce(p_allowed, false))
  on conflict (staff_id, permission)
  do update set allowed = excluded.allowed, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.set_staff_permission(uuid,text,boolean) to authenticated;
revoke execute on function public.set_staff_permission(uuid,text,boolean) from anon, public;

-- Permission records are only directly readable by the owner and only when
-- the organization has the advanced-permissions entitlement.
drop policy if exists staff_permissions_select on public.staff_permissions;
create policy staff_permissions_select on public.staff_permissions
for select to authenticated
using (
  public.can_manage_permissions(staff_permissions.staff_id)
);

drop policy if exists staff_permissions_write on public.staff_permissions;
create policy staff_permissions_write on public.staff_permissions
for all to authenticated
using (
  public.can_manage_permissions(staff_permissions.staff_id)
)
with check (
  public.can_manage_permissions(staff_permissions.staff_id)
);

grant select, insert, update, delete on public.staff_permissions to authenticated;
revoke all on public.staff_permissions from anon;

-- ---------------------------------------------------------------------------
-- 3) Branch authorization
-- ---------------------------------------------------------------------------

-- Non-owner staff should only be able to discover their assigned branch.
-- Owners retain organization-wide branch visibility through is_branch_member().
drop policy if exists branches_select_member on public.branches;
create policy branches_select_member on public.branches
for select to authenticated
using (
  public.is_branch_member(id)
);

drop policy if exists branches_update_owner on public.branches;
create policy branches_update_owner on public.branches
for update to authenticated
using (
  public.is_org_owner(organization_id)
  or public.can_manage_branch_for_current_user(id)
)
with check (
  public.is_org_owner(organization_id)
  or public.can_manage_branch_for_current_user(id)
);

drop policy if exists branches_insert_owner on public.branches;
create policy branches_insert_owner on public.branches
for insert to authenticated
with check (
  public.is_org_owner(organization_id)
  and public.organization_has_feature(organization_id, 'MULTI_BRANCH')
);

drop policy if exists branches_delete_owner on public.branches;
create policy branches_delete_owner on public.branches
for delete to authenticated
using (
  public.is_org_owner(organization_id)
);

-- ---------------------------------------------------------------------------
-- 4) Menu authorization
-- ---------------------------------------------------------------------------

-- Read remains branch-scoped for restaurant operations. Writes require the
-- explicit MENU_MANAGEMENT permission (owners are the deliberate bypass).
drop policy if exists menu_categories_insert_manager on public.menu_categories;
create policy menu_categories_insert_manager on public.menu_categories
for insert to authenticated
with check (
  public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
);

drop policy if exists menu_categories_update_manager on public.menu_categories;
create policy menu_categories_update_manager on public.menu_categories
for update to authenticated
using (
  public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
)
with check (
  public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
);

drop policy if exists menu_categories_delete_manager on public.menu_categories;
create policy menu_categories_delete_manager on public.menu_categories
for delete to authenticated
using (
  public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
);

drop policy if exists menu_items_insert_manager on public.menu_items;
create policy menu_items_insert_manager on public.menu_items
for insert to authenticated
with check (
  public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
);

drop policy if exists menu_items_update_manager on public.menu_items;
create policy menu_items_update_manager on public.menu_items
for update to authenticated
using (
  public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
)
with check (
  public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
);

drop policy if exists menu_items_delete_manager on public.menu_items;
create policy menu_items_delete_manager on public.menu_items
for delete to authenticated
using (
  public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
);

-- Storage policies use the same authorization source of truth.
drop policy if exists menu_images_insert_manager on storage.objects;
create policy menu_images_insert_manager on storage.objects
for insert to authenticated
with check (
  bucket_id = 'menu-images'
  and (storage.foldername(name))[1] is not null
  and public.current_user_has_permission_for_branch(((storage.foldername(name))[1])::uuid, 'MENU_MANAGEMENT')
);

drop policy if exists menu_images_update_manager on storage.objects;
create policy menu_images_update_manager on storage.objects
for update to authenticated
using (
  bucket_id = 'menu-images'
  and public.current_user_has_permission_for_branch(((storage.foldername(name))[1])::uuid, 'MENU_MANAGEMENT')
)
with check (
  bucket_id = 'menu-images'
  and public.current_user_has_permission_for_branch(((storage.foldername(name))[1])::uuid, 'MENU_MANAGEMENT')
);

drop policy if exists menu_images_delete_manager on storage.objects;
create policy menu_images_delete_manager on storage.objects
for delete to authenticated
using (
  bucket_id = 'menu-images'
  and public.current_user_has_permission_for_branch(((storage.foldername(name))[1])::uuid, 'MENU_MANAGEMENT')
);

-- ---------------------------------------------------------------------------
-- 5) Order read/write authorization
-- ---------------------------------------------------------------------------

-- Reading orders requires explicit VIEW_ORDERS. Kitchen operators retain
-- order visibility through KITCHEN_ACCESS so the kitchen workflow continues.
drop policy if exists orders_select_branch_member on public.orders;
create policy orders_select_branch_member on public.orders
for select to authenticated
using (
  public.is_branch_member(branch_id)
  and (
    public.current_user_has_permission_for_branch(branch_id, 'VIEW_ORDERS')
    or public.current_user_has_permission_for_branch(branch_id, 'KITCHEN_ACCESS')
  )
);

-- All authenticated order mutations are intentionally routed through
-- SECURITY DEFINER RPCs. This prevents arbitrary column edits from the browser
-- and keeps order status/payment state transitions authoritative.
drop policy if exists orders_update_branch_member on public.orders;
create policy orders_update_branch_member on public.orders
for update to authenticated
using (false)
with check (false);
revoke update on public.orders from authenticated;

-- Order item reads follow the same order visibility rules.
drop policy if exists order_items_select_branch_member on public.order_items;
create policy order_items_select_branch_member on public.order_items
for select to authenticated
using (
  exists (
    select 1
    from public.orders o
    where o.id = order_items.order_id
      and public.is_branch_member(o.branch_id)
      and (
        public.current_user_has_permission_for_branch(o.branch_id, 'VIEW_ORDERS')
        or public.current_user_has_permission_for_branch(o.branch_id, 'KITCHEN_ACCESS')
      )
  )
);

-- ---------------------------------------------------------------------------
-- 6) Order status transitions now honor fine-grained permissions
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
    -- Organization owners are allowed to operate across every branch.
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

  if v_order.status = 'NEW'::public.order_status
     and p_new_status = 'ACCEPTED'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS');
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

  update public.orders ord
  set status = p_new_status, updated_at = now()
  where ord.id = v_order.id;

  insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id)
  values (v_order.id, v_order.branch_id, 'STATUS_CHANGED', v_order.status::text, p_new_status::text, v_user);

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

-- Cancellation decisions require the explicit CANCEL_ORDERS permission for
-- non-owners while preserving the existing waiter capability model.
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

  v_allowed := public.current_user_has_permission_for_branch(v_req.branch_id, 'CANCEL_ORDERS')
    and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);

  if not v_allowed then
    raise exception 'You do not have permission to decide cancellation requests' using errcode = '42501';
  end if;

  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then
    update public.order_cancellation_requests
    set status = 'REJECTED', decided_at = coalesce(decided_at, now()), decided_by = v_user
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
    set status = 'CANCELLED', updated_at = now()
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

-- Manual payment marking requires the explicit PAYMENTS permission.
create or replace function public.mark_order_paid(
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

  select ord.* into v_order
  from public.orders ord
  where ord.id = p_order_id
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
  order by case when st.role = 'OWNER' then 0 when st.role = 'MANAGER' then 1 else 2 end
  limit 1;

  if v_staff.id is null or not public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS') then
    raise exception 'You are not authorized to mark payments' using errcode = '42501';
  end if;

  if v_method not in ('CASH', 'UPI', 'CARD') then
    raise exception 'Unsupported manual payment method';
  end if;

  if v_order.payment_status <> 'PAID' then
    update public.orders ord
    set payment_status = 'PAID',
        payment_method = v_method,
        paid_at = coalesce(ord.paid_at, now()),
        updated_at = now()
    where ord.id = p_order_id;

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
          'actor_user_id', v_user::text
        )
      );

    insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
    values (v_order.id, v_order.branch_id, 'PAYMENT_MARKED_PAID', v_user, jsonb_build_object('method', v_method));
  end if;

  return query
  select ord.id, ord.payment_status, ord.payment_method, ord.paid_at
  from public.orders ord
  where ord.id = p_order_id;
end;
$$;

grant execute on function public.mark_order_paid(uuid,text,text) to authenticated;
revoke execute on function public.mark_order_paid(uuid,text,text) from anon, public;

-- ---------------------------------------------------------------------------
-- 7) Analytics: basic vs advanced permissions + plan entitlements
-- ---------------------------------------------------------------------------

drop function if exists public.get_branch_analytics(uuid,timestamptz,timestamptz);
create or replace function public.get_branch_analytics(
  p_branch_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_result jsonb;
begin
  select b.organization_id into v_org
  from public.branches b
  where b.id = p_branch_id
    and b.is_active = true;

  if v_org is null or not public.is_branch_member(p_branch_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.organization_has_feature(v_org, 'ANALYTICS') then
    raise exception 'Analytics are not available on the current Tablely plan' using errcode = '42501';
  end if;

  if not public.current_user_has_permission_for_branch(p_branch_id, 'ANALYTICS') then
    raise exception 'You do not have analytics permission for this branch' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'revenue', coalesce(sum(case when o.payment_status = 'PAID' then o.total else 0 end), 0),
    'orders', count(*),
    'completed_orders', count(*) filter (where o.status = 'COMPLETED'),
    'average_order_value', coalesce(avg(o.total), 0),
    'paid_orders', count(*) filter (where o.payment_status = 'PAID'),
    'cancelled_orders', count(*) filter (where o.status = 'CANCELLED'),
    'online_revenue', coalesce(sum(case when o.payment_status = 'PAID' and o.payment_method like 'PAY_NOW:%' then o.total else 0 end), 0),
    'counter_revenue', coalesce(sum(case when o.payment_status = 'PAID' and coalesce(o.payment_method, '') not like 'PAY_NOW:%' then o.total else 0 end), 0)
  )
  into v_result
  from public.orders o
  where o.branch_id = p_branch_id
    and o.created_at >= p_from
    and o.created_at < p_to;

  return v_result;
end;
$$;

grant execute on function public.get_branch_analytics(uuid,timestamptz,timestamptz) to authenticated;
revoke execute on function public.get_branch_analytics(uuid,timestamptz,timestamptz) from anon, public;

create or replace function public.get_build12_analytics(p_branch_id uuid,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_org uuid; v_result jsonb;
begin
  select organization_id into v_org from public.branches where id=p_branch_id and is_active;
  if v_org is null or not public.is_branch_member(p_branch_id) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if not public.organization_has_feature(v_org,'ADVANCED_ANALYTICS') then
    raise exception 'Advanced analytics are not available on the current Tablely plan' using errcode='42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'ANALYTICS') then
    raise exception 'You do not have analytics permission for this branch' using errcode='42501';
  end if;
  with scoped as (
    select o.* from public.orders o where o.branch_id=p_branch_id and o.created_at>=p_from and o.created_at<p_to
  ), item_rank as (
    select oi.item_name_snapshot name, sum(oi.quantity)::int quantity, sum(oi.line_total)::numeric revenue
    from public.order_items oi join scoped s on s.id=oi.order_id group by oi.item_name_snapshot order by revenue desc limit 10
  ), peak as (
    select extract(hour from created_at)::int as hour, count(*)::int as orders, coalesce(sum(total) filter(where payment_status='PAID'),0)::numeric as revenue
    from scoped group by 1 order by orders desc limit 8
  ), prep as (
    select avg(extract(epoch from (coalesce(rr.ready_at,c.completed_at)-r.created_at))/60.0) avg_minutes
    from (select order_id,min(created_at) created_at from public.order_events where branch_id=p_branch_id and event_type='STATUS' and to_status='ACCEPTED' group by order_id) r
    left join lateral(select min(oe.created_at) ready_at from public.order_events oe where oe.order_id=r.order_id and oe.to_status='READY') rr on true
    left join lateral(select min(oe.created_at) completed_at from public.order_events oe where oe.order_id=r.order_id and oe.to_status='COMPLETED') c on true
  ), service as (
    select avg(extract(epoch from (resolved_at-created_at))/60.0) avg_minutes
    from public.service_requests where branch_id=p_branch_id and created_at>=p_from and created_at<p_to and resolved_at is not null
  ), table_usage as (
    select count(distinct table_id)::int used_tables, (select count(*) from public.tables where branch_id=p_branch_id and active)::int total_tables from scoped
  )
  select jsonb_build_object(
    'peak_hours',coalesce((select jsonb_agg(to_jsonb(peak) order by orders desc) from peak),'[]'::jsonb),
    'top_products',coalesce((select jsonb_agg(to_jsonb(item_rank) order by revenue desc) from item_rank),'[]'::jsonb),
    'cancellation_rate',coalesce((select round(count(*) filter(where status='CANCELLED')::numeric/nullif(count(*),0)*100,2) from scoped),0),
    'average_preparation_minutes',coalesce((select round(avg_minutes::numeric,1) from prep),0),
    'average_service_response_minutes',coalesce((select round(avg_minutes::numeric,1) from service),0),
    'table_utilization_percent',coalesce((select round(used_tables::numeric/nullif(total_tables,0)*100,1) from table_usage),0),
    'used_tables',coalesce((select used_tables from table_usage),0),
    'total_tables',coalesce((select total_tables from table_usage),0),
    'revenue',coalesce((select sum(total) from scoped where payment_status='PAID'),0),
    'orders',coalesce((select count(*) from scoped),0)
  ) into v_result;
  return v_result;
end; $$;
grant execute on function public.get_build12_analytics(uuid,timestamptz,timestamptz) to authenticated;
revoke execute on function public.get_build12_analytics(uuid,timestamptz,timestamptz) from anon, public;

create or replace function public.get_build12_cross_branch_analytics(
  p_from timestamptz,
  p_to timestamptz
)
returns table(
  branch_id uuid,
  branch_name text,
  revenue numeric,
  orders bigint,
  average_order_value numeric,
  cancelled bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  select s.organization_id into v_org
  from public.staff s
  where s.user_id = auth.uid()
    and s.active = true
    and s.role = 'OWNER'::public.staff_role
  order by s.created_at
  limit 1;

  if v_org is null then
    raise exception 'Owner access required' using errcode = '42501';
  end if;

  if not public.organization_has_feature(v_org, 'CROSS_BRANCH_REPORTING') then
    raise exception 'Cross-branch reporting is not available on the current Tablely plan' using errcode = '42501';
  end if;

  return query
  select
    b.id,
    b.name,
    coalesce(sum(case when o.payment_status = 'PAID' and o.status <> 'CANCELLED' then o.total else 0 end), 0)::numeric,
    count(o.id)::bigint,
    coalesce(avg(o.total) filter (where o.payment_status = 'PAID' and o.status <> 'CANCELLED'), 0)::numeric,
    count(o.id) filter (where o.status = 'CANCELLED')::bigint
  from public.branches b
  left join public.orders o
    on o.branch_id = b.id
   and o.created_at >= p_from
   and o.created_at < p_to
  where b.organization_id = v_org
  group by b.id, b.name
  order by revenue desc;
end;
$$;

grant execute on function public.get_build12_cross_branch_analytics(timestamptz,timestamptz) to authenticated;
revoke execute on function public.get_build12_cross_branch_analytics(timestamptz,timestamptz) from anon, public;

-- ---------------------------------------------------------------------------
-- 8) Explicit subscription state resolution (mutating path) + read-only views
-- ---------------------------------------------------------------------------

create or replace function public.resolve_subscription_state()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_subscription public.organization_subscriptions%rowtype;
begin
  select s.organization_id into v_org
  from public.staff s
  where s.user_id = auth.uid()
    and s.active = true
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  if v_org is null then
    raise exception 'Restaurant workspace not found' using errcode = '42501';
  end if;

  update public.organization_subscriptions os
  set status = 'EXPIRED', updated_at = now()
  where os.organization_id = v_org
    and os.status = 'TRIAL'
    and os.trial_ends_at is not null
    and os.trial_ends_at <= now()
  returning os.* into v_subscription;

  if v_subscription.id is null then
    select * into v_subscription
    from public.organization_subscriptions os
    where os.organization_id = v_org;
  end if;

  return jsonb_build_object(
    'id', v_subscription.id,
    'organization_id', v_subscription.organization_id,
    'plan_id', v_subscription.plan_id,
    'status', v_subscription.status,
    'trial_ends_at', v_subscription.trial_ends_at,
    'current_period_end', v_subscription.current_period_end
  );
end;
$$;

grant execute on function public.resolve_subscription_state() to authenticated;
revoke execute on function public.resolve_subscription_state() from anon, public;

create or replace function public.get_current_subscription()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', os.id,
    'organization_id', os.organization_id,
    'plan_id', os.plan_id,
    'status', case
      when os.status = 'TRIAL' and os.trial_ends_at is not null and os.trial_ends_at <= now()
        then 'EXPIRED'
      else os.status
    end,
    'price_monthly_snapshot', os.price_monthly_snapshot,
    'currency', os.currency,
    'billing_interval', os.billing_interval,
    'trial_started_at', os.trial_started_at,
    'trial_ends_at', os.trial_ends_at,
    'current_period_start', os.current_period_start,
    'current_period_end', os.current_period_end,
    'provider', os.provider,
    'provider_customer_id', os.provider_customer_id,
    'provider_subscription_id', os.provider_subscription_id,
    'pending_plan_id', os.pending_plan_id,
    'pending_provider_plan_id', os.pending_provider_plan_id,
    'cancellation_requested_at', os.cancellation_requested_at,
    'cancelled_at', os.cancelled_at
  )
  from public.organization_subscriptions os
  join lateral (
    select s.organization_id
    from public.staff s
    where s.user_id = auth.uid()
      and s.active = true
    order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
    limit 1
  ) current_org on current_org.organization_id = os.organization_id;
$$;

grant execute on function public.get_current_subscription() to authenticated;
revoke execute on function public.get_current_subscription() from anon, public;

create or replace function public.get_billing_context()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'plan_id', os.plan_id,
    'plan_name', sp.name,
    'price_monthly', os.price_monthly_snapshot,
    'currency', os.currency,
    'status', case
      when os.status = 'TRIAL' and os.trial_ends_at is not null and os.trial_ends_at <= now()
        then 'EXPIRED'
      else os.status
    end,
    'trial_ends_at', os.trial_ends_at,
    'current_period_end', os.current_period_end,
    'provider_subscription_id', os.provider_subscription_id,
    'pending_plan_id', os.pending_plan_id,
    'cancellation_requested_at', os.cancellation_requested_at
  )
  from public.organization_subscriptions os
  join public.saas_plans sp on sp.id = os.plan_id
  join lateral (
    select s.organization_id
    from public.staff s
    where s.user_id = auth.uid()
      and s.active = true
    order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
    limit 1
  ) current_org on current_org.organization_id = os.organization_id;
$$;

grant execute on function public.get_billing_context() to authenticated;
revoke execute on function public.get_billing_context() from anon, public;

-- ---------------------------------------------------------------------------
-- 9) Anonymous entitlement hardening
-- ---------------------------------------------------------------------------

revoke execute on function public.organization_has_feature(uuid,text) from anon, public;
grant execute on function public.organization_has_feature(uuid,text) to authenticated, service_role;

-- Public customer payment options remain available through the narrow table-
-- code-based RPC, not through the generic entitlement function.
grant execute on function public.get_public_payment_options(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10) Domain verification token protection
-- ---------------------------------------------------------------------------

drop policy if exists organization_domains_select on public.organization_domains;
create policy organization_domains_select on public.organization_domains
for select to authenticated
using (
  public.is_org_owner(organization_id)
);

drop policy if exists organization_domains_write on public.organization_domains;
create policy organization_domains_write on public.organization_domains
for all to authenticated
using (
  public.is_org_owner(organization_id)
)
with check (
  public.is_org_owner(organization_id)
);

grant select, insert, update, delete on public.organization_domains to authenticated;
revoke all on public.organization_domains from anon;

-- ---------------------------------------------------------------------------
-- 11) Centralized owner staff branch assignment
-- ---------------------------------------------------------------------------

create or replace function public.assign_staff_to_branch(
  p_staff_id uuid,
  p_branch_id uuid default null
)
returns public.staff
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff%rowtype;
  v_branch public.branches%rowtype;
  v_org uuid;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_staff
  from public.staff s
  where s.id = p_staff_id
  for update;

  if v_staff.id is null then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  v_org := v_staff.organization_id;

  if not public.is_org_owner(v_org) then
    raise exception 'Only the organization owner can assign staff to branches' using errcode = '42501';
  end if;

  if v_staff.role = 'OWNER'::public.staff_role then
    raise exception 'Owner branch assignment cannot be changed' using errcode = '42501';
  end if;

  if p_branch_id is not null then
    select * into v_branch
    from public.branches b
    where b.id = p_branch_id
      and b.organization_id = v_org;

    if v_branch.id is null then
      raise exception 'Branch does not belong to this organization' using errcode = '42501';
    end if;
  end if;

  update public.staff
  set branch_id = p_branch_id,
      updated_at = now()
  where id = p_staff_id
  returning * into v_staff;

  return v_staff;
end;
$$;

grant execute on function public.assign_staff_to_branch(uuid,uuid) to authenticated;
revoke execute on function public.assign_staff_to_branch(uuid,uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- 12) Keep public domain/branding/customer RPCs available only where intended
-- ---------------------------------------------------------------------------

-- Internal brand profile remains authenticated-only; public profile continues
-- through the table-code based function.
revoke execute on function public.get_brand_profile(uuid) from anon, public;
grant execute on function public.get_brand_profile(uuid) to authenticated;

grant execute on function public.get_public_brand_profile(text) to anon, authenticated;

commit;

select pg_notify('pgrst','reload schema');
