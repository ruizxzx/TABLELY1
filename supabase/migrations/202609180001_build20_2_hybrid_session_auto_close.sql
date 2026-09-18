-- TABLELY BUILD 20.2 — HYBRID SESSION AUTO-CLOSE
--
-- Scope: additive only. No table, column, or existing-function SIGNATURE is
-- added/removed/renamed at the schema level beyond what is described below.
-- Builds 1-19.4 are untouched except that close_table_session's BODY is
-- refactored to delegate to a new shared core function so the auto-close path
-- can reuse the exact same safeguards instead of duplicating them (per the
-- Build 20.2 brief, section 10). close_table_session keeps its identical
-- signature, permission check, and error behaviour for staff.
--
-- What this migration adds
--   1. build20_close_session_core(uuid, uuid, text) — the actual close
--      transition + safeguards, extracted verbatim from close_table_session.
--      Internal only (revoked from anon/authenticated/public).
--   2. close_table_session(uuid) — re-created at the SAME signature; now just
--      does the staff-authorization check and delegates to the core.
--   3. build20_session_is_settled(uuid) — read-only eligibility check for
--      "fully settled": no non-terminal orders, no unpaid orders, no blocking
--      open service request on this session, no in-flight payment attempt
--      for this session or this session's own visit token.
--   4. build20_auto_close_settled_sessions(uuid, uuid) — for a table_id and a
--      newly-created session id, closes every OTHER open session on that
--      table that build20_session_is_settled() approves, via the shared core.
--      Never touches the new session itself. Any failure closing one old
--      session (e.g. a concurrent update) is swallowed so it can never break
--      the customer's own order/payment write.
--   5. build19_resolve_session_by_hash — one added line: immediately after a
--      genuinely NEW session row is inserted (the visit token did not match
--      an existing open session on this table), it calls
--      build20_auto_close_settled_sessions for that table. This is the single
--      trigger point required by the brief ("a genuinely NEW independent
--      session is successfully created") — reached only from
--      create_order_for_table_v18's first order and from
--      finalize_payment_attempt_v18's post-verification resolution, exactly
--      as before. create_service_request_for_table calls this same resolver
--      with p_create_if_missing = false, so it can never reach the insert
--      branch and can never trigger auto-close — a service request still
--      never creates or closes a session.
--
-- What this migration does NOT do
--   - No change to create_order_for_table_v18, create_payment_attempt_for_table_v18,
--     or finalize_payment_attempt_v18 (signatures and bodies untouched).
--   - No change to Razorpay verification, payment-attempt state machine, or
--     idempotency.
--   - No change to table_sessions/orders/service_requests/payment_attempts
--     schema. No new table.
--   - No change to occupancy/table-state derivation
--     (build17_sync_table_operational_state is only ever invoked, not edited).

begin;

-- ============================================================
-- 1. Shared close core (identical logic to the current close_table_session,
--    minus the staff-authorization check, plus a caller-supplied actor id and
--    a source label for the audit trail).
-- ============================================================
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
begin
  select * into v_session from public.table_sessions where id = p_session_id for update;
  if v_session.id is null then raise exception 'Session not found' using errcode='P0002'; end if;
  if v_session.status = 'CLOSED' then return v_session; end if;

  select * into v_table from public.tables where id = v_session.table_id for update;

  select count(*)::int into v_unpaid
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in ('CANCELLED'::public.order_status,'REJECTED'::public.order_status)
    and o.payment_status <> 'PAID'::public.payment_status;
  if v_unpaid > 0 then
    raise exception 'All payable orders must be settled before closing the session' using errcode='P0001';
  end if;

  select count(*)::int into v_bad
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in ('COMPLETED'::public.order_status,'CANCELLED'::public.order_status,'REJECTED'::public.order_status,'SERVED'::public.order_status);
  if v_bad > 0 then
    raise exception 'All orders must be completed, served, cancelled, or rejected before closing the session' using errcode='P0001';
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
         jsonb_build_object('source', coalesce(p_source,'SESSION_CLOSE'), 'session_id', v_session.id, 'reason', 'SERVED_ORDER_FINALIZED_ON_SESSION_CLOSE')
  from finalized f;

  -- Only this session's own open service requests block it (Build 19.2 rule,
  -- preserved verbatim).
  select count(*)::int into v_requests
  from public.service_requests r
  where r.status in ('OPEN','ACKNOWLEDGED')
    and r.table_session_id = v_session.id;
  if v_requests > 0 then
    raise exception 'Outstanding service requests must be resolved before closing the session' using errcode='P0001';
  end if;

  select count(*)::int into v_bad
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in ('COMPLETED'::public.order_status,'CANCELLED'::public.order_status,'REJECTED'::public.order_status);
  if v_bad > 0 then
    raise exception 'Session still has active orders and cannot be closed' using errcode='P0001';
  end if;

  update public.table_sessions
  set status = 'CLOSED', closed_at = now(), updated_at = now()
  where id = v_session.id
  returning * into v_session;

  if v_table.seat_tracking_enabled then
    update public.table_seats
    set status = 'FREE', session_id = null, released_at = now()
    where table_id = v_table.id and session_id = v_session.id;
  end if;

  insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
  select o.id, o.branch_id, 'TABLE_SESSION_CLOSED', p_actor_user_id,
         jsonb_build_object('session_id', v_session.id, 'table_id', v_table.id, 'source', coalesce(p_source,'SESSION_CLOSE'))
  from public.orders o
  where o.table_session_id = v_session.id
  order by o.created_at desc
  limit 1;

  perform public.build17_sync_table_operational_state(v_table.id);
  return v_session;
