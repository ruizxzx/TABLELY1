begin;

create table if not exists public.table_session_close_overrides (
  session_id uuid primary key references public.table_sessions(id) on delete restrict,
  branch_id uuid not null,
  actor_user_id uuid not null,
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  cancelled_order_snapshot jsonb not null check (jsonb_typeof(cancelled_order_snapshot) = 'array'),
  created_at timestamptz not null default now()
);

alter table public.table_session_close_overrides enable row level security;
revoke all on public.table_session_close_overrides from public, anon, authenticated;

create or replace function public.build20_close_session_core(
  p_session_id uuid,
  p_actor_user_id uuid,
  p_source text
)
returns public.table_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.table_sessions%rowtype;
  v_table public.tables%rowtype;
  v_bad integer;
  v_unpaid integer;
  v_requests integer;
  v_pending_payment integer;
  v_unresolved_cancelled_payment integer;
  v_has_cancelled_override boolean := false;
begin
  select * into v_session
  from public.table_sessions
  where id = p_session_id
  for update;
  if v_session.id is null then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  if v_session.status = 'CLOSED' then
    return v_session;
  end if;

  select * into v_table
  from public.tables
  where id = v_session.table_id
  for update;

  select count(*)::int into v_pending_payment
  from public.payment_attempts pa
  where pa.status in ('PENDING', 'PROCESSING')
    and pa.payment_expires_at > now()
    and (
      pa.table_session_id = v_session.id
      or (
        v_session.session_token_hash is not null
        and pa.visit_token_hash = v_session.session_token_hash
      )
    );
  if v_pending_payment > 0 then
    raise exception 'Payment verification is still pending for this session' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.table_session_close_overrides as o
    where o.session_id = v_session.id
      and o.actor_user_id = p_actor_user_id
      and o.branch_id = v_session.branch_id
  ) into v_has_cancelled_override;

  select count(*)::int into v_unresolved_cancelled_payment
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
    and o.payment_status not in ('FAILED'::public.payment_status, 'REFUNDED'::public.payment_status);
  if v_unresolved_cancelled_payment > 0 and not v_has_cancelled_override then
    raise exception 'Cancelled or rejected orders have unresolved payment state' using errcode = 'P0001';
  end if;

  select count(*)::int into v_unpaid
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
    and o.payment_status <> 'PAID'::public.payment_status;
  if v_unpaid > 0 then
    raise exception 'All payable orders must be settled before closing the session' using errcode = 'P0001';
  end if;

  select count(*)::int into v_bad
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in (
      'COMPLETED'::public.order_status,
      'CANCELLED'::public.order_status,
      'REJECTED'::public.order_status,
      'SERVED'::public.order_status
    );
  if v_bad > 0 then
    raise exception 'All orders must be completed, served, cancelled, or rejected before closing the session' using errcode = 'P0001';
  end if;

  with finalized as (
    update public.orders o
    set status = 'COMPLETED'::public.order_status,
        updated_at = now()
    where o.table_session_id = v_session.id
      and o.status = 'SERVED'::public.order_status
      and o.payment_status = 'PAID'::public.payment_status
    returning o.id, o.branch_id
  )
  insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
  select f.id, f.branch_id, 'ORDER_COMPLETED', p_actor_user_id,
         jsonb_build_object(
           'source', coalesce(p_source, 'SESSION_CLOSE'),
           'session_id', v_session.id,
           'reason', 'SERVED_ORDER_FINALIZED_ON_SESSION_CLOSE'
         )
  from finalized f;

  select count(*)::int into v_requests
  from public.service_requests r
  where r.status in ('OPEN', 'ACKNOWLEDGED')
    and r.table_session_id = v_session.id;
  if v_requests > 0 then
    raise exception 'Outstanding service requests must be resolved before closing the session' using errcode = 'P0001';
  end if;

  select count(*)::int into v_bad
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in (
      'COMPLETED'::public.order_status,
      'CANCELLED'::public.order_status,
      'REJECTED'::public.order_status
    );
  if v_bad > 0 then
    raise exception 'Session still has active orders and cannot be closed' using errcode = 'P0001';
  end if;

  update public.table_sessions
  set status = 'CLOSED',
      closed_at = now(),
      closed_by = p_actor_user_id,
      updated_at = now()
  where id = v_session.id
  returning * into v_session;

  if v_table.seat_tracking_enabled then
    update public.table_seats
    set status = 'FREE',
        session_id = null,
        released_at = now()
    where table_id = v_table.id
      and session_id = v_session.id;
  end if;

  insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
  select o.id, o.branch_id, 'TABLE_SESSION_CLOSED', p_actor_user_id,
         jsonb_build_object('session_id', v_session.id, 'table_id', v_table.id, 'source', coalesce(p_source, 'SESSION_CLOSE'))
  from public.orders o
  where o.table_session_id = v_session.id
  order by o.created_at desc
  limit 1;

  perform public.build17_sync_table_operational_state(v_table.id);
  return v_session;
