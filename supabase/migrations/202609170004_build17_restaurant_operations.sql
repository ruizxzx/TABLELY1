-- TABLELY BUILD 17 — TABLES + ORDERS + RESTAURANT OPERATIONS 2.0
-- Additive only. Extends the verified Build 16 baseline without rewriting
-- Build 14/15/16 payment, cancellation, menu, or realtime security RPCs.

begin;

-- ============================================================
-- 1. Table/session operational model
-- ============================================================
alter table public.tables
  add column if not exists seat_tracking_enabled boolean not null default false,
  add column if not exists occupancy_count integer not null default 0,
  add column if not exists operational_updated_at timestamptz not null default now();

alter table public.tables drop constraint if exists tables_operational_state_chk;
alter table public.tables add constraint tables_operational_state_chk
  check (operational_state in ('AVAILABLE','OCCUPIED','ORDERING','PREPARING','BILL_REQUESTED','PAYMENT_PENDING','COMPLETED','CLEARING'));

create table if not exists public.table_sessions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','CLOSED')),
  occupancy_count integer not null default 0 check (occupancy_count >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (closed_at is null or closed_at >= opened_at)
);
create unique index if not exists table_sessions_one_active_per_table_uidx
  on public.table_sessions(table_id) where status='ACTIVE';
create index if not exists table_sessions_branch_status_idx
  on public.table_sessions(branch_id,status,opened_at desc);
create index if not exists table_sessions_table_status_idx
  on public.table_sessions(table_id,status,opened_at desc);

create table if not exists public.table_seats (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references public.tables(id) on delete cascade,
  seat_number integer not null check (seat_number >= 1),
  status text not null default 'FREE' check (status in ('FREE','OCCUPIED')),
  session_id uuid references public.table_sessions(id) on delete set null,
  occupied_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  unique(table_id,seat_number)
);
create index if not exists table_seats_table_status_idx on public.table_seats(table_id,status);
create index if not exists table_seats_session_idx on public.table_seats(session_id);

alter table public.orders
  add column if not exists table_session_id uuid references public.table_sessions(id) on delete set null,
  add column if not exists priority text not null default 'NORMAL' check (priority in ('NORMAL','HIGH','URGENT')),
  add column if not exists rejection_reason text,
  add column if not exists rejection_note text,
  add column if not exists rejected_by uuid references auth.users(id) on delete set null,
  add column if not exists rejected_at timestamptz,
  add column if not exists received_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists served_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists reopened_at timestamptz,
  add column if not exists reopen_reason text;

create index if not exists orders_table_session_idx on public.orders(table_session_id,created_at desc);
create index if not exists orders_branch_status_priority_idx on public.orders(branch_id,status,priority,created_at asc);
create index if not exists orders_table_status_idx on public.orders(table_id,status,created_at desc);

-- ============================================================
-- 2. Kitchen stations and item operations
-- ============================================================
create table if not exists public.kitchen_stations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(branch_id,name)
);
create index if not exists kitchen_stations_branch_active_idx on public.kitchen_stations(branch_id,is_active,sort_order);

