begin;

alter table public.table_sessions
  add column if not exists closed_by uuid references auth.users(id) on delete set null;

create or replace function public.build20_close_session_core(
  p_session_id uuid,
  p_actor_user_id uuid,
  p_source text
)
returns public.table_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.table_sessions%rowtype;
  v_table public.tables%rowtype;
  v_bad integer;
  v_unpaid integer;
  v_requests integer;
  v_pending_payment integer;
  v_unresolved_cancelled_payment integer;
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

  select count(*)::int into v_unresolved_cancelled_payment
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
    and o.payment_status not in ('FAILED'::public.payment_status, 'REFUNDED'::public.payment_status);
  if v_unresolved_cancelled_payment > 0 then
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
alter function public.build20_close_session_core(uuid, uuid, text) set search_path = public;

create or replace function public.get_table_session_management(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_session public.table_sessions%rowtype;
  v_table public.tables%rowtype;
  v_order_count integer;
  v_active_orders integer;
  v_unpaid_orders integer;
  v_unresolved_cancelled_payment integer;
  v_open_requests integer;
  v_pending_payments integer;
  v_total numeric(12, 2);
  v_collected numeric(12, 2);
  v_outstanding numeric(12, 2);
  v_reasons jsonb := '[]'::jsonb;
  v_orders jsonb := '[]'::jsonb;
  v_payments jsonb := '[]'::jsonb;
begin
  select * into v_session
  from public.table_sessions
  where id = p_session_id;
  if v_session.id is null then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;

  if not public.current_user_has_permission_for_branch(v_session.branch_id, 'EDIT_ORDERS') then
    raise exception 'You are not authorized to inspect this session' using errcode = '42501';
  end if;

  select * into v_table
  from public.tables
  where id = v_session.table_id;

  select
    count(*)::int,
    count(*) filter (
      where o.status not in (
        'COMPLETED'::public.order_status,
        'CANCELLED'::public.order_status,
        'REJECTED'::public.order_status,
        'SERVED'::public.order_status
      )
    )::int,
    count(*) filter (
      where o.status not in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
        and o.payment_status <> 'PAID'::public.payment_status
    )::int,
    count(*) filter (
      where o.status in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
        and o.payment_status not in ('FAILED'::public.payment_status, 'REFUNDED'::public.payment_status)
    )::int,
    coalesce(sum(o.total), 0)::numeric(12, 2),
    coalesce(sum(o.total) filter (where o.payment_status = 'PAID'::public.payment_status), 0)::numeric(12, 2),
    coalesce(sum(o.total) filter (
      where o.status not in ('CANCELLED'::public.order_status, 'REJECTED'::public.order_status)
        and o.payment_status <> 'PAID'::public.payment_status
    ), 0)::numeric(12, 2)
  into v_order_count, v_active_orders, v_unpaid_orders, v_unresolved_cancelled_payment, v_total, v_collected, v_outstanding
  from public.orders o
  where o.table_session_id = v_session.id;

  select count(*)::int into v_open_requests
  from public.service_requests r
  where r.status in ('OPEN', 'ACKNOWLEDGED')
    and r.table_session_id = v_session.id;

  select count(*)::int into v_pending_payments
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

  if v_session.status = 'CLOSED' then
    v_reasons := v_reasons || jsonb_build_array('This session is already closed.');
  end if;
  if v_active_orders > 0 then
    v_reasons := v_reasons || jsonb_build_array(format('%s active order(s) must be completed or cancelled.', v_active_orders));
  end if;
  if v_unpaid_orders > 0 then
    v_reasons := v_reasons || jsonb_build_array(format('%s payable order(s) still have an outstanding balance.', v_unpaid_orders));
  end if;
  if v_unresolved_cancelled_payment > 0 then
    v_reasons := v_reasons || jsonb_build_array(format('%s cancelled or rejected order(s) need payment/refund review.', v_unresolved_cancelled_payment));
  end if;
  if v_pending_payments > 0 then
    v_reasons := v_reasons || jsonb_build_array(format('%s payment verification(s) are still pending.', v_pending_payments));
  end if;
  if v_open_requests > 0 then
    v_reasons := v_reasons || jsonb_build_array(format('%s service request(s) are unresolved.', v_open_requests));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', o.id,
    'order_number', o.order_number,
    'status', o.status,
    'payment_status', o.payment_status,
    'payment_method', o.payment_method,
    'total', o.total,
    'created_at', o.created_at,
    'paid_at', o.paid_at,
    'customer_name', o.customer_name,
    'customer_phone', o.customer_phone
  ) order by o.created_at, o.id), '[]'::jsonb)
  into v_orders
  from public.orders o
  where o.table_session_id = v_session.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_id', pt.order_id,
    'order_number', o.order_number,
    'amount', pt.amount,
    'currency', pt.currency,
    'status', pt.status,
    'method', pt.method,
    'provider', pt.provider,
    'created_at', pt.created_at
  ) order by pt.created_at desc, pt.id), '[]'::jsonb)
  into v_payments
  from public.payment_transactions pt
  join public.orders o on o.id = pt.order_id
  where o.table_session_id = v_session.id
    and pt.branch_id = v_session.branch_id;

  return jsonb_build_object(
    'session_id', v_session.id,
    'table_id', v_table.id,
    'table_number', v_table.table_number,
    'session_status', v_session.status,
    'opened_at', v_session.opened_at,
    'closed_at', v_session.closed_at,
    'closed_by', v_session.closed_by,
    'customer_name', v_session.customer_name,
    'customer_phone', v_session.customer_phone,
    'order_count', v_order_count,
    'total', v_total,
    'collected', v_collected,
    'outstanding', v_outstanding,
    'can_close', jsonb_array_length(v_reasons) = 0,
    'reasons', v_reasons,
    'orders', v_orders,
    'payments', v_payments
  );
end;
$$;

revoke execute on function public.get_table_session_management(uuid) from anon, public;
grant execute on function public.get_table_session_management(uuid) to authenticated;
alter function public.get_table_session_management(uuid) set search_path = public;

commit;
