-- TABLELY BUILD 13.4 — cancellation UX fixes
--
-- Fixes four issues found while verifying the previous "verified fixed" pass
-- against its own spec:
--
--   1. cancel_order() accepted arbitrary free text for p_reason (the UI sent
--      whatever a window.prompt() box returned). This constrains manual
--      cancellation reasons to a fixed enum, both in the RPC and via a CHECK
--      constraint on the column itself, so nothing else can bypass it either.
--
--   2. CRITICAL (found during this pass, not previously flagged):
--      decide_order_cancellation() — the function that runs when staff
--      approve a *customer's* cancellation request — sets
--      orders.status = 'CANCELLED' but has never set cancellation_reason,
--      cancelled_by, or cancelled_at. Those columns were added later in
--      Build 13.3 (202609160004); this function predates them and was never
--      updated. Every order cancelled via that path has had a permanently
--      blank reason and no attribution. Fixed to set
--      cancellation_reason = 'CUSTOMER_REQUESTED', cancelled_by = the
--      deciding staff member's user id, cancelled_at = now().
--
--   3. notify_order_status_change()'s CANCELLED branch always inserted the
--      generic 'Order cancelled' / 'Order #N was cancelled.' text. The
--      cancellation_reason was already attached in `metadata`, but never in
--      the human-readable title/message the UI actually displays. This adds
--      a small label helper and uses it in the notification text, e.g.
--      "Order #12 cancelled — Online payment failed."
--
-- Nothing here changes cancel_order()'s or decide_order_cancellation()'s
-- authorization logic, branch scoping, or state-machine checks — those were
-- already verified correct and are reproduced unchanged.

begin;

-- ---------------------------------------------------------------------------
-- 1) Constrain cancellation_reason to a fixed enum.
-- ---------------------------------------------------------------------------

-- Normalize any pre-existing free-text values (Build 13.3's cancel_order()
-- accepted arbitrary text) before adding the constraint, so this migration
-- can never fail against real data. System-set values are left untouched.
update public.orders
set cancellation_reason = 'OTHER'
where cancellation_reason is not null
  and cancellation_reason not in (
    'CUSTOMER_REQUESTED','RESTAURANT_CANNOT_FULFILL','ITEM_UNAVAILABLE','PAYMENT_ISSUE','OTHER',
    'ONLINE_PAYMENT_FAILED','ONLINE_PAYMENT_TIMEOUT'
  );

alter table public.orders drop constraint if exists orders_cancellation_reason_check;
alter table public.orders add constraint orders_cancellation_reason_check
  check (
    cancellation_reason is null or cancellation_reason in (
      'CUSTOMER_REQUESTED','RESTAURANT_CANNOT_FULFILL','ITEM_UNAVAILABLE','PAYMENT_ISSUE','OTHER',
      'ONLINE_PAYMENT_FAILED','ONLINE_PAYMENT_TIMEOUT'
    )
  );

-- Small reusable label helper, used by the notification trigger below and
-- available for any future UI/reporting that wants server-side labels.
create or replace function public.cancellation_reason_label(p_code text)
returns text
language sql
immutable
as $$
  select case p_code
    when 'CUSTOMER_REQUESTED' then 'Customer requested'
    when 'RESTAURANT_CANNOT_FULFILL' then 'Restaurant cannot fulfill'
    when 'ITEM_UNAVAILABLE' then 'Item unavailable'
    when 'PAYMENT_ISSUE' then 'Payment issue'
    when 'ONLINE_PAYMENT_FAILED' then 'Online payment failed'
    when 'ONLINE_PAYMENT_TIMEOUT' then 'Online payment timed out'
    when 'OTHER' then 'Other'
    else coalesce(p_code, 'Unspecified reason')
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2) cancel_order(): validate the manual reason against the fixed enum.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_order(p_order_id uuid,p_reason text default 'OTHER')
returns table(id uuid,order_number bigint,table_id uuid,branch_id uuid,status public.order_status,payment_status public.payment_status,payment_method text,cancellation_reason text,cancelled_by uuid,cancelled_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare
  v_order public.orders%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid();
  v_reason text:=upper(trim(coalesce(p_reason,'OTHER')));
begin
  if v_reason not in ('CUSTOMER_REQUESTED','RESTAURANT_CANNOT_FULFILL','ITEM_UNAVAILABLE','PAYMENT_ISSUE','OTHER') then
    v_reason:='OTHER';
  end if;
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select ord.* into v_order from public.orders ord where ord.id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found' using errcode='P0002'; end if;
  select st.* into v_staff from public.staff st where st.user_id=v_user and st.active=true and (st.branch_id=v_order.branch_id or st.role='OWNER')
    and exists(select 1 from public.branches b where b.id=v_order.branch_id and b.organization_id=st.organization_id)
  order by case when st.role='OWNER' then 0 when st.role='MANAGER' then 1 else 2 end,st.created_at limit 1;
  if v_staff.id is null or not public.current_user_has_permission_for_branch(v_order.branch_id,'CANCEL_ORDERS') then raise exception 'You do not have permission to cancel this order' using errcode='42501'; end if;
  if v_order.status in ('CANCELLED','COMPLETED','SERVED') then raise exception 'This order cannot be cancelled in its current state' using errcode='P0001'; end if;
  if v_order.payment_status='PAID' then raise exception 'Paid orders require refund handling before cancellation' using errcode='P0001'; end if;
  if (v_order.payment_method = 'PAY_NOW' or left(coalesce(v_order.payment_method,''),8) = 'PAY_NOW:') and v_order.payment_status = 'PENDING' then
    raise exception 'Online payment is still pending; cancellation is not available for this payment state' using errcode='P0001';
  end if;
  update public.orders ord set status='CANCELLED',cancellation_reason=v_reason,cancelled_by=v_user,cancelled_at=now(),updated_at=now() where ord.id=v_order.id;
  insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'MANUAL_CANCELLATION',v_order.status::text,'CANCELLED',v_user,jsonb_build_object('reason',v_reason));
  return query select ord.id,ord.order_number,ord.table_id,ord.branch_id,ord.status,ord.payment_status,ord.payment_method,ord.cancellation_reason,ord.cancelled_by,ord.cancelled_at from public.orders ord where ord.id=v_order.id;