create table if not exists public.kitchen_station_staff (
  station_id uuid not null references public.kitchen_stations(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(station_id,staff_id)
);
create index if not exists kitchen_station_staff_staff_idx on public.kitchen_station_staff(staff_id,station_id);

alter table public.order_items
  add column if not exists created_at timestamptz,
  add column if not exists updated_at timestamptz,
  add column if not exists preparation_status text check (preparation_status is null or preparation_status in ('PENDING','PREPARING','READY','SERVED','CANCELLED')),
  add column if not exists station_id uuid references public.kitchen_stations(id) on delete set null,
  add column if not exists priority text not null default 'NORMAL' check (priority in ('NORMAL','HIGH','URGENT')),
  add column if not exists received_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists ready_at timestamptz,
  add column if not exists served_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists actual_prep_seconds integer;
create index if not exists order_items_order_prep_idx on public.order_items(order_id,preparation_status,created_at);
create index if not exists order_items_station_prep_idx on public.order_items(station_id,preparation_status,created_at);

-- ============================================================
-- 3. Timestamp helpers / session synchronization
-- ============================================================
create or replace function public.build17_touch_table_session()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  new.updated_at=now();
  return new;
end; $$;
drop trigger if exists build17_touch_table_session on public.table_sessions;
create trigger build17_touch_table_session before update on public.table_sessions for each row execute function public.build17_touch_table_session();
create or replace function public.build17_touch_order_item()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if tg_op='INSERT' then
    new.created_at=coalesce(new.created_at,now());
    new.updated_at=coalesce(new.updated_at,now());
    new.received_at=coalesce(new.received_at,new.created_at);
    new.preparation_status=coalesce(new.preparation_status,'PENDING');
  else
    new.updated_at=now();
  end if;
  return new;
end; $$;
drop trigger if exists build17_touch_order_item on public.order_items;
create trigger build17_touch_order_item before insert or update on public.order_items for each row execute function public.build17_touch_order_item();

create or replace function public.build17_sync_table_operational_state(p_table_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_session public.table_sessions%rowtype;
  v_state text := 'AVAILABLE';
  v_bill boolean := false;
  v_order_count integer := 0;
  v_occupied_seats integer := 0;
  v_new integer := 0;
  v_preparing integer := 0;
  v_terminal integer := 0;
  v_unpaid integer := 0;
  v_has_orders boolean := false;
begin
  select * into v_session
  from public.table_sessions
  where table_id=p_table_id and status='ACTIVE'
  order by opened_at desc limit 1;

  if v_session.id is null then
    update public.tables set operational_state='AVAILABLE', occupancy_count=0, operational_updated_at=now() where id=p_table_id;
    return;
  end if;

  select count(*)::int into v_occupied_seats from public.table_seats where table_id=p_table_id and status='OCCUPIED' and session_id=v_session.id;

  select exists(
    select 1 from public.service_requests r
    where r.table_id=p_table_id and r.status in ('OPEN','ACKNOWLEDGED') and r.type='BILL'
  ) into v_bill;

  select
    count(*)::int,
    count(*) filter(where o.status='NEW')::int,
    count(*) filter(where o.status in ('ACCEPTED','PREPARING'))::int,
    count(*) filter(where o.status in ('COMPLETED','CANCELLED','REJECTED'))::int,
    count(*) filter(where o.payment_status<>'PAID' and o.status='COMPLETED')::int
  into v_order_count,v_new,v_preparing,v_terminal,v_unpaid
  from public.orders o where o.table_session_id=v_session.id;

  v_has_orders := v_order_count > 0;
  if v_bill then
    v_state := 'BILL_REQUESTED';
  elsif v_has_orders and v_terminal = v_order_count and v_unpaid > 0 then
    v_state := 'PAYMENT_PENDING';
  elsif v_has_orders and v_preparing > 0 then
    v_state := 'PREPARING';
  elsif v_has_orders and v_new > 0 then
    v_state := 'ORDERING';
  elsif v_has_orders and v_terminal = v_order_count then
    v_state := 'COMPLETED';
  else
    v_state := 'OCCUPIED';
  end if;

  update public.tables
  set operational_state=v_state,
      occupancy_count=case when seat_tracking_enabled then greatest(0,v_occupied_seats) else greatest(0,v_session.occupancy_count) end,
      operational_updated_at=now()
  where id=p_table_id;
end; $$;
revoke execute on function public.build17_sync_table_operational_state(uuid) from anon,authenticated,public;

-- Build 17 becomes the single state-sync trigger owner. The pre-existing Build 14
-- triggers are disabled without modifying their underlying functions.
drop trigger if exists orders_sync_table_state on public.orders;
drop trigger if exists service_sync_table_state on public.service_requests;

-- ============================================================
-- 4. Attach every newly-created order to the correct active session
-- ============================================================
create or replace function public.build17_attach_order_session()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_session_id uuid;
begin
  if not exists(select 1 from public.tables where id=new.table_id and branch_id=new.branch_id) then
    raise exception 'Order table does not belong to the order branch';
  end if;
  perform 1 from public.tables where id=new.table_id for update;
  select id into v_session_id from public.table_sessions where table_id=new.table_id and status='ACTIVE' order by opened_at desc limit 1;
  if v_session_id is null then
    insert into public.table_sessions(branch_id,table_id,status,occupancy_count)
    values(new.branch_id,new.table_id,'ACTIVE',0)
    returning id into v_session_id;
  end if;
  new.table_session_id := v_session_id;
  new.received_at := coalesce(new.received_at,now());
  return new;
end; $$;
drop trigger if exists build17_attach_order_session on public.orders;
create trigger build17_attach_order_session before insert on public.orders for each row execute function public.build17_attach_order_session();

-- Backfill existing orders into sessions without altering their statuses or totals.
do $$
declare r record; s uuid;
begin
  for r in
    select o.branch_id,o.table_id
    from public.orders o
    where o.table_session_id is null
      and (o.status not in ('COMPLETED','CANCELLED','REJECTED')
           or (o.status='COMPLETED' and o.payment_status<>'PAID'))
    group by o.branch_id,o.table_id
  loop
    select ts.id into s from public.table_sessions ts where ts.table_id=r.table_id and ts.status='ACTIVE' order by ts.opened_at desc limit 1;
    if s is null then
      insert into public.table_sessions(branch_id,table_id) values(r.branch_id,r.table_id) returning id into s;
    end if;
    update public.orders
    set table_session_id=s
    where branch_id=r.branch_id and table_id=r.table_id and table_session_id is null
      and (status not in ('COMPLETED','CANCELLED','REJECTED') or (status='COMPLETED' and payment_status<>'PAID'));
  end loop;
end $$;


-- Initialize item priority from order priority for historical rows.
update public.order_items oi set priority=o.priority from public.orders o where o.id=oi.order_id and oi.priority='NORMAL' and o.priority<>'NORMAL';

-- ============================================================
-- 5. Session RPCs
-- ============================================================
create or replace function public.open_table_session(p_table_id uuid,p_occupancy_count integer default 1)
returns public.table_sessions
language plpgsql security definer set search_path=public as $$
declare v_table public.tables%rowtype; v_session public.table_sessions%rowtype; v_count integer:=greatest(0,coalesce(p_occupancy_count,1)); v_user uuid:=auth.uid();
begin
  select * into v_table from public.tables where id=p_table_id for update;
  if v_table.id is null then raise exception 'Table not found'; end if;
  if not v_table.active then raise exception 'Table is inactive'; end if;
  if not public.current_user_has_permission_for_branch(v_table.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to seat this table' using errcode='42501'; end if;
  if v_count > v_table.seats then raise exception 'Occupancy exceeds table capacity'; end if;
  select * into v_session from public.table_sessions where table_id=p_table_id and status='ACTIVE' order by opened_at desc limit 1;
  if v_session.id is not null then
    raise exception 'Table already has an active session';
  end if;
  insert into public.table_sessions(branch_id,table_id,occupancy_count) values(v_table.branch_id,p_table_id,v_count) returning * into v_session;
  if v_table.seat_tracking_enabled then
    insert into public.table_seats(table_id,seat_number,status,session_id,occupied_at)
    select p_table_id,g,'OCCUPIED',v_session.id,now() from generate_series(1,v_count) g
    on conflict (table_id,seat_number) do update set status='OCCUPIED',session_id=excluded.session_id,occupied_at=excluded.occupied_at,released_at=null;
    update public.table_seats set status='FREE',session_id=null,released_at=now() where table_id=p_table_id and session_id<>v_session.id and status='OCCUPIED';
  end if;
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  select o.id,o.branch_id,'TABLE_SESSION_OPENED',v_user,jsonb_build_object('session_id',v_session.id,'table_id',p_table_id,'occupancy_count',v_count)
  from public.orders o where o.table_session_id=v_session.id limit 1;
  perform public.build17_sync_table_operational_state(p_table_id);
  return v_session;
end; $$;
grant execute on function public.open_table_session(uuid,integer) to authenticated;

create or replace function public.update_table_session_occupancy(p_session_id uuid,p_occupancy_count integer)
returns public.table_sessions
language plpgsql security definer set search_path=public as $$
declare v_session public.table_sessions%rowtype; v_table public.tables%rowtype; v_user uuid:=auth.uid(); v_count integer:=greatest(0,coalesce(p_occupancy_count,0));
begin
  select * into v_session from public.table_sessions where id=p_session_id for update;
  if v_session.id is null or v_session.status<>'ACTIVE' then raise exception 'Session is not active'; end if;
  select * into v_table from public.tables where id=v_session.table_id for update;
  if not public.current_user_has_permission_for_branch(v_session.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to change occupancy' using errcode='42501'; end if;
  if v_count>v_table.seats then raise exception 'Occupancy exceeds table capacity'; end if;
  update public.table_sessions set occupancy_count=v_count where id=v_session.id returning * into v_session;
  if v_table.seat_tracking_enabled then
    insert into public.table_seats(table_id,seat_number,status,session_id,occupied_at)
    select v_table.id,g,'OCCUPIED',v_session.id,now() from generate_series(1,v_count) g
    on conflict(table_id,seat_number) do update set status='OCCUPIED',session_id=excluded.session_id,occupied_at=coalesce(public.table_seats.occupied_at,excluded.occupied_at),released_at=null;
    update public.table_seats set status='FREE',session_id=null,released_at=now() where table_id=v_table.id and session_id=v_session.id and seat_number>v_count;
  end if;
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  select o.id,o.branch_id,'TABLE_OCCUPANCY_CHANGED',v_user,jsonb_build_object('session_id',v_session.id,'occupancy_count',v_count)
  from public.orders o where o.table_session_id=v_session.id order by o.created_at desc limit 1;
  perform public.build17_sync_table_operational_state(v_session.table_id);
  return v_session;
end; $$;
grant execute on function public.update_table_session_occupancy(uuid,integer) to authenticated;

create or replace function public.close_table_session(p_session_id uuid)
returns public.table_sessions
language plpgsql security definer set search_path=public as $$
declare v_session public.table_sessions%rowtype; v_table public.tables%rowtype; v_bad integer; v_unpaid integer; v_requests integer; v_user uuid:=auth.uid();
begin
  select * into v_session from public.table_sessions where id=p_session_id for update;
  if v_session.id is null then raise exception 'Session not found'; end if;
  if v_session.status='CLOSED' then return v_session; end if;
  select * into v_table from public.tables where id=v_session.table_id for update;
  if not public.current_user_has_permission_for_branch(v_session.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to close this session' using errcode='42501'; end if;
  select count(*) filter(where status not in ('COMPLETED','CANCELLED','REJECTED'))::int,count(*) filter(where payment_status<>'PAID' and status not in ('CANCELLED','REJECTED'))::int into v_bad,v_unpaid from public.orders where table_session_id=v_session.id;
  select count(*)::int into v_requests from public.service_requests where table_id=v_session.table_id and status in ('OPEN','ACKNOWLEDGED');
  if v_bad>0 then raise exception 'All orders must be completed, cancelled, or rejected before closing the session'; end if;
  if v_unpaid>0 then raise exception 'All payable orders must be settled before closing the session'; end if;
  if v_requests>0 then raise exception 'Outstanding service requests must be resolved before closing the session'; end if;
  update public.table_sessions set status='CLOSED',closed_at=now() where id=v_session.id returning * into v_session;
  if v_table.seat_tracking_enabled then update public.table_seats set status='FREE',session_id=null,released_at=now() where table_id=v_table.id and session_id=v_session.id; end if;
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  select o.id,o.branch_id,'TABLE_SESSION_CLOSED',v_user,jsonb_build_object('session_id',v_session.id,'table_id',v_table.id)
  from public.orders o where o.table_session_id=v_session.id order by o.created_at desc limit 1;
  perform public.build17_sync_table_operational_state(v_table.id);
  return v_session;
end; $$;
grant execute on function public.close_table_session(uuid) to authenticated;

-- ============================================================
-- 6. Order rejection / priority / reopen
-- ============================================================
create or replace function public.reject_order(
  p_order_id uuid,
  p_reason_code text,
  p_reason_note text default null
)
returns public.orders
language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype; v_user uuid:=auth.uid(); v_reason text:=upper(trim(coalesce(p_reason_code,''))); v_note text:=nullif(left(trim(coalesce(p_reason_note,'')),500),'');
begin
  select * into v_order from public.orders where id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if not public.current_user_has_permission_for_branch(v_order.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to reject this order' using errcode='42501'; end if;
  if v_order.status<>'NEW'::public.order_status then raise exception 'Only new orders can be rejected'; end if;
  if (v_order.payment_method='PAY_NOW' or left(coalesce(v_order.payment_method,''),8)='PAY_NOW:') and v_order.payment_status='PENDING'::public.payment_status then
    raise exception 'PAY_NOW order must be paid before restaurant action' using errcode='42501';
  end if;
  if v_reason not in ('ITEM_UNAVAILABLE','KITCHEN_TOO_BUSY','RESTAURANT_CLOSING','OUT_OF_STOCK','CUSTOMER_REQUESTED','RESTAURANT_CANNOT_FULFILL','OTHER') then raise exception 'Invalid rejection reason'; end if;
  update public.orders
  set status='REJECTED'::public.order_status,rejection_reason=v_reason,rejection_note=v_note,rejected_by=v_user,rejected_at=now(),updated_at=now()
  where id=v_order.id and status='NEW'::public.order_status
  returning * into v_order;
  if v_order.id is null then raise exception 'Order state changed before rejection'; end if;
  insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'ORDER_REJECTED','NEW','REJECTED',v_user,jsonb_build_object('reason_code',v_reason,'reason_note',v_note));
  perform public.build17_sync_table_operational_state(v_order.table_id);
  return v_order;
end; $$;
grant execute on function public.reject_order(uuid,text,text) to authenticated;

create or replace function public.set_order_priority(p_order_id uuid,p_priority text)
returns public.orders
language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype; v_user uuid:=auth.uid(); v_priority text:=upper(trim(coalesce(p_priority,'')));
begin
  select * into v_order from public.orders where id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if not public.current_user_has_permission_for_branch(v_order.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to change priority' using errcode='42501'; end if;
  if v_priority not in ('NORMAL','HIGH','URGENT') then raise exception 'Invalid priority'; end if;
  if v_order.priority=v_priority then return v_order; end if;
  update public.orders set priority=v_priority,updated_at=now() where id=v_order.id returning * into v_order;
  update public.order_items set priority=v_priority where order_id=v_order.id;
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'ORDER_PRIORITY_CHANGED',v_user,jsonb_build_object('priority',v_priority));
  return v_order;
end; $$;
grant execute on function public.set_order_priority(uuid,text) to authenticated;

create or replace function public.reopen_order(p_order_id uuid,p_reason text)
returns public.orders
language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype; v_user uuid:=auth.uid(); v_reason text:=nullif(left(trim(coalesce(p_reason,'')),500),'');
begin
  select * into v_order from public.orders where id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if not public.current_user_has_permission_for_branch(v_order.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to reopen this order' using errcode='42501'; end if;
  if v_order.status<>'COMPLETED'::public.order_status then raise exception 'Only completed orders can be reopened'; end if;
  if v_reason is null then raise exception 'Reopen reason is required'; end if;
  update public.orders set status='ACCEPTED'::public.order_status,reopened_at=now(),reopen_reason=v_reason,completed_at=null,updated_at=now() where id=v_order.id and status='COMPLETED'::public.order_status returning * into v_order;
  if v_order.id is null then raise exception 'Order state changed before reopen'; end if;
  insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'ORDER_REOPENED','COMPLETED','ACCEPTED',v_user,jsonb_build_object('reason',v_reason));
  perform public.build17_sync_table_operational_state(v_order.table_id);
  return v_order;
end; $$;
grant execute on function public.reopen_order(uuid,text) to authenticated;

-- ============================================================
-- 7. Item operations
-- ============================================================
create or replace function public.set_order_item_station(p_order_item_id uuid,p_station_id uuid)
returns public.order_items
language plpgsql security definer set search_path=public as $$
declare v_item public.order_items%rowtype; v_order public.orders%rowtype; v_station public.kitchen_stations%rowtype; v_user uuid:=auth.uid();
begin
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if v_item.id is null then raise exception 'Order item not found'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  if not public.current_user_has_permission_for_branch(v_order.branch_id,'EDIT_ORDERS') and not public.current_user_has_permission_for_branch(v_order.branch_id,'KITCHEN_ACCESS') then raise exception 'You are not authorized to change station' using errcode='42501'; end if;
  if p_station_id is not null then
    select * into v_station from public.kitchen_stations where id=p_station_id and branch_id=v_order.branch_id and is_active=true;
    if v_station.id is null then raise exception 'Invalid station for this branch'; end if;
  end if;
  update public.order_items set station_id=p_station_id,updated_at=now() where id=v_item.id returning * into v_item;
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'ORDER_ITEM_STATION_CHANGED',v_user,jsonb_build_object('order_item_id',v_item.id,'station_id',p_station_id));
  return v_item;
end; $$;
grant execute on function public.set_order_item_station(uuid,uuid) to authenticated;

create or replace function public.transition_order_item_status(p_order_item_id uuid,p_new_status text)
returns public.order_items
language plpgsql security definer set search_path=public as $$
declare v_item public.order_items%rowtype; v_order public.orders%rowtype; v_user uuid:=auth.uid(); v_new text:=upper(trim(coalesce(p_new_status,''))); v_current text; v_staff_id uuid; v_allowed_station boolean:=true; v_now timestamptz:=now();
begin
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if v_item.id is null then raise exception 'Order item not found'; end if;
  select * into v_order from public.orders where id=v_item.order_id for update;
  v_current:=coalesce(v_item.preparation_status,'PENDING');
  if not public.current_user_has_permission_for_branch(v_order.branch_id,'KITCHEN_ACCESS') and not public.current_user_has_permission_for_branch(v_order.branch_id,'EDIT_ORDERS') then raise exception 'Kitchen access denied' using errcode='42501'; end if;
  if (v_order.payment_method='PAY_NOW' or left(coalesce(v_order.payment_method,''),8)='PAY_NOW:') and v_order.payment_status='PENDING'::public.payment_status then
    raise exception 'PAY_NOW order must be paid before kitchen action' using errcode='42501';
  end if;
  if v_new not in ('PENDING','PREPARING','READY','SERVED','CANCELLED') then raise exception 'Invalid item status'; end if;
  if v_item.preparation_status=v_new then return v_item; end if;
  select s.id into v_staff_id from public.staff s where s.organization_id=(select organization_id from public.branches where id=v_order.branch_id) and s.user_id=auth.uid() and s.active=true and (s.role='OWNER' or s.branch_id=v_order.branch_id) limit 1;
  if v_staff_id is not null and v_item.station_id is not null then
    select exists(select 1 from public.kitchen_station_staff kss where kss.station_id=v_item.station_id and kss.staff_id=v_staff_id) into v_allowed_station;
    if not v_allowed_station and not public.current_user_has_permission_for_branch(v_order.branch_id,'EDIT_ORDERS') then raise exception 'Unauthorized station'; end if;
  end if;

  if v_new='PREPARING' and v_current not in ('PENDING','CANCELLED') then raise exception 'Invalid item state transition'; end if;
  if v_new='READY' and v_current<>'PREPARING' then raise exception 'Item must be preparing before it can be ready'; end if;
  if v_new='SERVED' and v_current<>'READY' then raise exception 'Item must be ready before it can be served'; end if;
  if v_new='CANCELLED' and v_current not in ('PENDING','PREPARING') then raise exception 'Item can no longer be cancelled'; end if;

  update public.order_items
  set preparation_status=v_new,
      started_at=case when v_new='PREPARING' then coalesce(started_at,v_now) else started_at end,
      ready_at=case when v_new='READY' then v_now else ready_at end,
      served_at=case when v_new='SERVED' then v_now else served_at end,
      completed_at=case when v_new='SERVED' then v_now else completed_at end,
      actual_prep_seconds=case when v_new='READY' and started_at is not null then greatest(0,extract(epoch from (v_now-started_at))::int) else actual_prep_seconds end
  where id=v_item.id
  returning * into v_item;

  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'ORDER_ITEM_STATUS_CHANGED',v_user,jsonb_build_object('order_item_id',v_item.id,'preparation_status',v_new));

  -- Aggregate item state into the order state without bypassing payment completion.
  if v_new='PREPARING' and v_order.status in ('ACCEPTED','NEW') then
    update public.orders set status='PREPARING'::public.order_status,started_at=coalesce(started_at,v_now),accepted_at=coalesce(accepted_at,v_now),updated_at=v_now where id=v_order.id and status in ('ACCEPTED','NEW');
    insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata)
    select v_order.id,v_order.branch_id,'STATUS_CHANGED',v_order.status::text,'PREPARING',v_user,jsonb_build_object('source','ITEM_STATUS');
  elsif v_new='READY' and not exists(select 1 from public.order_items oi where oi.order_id=v_order.id and oi.preparation_status not in ('READY','SERVED','CANCELLED')) then
    if v_order.status='PREPARING' then
      update public.orders set status='READY'::public.order_status,ready_at=v_now,updated_at=v_now where id=v_order.id and status='PREPARING';
      insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'STATUS_CHANGED','PREPARING','READY',v_user,jsonb_build_object('source','ITEM_STATUS'));
    end if;
  elsif v_new='SERVED' and not exists(select 1 from public.order_items oi where oi.order_id=v_order.id and oi.preparation_status not in ('SERVED','CANCELLED')) then
    if v_order.status='READY' then
      update public.orders set status='SERVED'::public.order_status,served_at=v_now,updated_at=v_now where id=v_order.id and status='READY';
      insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'STATUS_CHANGED','READY','SERVED',v_user,jsonb_build_object('source','ITEM_STATUS'));
    end if;
  end if;

  perform public.build17_sync_table_operational_state(v_order.table_id);
  return v_item;
