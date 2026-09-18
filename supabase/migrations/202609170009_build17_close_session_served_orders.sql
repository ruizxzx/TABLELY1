-- TABLELY BUILD 17.9 — close sessions after served orders are settled
-- Additive hotfix for sessions containing SERVED + PAID orders.
-- Closing a session is allowed to finalize already-served paid orders to COMPLETED
-- atomically, then close the session. Unpaid served/PAY_NOW legacy orders remain blocked.

create or replace function public.close_table_session(p_session_id uuid)
returns public.table_sessions
language plpgsql
security definer
set search_path=public
as $$
declare
  v_session public.table_sessions%rowtype;
  v_table public.tables%rowtype;
  v_bad integer;
  v_unpaid integer;
  v_requests integer;
  v_user uuid:=auth.uid();
begin
  select * into v_session
  from public.table_sessions
  where id=p_session_id
  for update;

  if v_session.id is null then
    raise exception 'Session not found' using errcode='P0002';
  end if;

  if v_session.status='CLOSED' then
    return v_session;
  end if;

  select * into v_table
  from public.tables
  where id=v_session.table_id
  for update;

  if not public.current_user_has_permission_for_branch(v_session.branch_id,'EDIT_ORDERS') then
    raise exception 'You are not authorized to close this session' using errcode='42501';
  end if;

  -- Served orders are operationally finished. If they are already paid,
  -- closing the session finalizes them to COMPLETED. This avoids trapping a
  -- perfectly valid paid session behind a manual status click.
  select count(*)::int into v_unpaid
  from public.orders o
  where o.table_session_id=v_session.id
    and o.status not in ('CANCELLED'::public.order_status,'REJECTED'::public.order_status)
    and o.payment_status<>'PAID'::public.payment_status;

  if v_unpaid>0 then
    raise exception 'All payable orders must be settled before closing the session' using errcode='P0001';
  end if;

  select count(*)::int into v_bad
  from public.orders o
  where o.table_session_id=v_session.id
    and o.status not in (
      'COMPLETED'::public.order_status,
      'CANCELLED'::public.order_status,
      'REJECTED'::public.order_status,
      'SERVED'::public.order_status
    );

  if v_bad>0 then
    raise exception 'All orders must be completed, served, cancelled, or rejected before closing the session' using errcode='P0001';
  end if;

  -- Finalize any served+paid orders. The UPDATE and corresponding audit events
  -- happen from the same statement so only rows actually finalized here are
  -- audited; no timestamp-based approximation is used.
  with finalized as (
    update public.orders o
    set status='COMPLETED'::public.order_status,
        updated_at=now()
    where o.table_session_id=v_session.id
      and o.status='SERVED'::public.order_status
      and o.payment_status='PAID'::public.payment_status
    returning o.id,o.branch_id
  )
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  select f.id,
         f.branch_id,
         'ORDER_COMPLETED',
         v_user,
         jsonb_build_object(
           'source','BUILD17_SESSION_CLOSE',
           'session_id',v_session.id,
           'reason','SERVED_ORDER_FINALIZED_ON_SESSION_CLOSE'
         )
  from finalized f;

  select count(*)::int into v_requests
  from public.service_requests r
  where r.table_id=v_session.table_id
    and r.status in ('OPEN','ACKNOWLEDGED');

  if v_requests>0 then
    raise exception 'Outstanding service requests must be resolved before closing the session' using errcode='P0001';
  end if;

  -- Recheck after finalizing served orders so a concurrent/stale state cannot
  -- be mistaken for a closable session.
  select count(*)::int into v_bad
  from public.orders o
  where o.table_session_id=v_session.id
    and o.status not in (
      'COMPLETED'::public.order_status,
      'CANCELLED'::public.order_status,
      'REJECTED'::public.order_status
    );

  if v_bad>0 then
    raise exception 'Session still has active orders and cannot be closed' using errcode='P0001';
  end if;

  update public.table_sessions
  set status='CLOSED',
      closed_at=now(),
      updated_at=now()
  where id=v_session.id
  returning * into v_session;

  if v_table.seat_tracking_enabled then
    update public.table_seats
    set status='FREE',
        session_id=null,
        released_at=now()
    where table_id=v_table.id
      and session_id=v_session.id;
  end if;

  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  select o.id,
         o.branch_id,
         'TABLE_SESSION_CLOSED',
         v_user,
         jsonb_build_object('session_id',v_session.id,'table_id',v_table.id)
  from public.orders o
  where o.table_session_id=v_session.id
  order by o.created_at desc
  limit 1;

  perform public.build17_sync_table_operational_state(v_table.id);
  return v_session;
end;
$$;

grant execute on function public.close_table_session(uuid) to authenticated;
alter function public.close_table_session(uuid) set search_path=public;