end;
$$;
revoke execute on function public.build20_close_session_core(uuid, uuid, text) from anon, authenticated, public;

-- ============================================================
-- 2. close_table_session — SAME signature, SAME staff-authorization
--    requirement and error, now delegating the actual close to the core.
-- ============================================================
create or replace function public.close_table_session(p_session_id uuid)
returns public.table_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.table_sessions%rowtype;
  v_user uuid := auth.uid();
begin
  select * into v_session from public.table_sessions where id = p_session_id;
  if v_session.id is null then raise exception 'Session not found' using errcode='P0002'; end if;

  if not public.current_user_has_permission_for_branch(v_session.branch_id,'EDIT_ORDERS') then
    raise exception 'You are not authorized to close this session' using errcode='42501';
  end if;

  return public.build20_close_session_core(p_session_id, v_user, 'MANUAL_STAFF_CLOSE');
end;
$$;
grant execute on function public.close_table_session(uuid) to authenticated;
alter function public.close_table_session(uuid) set search_path = public;
revoke execute on function public.close_table_session(uuid) from anon, public;

-- ============================================================
-- 3. "Fully settled" eligibility check (read-only, no side effects)
-- ============================================================
create or replace function public.build20_session_is_settled(p_session_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_session public.table_sessions%rowtype;
  v_bad integer;
  v_unpaid integer;
  v_requests integer;
  v_pending_payment integer;
begin
  select * into v_session from public.table_sessions where id = p_session_id;
  if v_session.id is null or v_session.status = 'CLOSED' then
    return false;
  end if;

  -- No unfinished/active operational work (mirrors close_table_session).
  select count(*)::int into v_bad
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in ('COMPLETED'::public.order_status,'CANCELLED'::public.order_status,'REJECTED'::public.order_status,'SERVED'::public.order_status);
  if v_bad > 0 then return false; end if;

  -- No payable order left unpaid.
  select count(*)::int into v_unpaid
  from public.orders o
  where o.table_session_id = v_session.id
    and o.status not in ('CANCELLED'::public.order_status,'REJECTED'::public.order_status)
    and o.payment_status <> 'PAID'::public.payment_status;
  if v_unpaid > 0 then return false; end if;

  -- No blocking unresolved service request on THIS session.
  select count(*)::int into v_requests
  from public.service_requests r
  where r.status in ('OPEN','ACKNOWLEDGED')
    and r.table_session_id = v_session.id;
  if v_requests > 0 then return false; end if;

  -- No payment attempt for this session in flight. A PAY_NOW re-order from
  -- this same visit is only linked to the session once verified (Build
  -- 19.1), so it is matched here on visit_token_hash as well as on an
  -- already-linked table_session_id.
  select count(*)::int into v_pending_payment
  from public.payment_attempts pa
  where pa.status in ('PENDING','PROCESSING')
    and pa.payment_expires_at > now()
    and (
      pa.table_session_id = v_session.id
      or (v_session.session_token_hash is not null and pa.visit_token_hash = v_session.session_token_hash)
    );
  if v_pending_payment > 0 then return false; end if;

  return true;
end;
$$;
revoke execute on function public.build20_session_is_settled(uuid) from anon, authenticated, public;

-- ============================================================
-- 4. Auto-close every OTHER settled open session on the same table
-- ============================================================
create or replace function public.build20_auto_close_settled_sessions(
  p_table_id uuid,
  p_new_session_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in
    select ts.id
    from public.table_sessions ts
    where ts.table_id = p_table_id
      and ts.status in ('ACTIVE','SETTLING')
      and ts.id <> p_new_session_id
    order by ts.opened_at
  loop
    if public.build20_session_is_settled(r.id) then
      begin
        perform public.build20_close_session_core(r.id, null, 'AUTO_SETTLED_ON_NEW_VISIT');
      exception when others then
        -- Never let an auto-close race break the customer's own order or
        -- payment write. Worst case: the old session simply stays open and a
        -- manager closes it manually.
        null;
      end;
    end if;
  end loop;
end;
$$;
revoke execute on function public.build20_auto_close_settled_sessions(uuid, uuid) from anon, authenticated, public;

-- ============================================================
-- 5. Single trigger point: right after a genuinely NEW session is inserted
-- ============================================================
create or replace function public.build19_resolve_session_by_hash(
  p_table_id uuid,
  p_branch_id uuid,
  p_visit_hash text,
  p_device_hash text,
  p_create_if_missing boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- Only the visit token can adopt an existing session, and only an OPEN one on
  -- THIS table. A device token never adopts a session: the same browser in the
  -- hands of a different customer must not inherit the previous visit.
  if p_visit_hash is not null then
    select ts.id into v_id
    from public.table_sessions ts
    where ts.session_token_hash = p_visit_hash
      and ts.table_id = p_table_id
      and ts.status in ('ACTIVE','SETTLING')
    limit 1;
    if v_id is not null then
      update public.table_sessions set last_seen_at = now() where id = v_id;
      return v_id;
    end if;
  end if;

  if not p_create_if_missing then
    return null;
  end if;

  -- Reached only from an actual order (or a verified PAY_NOW finalization),
  -- never from a scan or a service request — hence CUSTOMER_ORDER.
  insert into public.table_sessions(branch_id, table_id, status, occupancy_count, origin, session_token_hash, device_token_hash)
  values (p_branch_id, p_table_id, 'ACTIVE', 0, 'CUSTOMER_ORDER', p_visit_hash, p_device_hash)
  returning id into v_id;

  -- Adopt this SAME visit's still-open service requests (the waiter they called
  -- before ordering). Scoped to the identical visit token hash and table, so no
  -- other customer's request is ever moved, and resolved history is untouched.
  if p_visit_hash is not null then
    update public.service_requests r
    set table_session_id = v_id
    where r.table_id = p_table_id
      and r.table_session_id is null
      and r.visit_token_hash = p_visit_hash
      and r.status in ('OPEN','ACKNOWLEDGED');
  end if;

  -- Build 20.2: a genuinely new, independent session now exists on this
  -- table. Close every OTHER open session on this table that is fully
  -- settled; anything still outstanding is left exactly as it was.
  perform public.build20_auto_close_settled_sessions(p_table_id, v_id);

  return v_id;
exception when unique_violation then
  select ts.id into v_id
  from public.table_sessions ts
  where ts.session_token_hash = p_visit_hash
    and ts.table_id = p_table_id
    and ts.status in ('ACTIVE','SETTLING')
  limit 1;
  if v_id is null then raise; end if;
  return v_id;
end;
$$;
revoke execute on function public.build19_resolve_session_by_hash(uuid, uuid, text, text, boolean) from anon, authenticated, public;

commit;

notify pgrst, 'reload schema';