end;
$$;

revoke execute on function public.build20_close_session_core(uuid, uuid, text) from anon, authenticated, public;

create or replace function public.force_close_table_session_for_cancelled_orders(
  p_session_id uuid,
  p_reason text
)
returns public.table_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.table_sessions%rowtype;
  v_unresolved_cancelled_payment integer;
  v_unpaid integer;
  v_active integer;
  v_pending_payment integer;
  v_requests integer;
  v_reason text := trim(coalesce(p_reason, ''));
  v_snapshot jsonb;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Authentication is required to force-close a session' using errcode = '42501';
  end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'Provide a reason between 10 and 500 characters' using errcode = '22023';
  end if;

  select * into v_session
  from public.table_sessions
  where id = p_session_id
  for update;
  if v_session.id is null then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  if v_session.status = 'CLOSED' then
    raise exception 'This session is already closed' using errcode = 'P0001';
  end if;
  if not public.current_user_has_permission_for_branch(v_session.branch_id, 'EDIT_ORDERS') then
    raise exception 'You are not authorized to force-close this session' using errcode = '42501';
  end if;

  select count(*)::int into v_unresolved_cancelled_payment
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
    and o.payment_status not in ('FAILED'::public.payment_status, 'REFUNDED'::public.payment_status);
  if v_unresolved_cancelled_payment = 0 then
    raise exception 'No cancelled or rejected order requires this override; use normal session closure' using errcode = 'P0001';
  end if;

  select count(*)::int into v_pending_payment
  from public.payment_attempts pa
  where pa.status in ('PENDING', 'PROCESSING')
    and pa.payment_expires_at > now()
    and (
      pa.table_session_id = v_session.id
      or (
        v_session.session_token_hash is not null
        and pa.visit_token_hash = v_session.session_token_hash
      )
    );
  if v_pending_payment > 0 then
    raise exception 'Payment verification is still pending; this blocker cannot be force-closed' using errcode = 'P0001';
  end if;

  select count(*)::int into v_unpaid
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
    and o.payment_status <> 'PAID'::public.payment_status;
  if v_unpaid > 0 then
    raise exception 'Unpaid active orders must be settled before closing the session' using errcode = 'P0001';
  end if;

  select count(*)::int into v_active
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in (
      'COMPLETED'::public.order_status,
      'CANCELLED'::public.order_status,
      'REJECTED'::public.order_status,
      'SERVED'::public.order_status
    );
  if v_active > 0 then
    raise exception 'Active orders must be completed or cancelled before closing the session' using errcode = 'P0001';
  end if;

  select count(*)::int into v_requests
  from public.service_requests r
  where r.status in ('OPEN', 'ACKNOWLEDGED')
    and r.table_session_id = v_session.id;
  if v_requests > 0 then
    raise exception 'Outstanding service requests must be resolved before closing the session' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'status', o.status,
    'payment_status', o.payment_status,
    'total', o.total
  ) order by o.created_at, o.id), '[]'::jsonb)
  into v_snapshot
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
    and o.payment_status not in ('FAILED'::public.payment_status, 'REFUNDED'::public.payment_status);

  insert into public.table_session_close_overrides (
    session_id, branch_id, actor_user_id, reason, cancelled_order_snapshot
  ) values (
    v_session.id, v_session.branch_id, v_actor, v_reason, v_snapshot
  );

  return public.build20_close_session_core(v_session.id, v_actor, 'FORCED_CANCELLED_ORDER_REVIEW');
end;
$$;

revoke all on function public.force_close_table_session_for_cancelled_orders(uuid, text) from public, anon;
grant execute on function public.force_close_table_session_for_cancelled_orders(uuid, text) to authenticated;
alter function public.force_close_table_session_for_cancelled_orders(uuid, text) set search_path = '';

commit;