end;
$$;
grant execute on function public.cancel_order(uuid,text) to authenticated;
revoke execute on function public.cancel_order(uuid,text) from anon,public;
alter function public.cancel_order(uuid,text) set search_path=public;

-- ---------------------------------------------------------------------------
-- 3) decide_order_cancellation(): actually populate cancellation_reason /
--    cancelled_by / cancelled_at on accept (previously left null forever).
--    Everything else in this function — auth, staff resolution, the
--    auto-reject-if-no-longer-cancellable branch, order_events — is
--    reproduced unchanged.
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
alter function public.decide_order_cancellation(uuid,boolean) set search_path=public;

-- ---------------------------------------------------------------------------
-- 4) notify_order_status_change(): include the human-readable reason in the
--    cancellation notification's visible text, not just in metadata.
--    Every other branch (NEW/ACCEPTED/PREPARING/READY/SERVED/COMPLETED, and
--    the payment_status=PAID branch) is reproduced unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.notify_order_status_change()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_table integer;
  v_order bigint;
  v_msg text;
begin
  select t.table_number into v_table
  from public.tables t where t.id=coalesce(NEW.table_id,OLD.table_id);
  v_order:=coalesce(NEW.order_number,OLD.order_number);

  if TG_OP='INSERT' then
    perform public.create_staff_notification(
      NEW.branch_id,
      ARRAY['OWNER','MANAGER']::public.staff_role[],
      'ORDER_NEW',
      'New order',
      format('Order #%s received from Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),
      'ORDER',NEW.id,'{}'::jsonb,null
    );
    return NEW;
  end if;

  if NEW.status::text=OLD.status::text and NEW.payment_status::text=OLD.payment_status::text then
    return NEW;
  end if;

  if NEW.status::text='ACCEPTED' then
    v_msg:=format('Order #%s accepted. Start preparing Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—'));
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_ACCEPTED','Start preparing',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','ACCEPTED')
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role and s.can_kitchen=true;
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER']::public.staff_role[],'ORDER_ACCEPTED','Order accepted',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','ACCEPTED'),null);

  elsif NEW.status::text='PREPARING' then
    v_msg:=format('Order #%s is now being prepared for Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—'));
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_PREPARING','Order preparing',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','PREPARING')
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role and s.can_kitchen=true;
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_PREPARING','Order preparing',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','PREPARING'),null);

  elsif NEW.status::text='READY' then
    v_msg:=format('Order #%s is ready at Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—'));
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_READY','Order ready',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','READY')
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role and (s.can_waiter=true or s.role='MANAGER'::public.staff_role);
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER']::public.staff_role[],'ORDER_READY','Order ready',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','READY'),null);

  elsif NEW.status::text='SERVED' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_SERVED','Order served',format('Order #%s was served at Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','SERVED'),null);

  elsif NEW.status::text='COMPLETED' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_COMPLETED','Order completed',format('Order #%s is completed.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','COMPLETED'),null);

  elsif NEW.status::text='CANCELLED' then
    v_msg:=format('Order #%s cancelled — %s.',coalesce(v_order::text,'—'),public.cancellation_reason_label(NEW.cancellation_reason));
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'ORDER_CANCELLED','Order cancelled',v_msg,'ORDER',NEW.id,
      jsonb_build_object('order_status','CANCELLED','cancellation_reason',NEW.cancellation_reason)
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role;
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER']::public.staff_role[],'ORDER_CANCELLED','Order cancelled',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','CANCELLED','cancellation_reason',NEW.cancellation_reason),null);
  end if;

  if NEW.payment_status::text<>OLD.payment_status::text and NEW.payment_status::text='PAID' then
    insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
    select NEW.branch_id,s.id,'PAYMENT_PAID','Payment received',format('Order #%s is marked paid.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('payment_status','PAID')
    from public.staff s
    where s.branch_id=NEW.branch_id and s.active=true and s.role<>'OWNER'::public.staff_role and (s.can_waiter=true or s.role='MANAGER'::public.staff_role);
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER']::public.staff_role[],'PAYMENT_PAID','Payment received',format('Order #%s is marked paid.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('payment_status','PAID'),null);
  end if;

  return NEW;
end;
$$;

commit;

select pg_notify('pgrst','reload schema');
