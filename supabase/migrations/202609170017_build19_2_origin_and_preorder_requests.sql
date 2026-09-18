-- TABLELY BUILD 19.2 — ORIGIN SEMANTICS + PRE-ORDER SERVICE REQUEST CONTEXT
--
-- Small corrections on top of Build 19.1 (202609170016). Additive only.
-- Builds 1-18 untouched, one session system, no destructive change, and the
-- Build 19.1 lifecycle is preserved verbatim:
--
--   QR scan            -> temporary local visit context only, NO database write
--   no order           -> NO persistent session
--   first actual order -> create/resolve the persistent session
--   PAY_NOW            -> session + order only after verified payment
--
-- 1. A session created because the customer actually ORDERED is now labelled
--    origin = 'CUSTOMER_ORDER'. 'CUSTOMER_SCAN' stays a legal value so the rows
--    Build 19 wrote keep validating; no historical row is rewritten.
-- 2. A service request placed before the first order keeps its own anonymous
--    visit context (hashed) instead of only table_id, so a second request from
--    the same guest is recognised while two different guests at one table are
--    not conflated. It still creates NO session and never fakes one.

begin;

-- ============================================================
-- 1. origin: add CUSTOMER_ORDER, keep every existing value legal
-- ============================================================
alter table public.table_sessions drop constraint if exists table_sessions_origin_chk;
alter table public.table_sessions add constraint table_sessions_origin_chk
  check (origin in ('STAFF','CUSTOMER_ORDER','CUSTOMER_SCAN','AUTO'));

comment on column public.table_sessions.origin is
  'How this session came into existence. CUSTOMER_ORDER: the customer placed their first order (Build 19.2+). CUSTOMER_SCAN: legacy Build 19 sessions created on QR scan, kept for historical accuracy. STAFF: opened from the Tables page. AUTO: Build 17 fallback for a staff/legacy order that arrived without a session.';

-- ============================================================
-- 2. Service requests keep an anonymous pre-order visit context
-- ============================================================
alter table public.service_requests
  add column if not exists visit_token_hash text;
create index if not exists service_requests_visit_open_idx
  on public.service_requests(table_id, visit_token_hash)
  where table_session_id is null and status in ('OPEN','ACKNOWLEDGED');

comment on column public.service_requests.visit_token_hash is
  'SHA-256 of the anonymous visit token that raised this request. Only meaningful before the visit has a persistent session; never an identity or an account.';

-- ============================================================
-- 3. New customer sessions are labelled CUSTOMER_ORDER
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

-- ============================================================
-- 4. Service request: no session before the first order, but no lost context
-- ============================================================
create or replace function public.create_service_request_for_table(
  p_table_code text,
  p_type text,
  p_note text default null,
  p_session_token text default null,
  p_device_token text default null
)
returns table(id uuid, branch_id uuid, table_id uuid, type text, status text, note text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_type text := upper(trim(coalesce(p_type, '')));
  v_org uuid;
  v_session_id uuid;
  v_visit_hash text := public.build19_hash_token(p_session_token);
begin
  if not public.allow_rate_limit('service:' || trim(coalesce(p_table_code, '')), 60, 10) then raise exception 'Too many service requests. Please wait a moment.'; end if;
  select t.* into v_table
  from public.tables t join public.branches b on b.id = t.branch_id join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code) and t.active and o.status = 'ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  select b.organization_id into v_org from public.branches b where b.id = v_table.branch_id;
  if not public.organization_has_feature(v_org, 'SERVICE_REQUESTS') then raise exception 'Service requests are not available on the current Tablely plan'; end if;
  if v_type not in ('WAITER', 'WATER', 'BILL', 'ASSISTANCE') then raise exception 'Unsupported service request'; end if;

  -- Adopt ONLY this visit's own session, and only if one already exists. A
  -- service request must never create a persistent session, never invent a fake
  -- session id, and never borrow another customer's session.
  v_session_id := public.build19_resolve_session_by_hash(v_table.id, v_table.branch_id, v_visit_hash, null, false);

  -- Duplicate guard: per session once there is one, otherwise per anonymous
  -- visit, otherwise per table. Two different guests at one table can each call
  -- a waiter before they have ordered.
  if exists (
    select 1 from public.service_requests r
    where r.type = v_type
      and r.status in ('OPEN', 'ACKNOWLEDGED')
      and (
        case
          when v_session_id is not null then r.table_session_id = v_session_id
          when v_visit_hash is not null then r.table_id = v_table.id and r.table_session_id is null and r.visit_token_hash = v_visit_hash
          else r.table_id = v_table.id and r.table_session_id is null and r.visit_token_hash is null
        end
      )
  ) then raise exception 'This request is already open'; end if;

  -- table_id and branch_id are always present, table_session_id stays NULL
  -- until (and unless) this visit places an order. Nothing about the request is
  -- lost, and the table's state is unaffected by it.
  return query insert into public.service_requests(branch_id, table_id, table_session_id, visit_token_hash, type, status, note)
  values(v_table.branch_id, v_table.id, v_session_id, v_visit_hash, v_type, 'OPEN', nullif(left(trim(coalesce(p_note, '')), 300), ''))
  returning service_requests.id, service_requests.branch_id, service_requests.table_id, service_requests.type, service_requests.status, service_requests.note, service_requests.created_at;