end; $$;
grant execute on function public.transition_order_item_status(uuid,text) to authenticated;

create or replace function public.correct_order_item_status(p_order_item_id uuid,p_new_status text,p_reason text)
returns public.order_items
language plpgsql security definer set search_path=public as $$
declare v_item public.order_items%rowtype; v_order public.orders%rowtype; v_user uuid:=auth.uid(); v_new text:=upper(trim(coalesce(p_new_status,''))); v_reason text:=nullif(left(trim(coalesce(p_reason,'')),500),'');
begin
  if v_reason is null then raise exception 'Correction reason is required'; end if;
  select * into v_item from public.order_items where id=p_order_item_id for update;
  if v_item.id is null then raise exception 'Order item not found'; end if;
  select * into v_order from public.orders where id=v_item.order_id;
  if not public.current_user_has_permission_for_branch(v_order.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to correct item status' using errcode='42501'; end if;
  if v_new not in ('PENDING','PREPARING','READY','SERVED','CANCELLED') then raise exception 'Invalid item status'; end if;
  update public.order_items set preparation_status=v_new,updated_at=coalesce(updated_at,now()) where id=v_item.id returning * into v_item;
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'ORDER_OVERRIDE',v_user,jsonb_build_object('order_item_id',v_item.id,'new_status',v_new,'reason',v_reason));
  return v_item;