end;
$$;
grant execute on function public.create_service_request_for_table(text, text, text, text, text) to anon, authenticated;
revoke execute on function public.create_service_request_for_table(text, text, text, text, text) from public;

-- ============================================================
-- 5. Session closure blocks only on its OWN service requests
-- ============================================================
-- Closes EXACTLY the requested session. Other sessions on the same table are
-- untouched, and the table stays OCCUPIED while any of them is still open.
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
  select * into v_session from public.table_sessions where id=p_session_id for update;
  if v_session.id is null then raise exception 'Session not found' using errcode='P0002'; end if;
  if v_session.status='CLOSED' then return v_session; end if;

  select * into v_table from public.tables where id=v_session.table_id for update;

  if not public.current_user_has_permission_for_branch(v_session.branch_id,'EDIT_ORDERS') then
    raise exception 'You are not authorized to close this session' using errcode='42501';
  end if;

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
    and o.status not in ('COMPLETED'::public.order_status,'CANCELLED'::public.order_status,'REJECTED'::public.order_status,'SERVED'::public.order_status);
  if v_bad>0 then
    raise exception 'All orders must be completed, served, cancelled, or rejected before closing the session' using errcode='P0001';
  end if;

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
  select f.id,f.branch_id,'ORDER_COMPLETED',v_user,
         jsonb_build_object('source','BUILD17_SESSION_CLOSE','session_id',v_session.id,'reason','SERVED_ORDER_FINALIZED_ON_SESSION_CLOSE')
  from finalized f;

  -- Build 19.2: ONLY this session's own service requests block it. A request
  -- that belongs to no session (raised by a guest who browsed but never
  -- ordered) is somebody else's business and must not trap this session; it
  -- stays open and visible on the service requests page until staff resolve it.
  select count(*)::int into v_requests
  from public.service_requests r
  where r.status in ('OPEN','ACKNOWLEDGED')
    and r.table_session_id = v_session.id;
  if v_requests>0 then
    raise exception 'Outstanding service requests must be resolved before closing the session' using errcode='P0001';
  end if;

  select count(*)::int into v_bad
  from public.orders o
  where o.table_session_id=v_session.id
    and o.status not in ('COMPLETED'::public.order_status,'CANCELLED'::public.order_status,'REJECTED'::public.order_status);
  if v_bad>0 then
    raise exception 'Session still has active orders and cannot be closed' using errcode='P0001';
  end if;

  update public.table_sessions
  set status='CLOSED', closed_at=now(), updated_at=now()
  where id=v_session.id
  returning * into v_session;

  if v_table.seat_tracking_enabled then
    update public.table_seats
    set status='FREE', session_id=null, released_at=now()
    where table_id=v_table.id and session_id=v_session.id;
  end if;

  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  select o.id,o.branch_id,'TABLE_SESSION_CLOSED',v_user,jsonb_build_object('session_id',v_session.id,'table_id',v_table.id)
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

commit;

notify pgrst, 'reload schema';