end; $$;
grant execute on function public.correct_order_item_status(uuid,text,text) to authenticated;

-- Station management RPCs.
create or replace function public.create_kitchen_station(p_branch_id uuid,p_name text,p_description text default null)
returns public.kitchen_stations
language plpgsql security definer set search_path=public as $$
declare v_row public.kitchen_stations%rowtype; v_name text:=nullif(left(trim(coalesce(p_name,'')),80),'');
begin
  if not public.current_user_has_permission_for_branch(p_branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to manage kitchen stations' using errcode='42501'; end if;
  if v_name is null then raise exception 'Station name is required'; end if;
  insert into public.kitchen_stations(branch_id,name,description,sort_order)
  values(p_branch_id,v_name,nullif(left(trim(coalesce(p_description,'')),250),''),(select coalesce(max(sort_order),0)+1 from public.kitchen_stations where branch_id=p_branch_id))
  returning * into v_row;
  return v_row;
exception when unique_violation then raise exception 'A station with this name already exists';
end; $$;
grant execute on function public.create_kitchen_station(uuid,text,text) to authenticated;

create or replace function public.set_kitchen_station_active(p_station_id uuid,p_active boolean)
returns public.kitchen_stations
language plpgsql security definer set search_path=public as $$
declare v_row public.kitchen_stations%rowtype;
begin
  select * into v_row from public.kitchen_stations where id=p_station_id for update;
  if v_row.id is null then raise exception 'Station not found'; end if;
  if not public.current_user_has_permission_for_branch(v_row.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to manage kitchen stations' using errcode='42501'; end if;
  update public.kitchen_stations set is_active=coalesce(p_active,false),updated_at=now() where id=v_row.id returning * into v_row;
  return v_row;
end; $$;
grant execute on function public.set_kitchen_station_active(uuid,boolean) to authenticated;

create or replace function public.assign_staff_to_kitchen_station(p_station_id uuid,p_staff_id uuid,p_assigned boolean)
returns boolean
language plpgsql security definer set search_path=public as $$
declare v_branch uuid; v_staff_branch uuid;
begin
  select branch_id into v_branch from public.kitchen_stations where id=p_station_id;
  if v_branch is null then raise exception 'Station not found'; end if;
  if not public.current_user_has_permission_for_branch(v_branch,'EDIT_ORDERS') then raise exception 'You are not authorized to assign station staff' using errcode='42501'; end if;
  select branch_id into v_staff_branch from public.staff where id=p_staff_id and active=true;
  if v_staff_branch is distinct from v_branch then raise exception 'Staff member does not belong to this branch'; end if;
  if p_assigned then insert into public.kitchen_station_staff(station_id,staff_id) values(p_station_id,p_staff_id) on conflict do nothing;
  else delete from public.kitchen_station_staff where station_id=p_station_id and staff_id=p_staff_id;
  end if;
  return true;
end; $$;
grant execute on function public.assign_staff_to_kitchen_station(uuid,uuid,boolean) to authenticated;

revoke execute on function public.build17_touch_table_session() from anon,authenticated,public;
revoke execute on function public.build17_touch_order_item() from anon,authenticated,public;
revoke execute on function public.build17_attach_order_session() from anon,authenticated,public;
-- Note: the trigger functions created in section 8/9 below
-- (build17_orders_sync_table_trigger, build17_service_sync_table_trigger,
-- build17_order_timing_trigger, build17_rejection_notification) don't exist
-- yet at this point in the script, so revoking on them here fails with
-- 42883. Their revokes are issued further down, immediately after they are
-- actually created.

-- ============================================================
-- 8. Server-derived table/session state synchronization triggers
-- ============================================================
create or replace function public.build17_orders_sync_table_trigger()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op='DELETE' then perform public.build17_sync_table_operational_state(old.table_id); elsif old.table_id is distinct from new.table_id then perform public.build17_sync_table_operational_state(old.table_id); perform public.build17_sync_table_operational_state(new.table_id); else perform public.build17_sync_table_operational_state(new.table_id); end if;
  return coalesce(new,old);
end; $$;
drop trigger if exists build17_orders_sync_table on public.orders;
create trigger build17_orders_sync_table after insert or delete or update of status,payment_status,table_session_id on public.orders for each row execute function public.build17_orders_sync_table_trigger();

create or replace function public.build17_service_sync_table_trigger()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if tg_op='DELETE' then perform public.build17_sync_table_operational_state(old.table_id); else perform public.build17_sync_table_operational_state(new.table_id); end if;
  return coalesce(new,old);
end; $$;
drop trigger if exists build17_service_sync_table on public.service_requests;
create trigger build17_service_sync_table after insert or delete or update of status on public.service_requests for each row execute function public.build17_service_sync_table_trigger();

-- Keep all newly observed timestamps coherent for direct payment updates that
-- already pass through existing verified RPCs.
create or replace function public.build17_order_timing_trigger()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status='ACCEPTED'::public.order_status and old.status is distinct from new.status then new.accepted_at=coalesce(new.accepted_at,now()); end if;
  if new.status='PREPARING'::public.order_status and old.status is distinct from new.status then new.started_at=coalesce(new.started_at,now()); end if;
  if new.status='READY'::public.order_status and old.status is distinct from new.status then new.ready_at=coalesce(new.ready_at,now()); end if;
  if new.status='SERVED'::public.order_status and old.status is distinct from new.status then new.served_at=coalesce(new.served_at,now()); end if;
  if new.status='COMPLETED'::public.order_status and old.status is distinct from new.status then new.completed_at=coalesce(new.completed_at,now()); end if;
  return new;
end; $$;
drop trigger if exists build17_order_timing on public.orders;
create trigger build17_order_timing before update of status on public.orders for each row execute function public.build17_order_timing_trigger();

-- ============================================================
-- 9. Rejection notification, realtime publication, RLS
-- ============================================================
create or replace function public.build17_rejection_notification()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_message text;
begin
  if tg_op='UPDATE' and new.status='REJECTED'::public.order_status and old.status is distinct from new.status then
    v_message:=format('Order #%s was declined by the restaurant.',coalesce(new.order_number::text,'—'));
    begin
      perform public.create_staff_notification(new.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_REJECTED','Order rejected',v_message,'ORDER',new.id,jsonb_build_object('order_status','REJECTED','reason',new.rejection_reason),null);
    exception when undefined_function then null;
    end;
  end if;
  return new;
end; $$;
drop trigger if exists build17_rejection_notification on public.orders;
create trigger build17_rejection_notification after update of status on public.orders for each row execute function public.build17_rejection_notification();

revoke execute on function public.build17_orders_sync_table_trigger() from anon,authenticated,public;
revoke execute on function public.build17_service_sync_table_trigger() from anon,authenticated,public;
revoke execute on function public.build17_order_timing_trigger() from anon,authenticated,public;
revoke execute on function public.build17_rejection_notification() from anon,authenticated,public;

alter table public.table_sessions enable row level security;
alter table public.table_seats enable row level security;
alter table public.kitchen_stations enable row level security;
alter table public.kitchen_station_staff enable row level security;

revoke all on public.table_sessions from anon,authenticated;
revoke all on public.table_seats from anon,authenticated;
revoke all on public.kitchen_stations from anon,authenticated;
revoke all on public.kitchen_station_staff from anon,authenticated;

drop policy if exists build17_table_sessions_select on public.table_sessions;
create policy build17_table_sessions_select on public.table_sessions for select to authenticated using (public.is_branch_member(branch_id));
grant select on public.table_sessions to authenticated;

drop policy if exists build17_table_seats_select on public.table_seats;
create policy build17_table_seats_select on public.table_seats for select to authenticated using (exists(select 1 from public.tables t where t.id=table_id and public.is_branch_member(t.branch_id)));
grant select on public.table_seats to authenticated;

drop policy if exists build17_kitchen_stations_select on public.kitchen_stations;
create policy build17_kitchen_stations_select on public.kitchen_stations for select to authenticated using (public.is_branch_member(branch_id));
grant select on public.kitchen_stations to authenticated;

drop policy if exists build17_station_staff_select on public.kitchen_station_staff;
create policy build17_station_staff_select on public.kitchen_station_staff for select to authenticated using (exists(select 1 from public.kitchen_stations k where k.id=station_id and public.is_branch_member(k.branch_id)));
grant select on public.kitchen_station_staff to authenticated;

-- Orders/order_items remain protected by the existing Build 13 RLS: updates
-- are still forbidden from the browser and operational mutations use RPCs.

alter table public.table_sessions replica identity full;
alter table public.table_seats replica identity full;
alter table public.kitchen_stations replica identity full;
alter table public.kitchen_station_staff replica identity full;
alter table public.order_items replica identity full;

-- Add only the new operational tables to the existing realtime publication.
do $$ begin
  begin alter publication supabase_realtime add table public.table_sessions; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.table_seats; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.kitchen_stations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.kitchen_station_staff; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.order_items; exception when duplicate_object then null; end;
end $$;

-- Re-sync existing tables after migration.
do $$ declare r record; begin for r in select id from public.tables loop perform public.build17_sync_table_operational_state(r.id); end loop; end $$;

-- ============================================================
-- 10. Public tracking V2 (additive; the Build 16 get_public_order RPC remains untouched)
-- ============================================================
drop function if exists public.get_public_order_v2(text);
create function public.get_public_order_v2(p_tracking_token text)
returns table (
  order_id uuid, order_number bigint, restaurant_name text, table_number integer,
  status public.order_status, payment_status public.payment_status, payment_method text,
  subtotal numeric, tax numeric, additional_charges numeric, discount numeric, total numeric,
  charge_breakdown jsonb, created_at timestamptz, payment_started_at timestamptz,
  payment_expires_at timestamptz, cancellation_reason text, rejection_reason text,
  rejection_note text, item_id uuid, item_name text, quantity integer, unit_price numeric,
  line_total numeric, selected_addons jsonb, special_instructions text, selected_options jsonb,
  configuration_snapshot jsonb
)
language plpgsql security definer set search_path=public as $$
declare v_order_id uuid;
begin
  select o.id into v_order_id from public.orders o where o.tracking_token=trim(p_tracking_token) limit 1;
  if v_order_id is null then return; end if;
  perform public.expire_awaiting_payment_orders_for_order(v_order_id);
  return query
  select o.id,o.order_number,org.name,t.table_number,o.status,o.payment_status,o.payment_method,
         o.subtotal,o.tax,o.additional_charges,o.discount,o.total,o.charge_breakdown,o.created_at,
         o.payment_started_at,o.payment_expires_at,o.cancellation_reason,o.rejection_reason,o.rejection_note,
         oi.id,oi.item_name_snapshot,oi.quantity,oi.unit_price,oi.line_total,oi.selected_addons,
         oi.special_instructions,oi.selected_options,oi.configuration_snapshot
  from public.orders o
  join public.tables t on t.id=o.table_id
  join public.branches b on b.id=o.branch_id
  join public.organizations org on org.id=b.organization_id
  left join public.order_items oi on oi.order_id=o.id
  where o.id=v_order_id
  order by oi.id asc;
end; $$;
grant execute on function public.get_public_order_v2(text) to anon,authenticated;
revoke execute on function public.get_public_order_v2(text) from public;

commit;

select pg_notify('pgrst','reload schema');
