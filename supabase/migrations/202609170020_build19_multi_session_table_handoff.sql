-- TABLELY BUILD 19 — MULTI-SESSION TABLE HANDOFF / CUSTOMER CHANGEOVER
--
-- Root cause of the previous limitation
-- -------------------------------------
-- Build 17 (202609170004) created public.table_sessions with
--   create unique index table_sessions_one_active_per_table_uidx
--     on public.table_sessions(table_id) where status='ACTIVE';
-- i.e. a table could physically only ever hold ONE open session, and
-- build17_attach_order_session() attached EVERY new order on a table to
-- "the newest ACTIVE session for this table". There was also no customer
-- identity on a session at all, so a second customer scanning the same QR
-- was silently merged into the first customer's still-unsettled session
-- (their orders, totals and coupons landed on session A).
--
-- This migration is additive. It does not rewrite Build 1-18 migrations,
-- does not drop data, and keeps every existing RPC name/behaviour that is
-- not directly part of the defect.
--
-- What changes
--   1. table_sessions gains an anonymous customer identity (hashed tokens),
--      a SETTLING status, and loses the one-active-session-per-table index.
--   2. A QR scan resolves/creates a session server-side; a genuinely new
--      visitor always gets a NEW session on the SAME table, and session A is
--      never touched.
--   3. Orders/service requests/payment attempts carry their own session id.
--   4. Table occupancy is derived from ALL open (ACTIVE|SETTLING) sessions.
--   5. close_table_session() closes exactly one session.

begin;

-- ============================================================
-- 1. Session model: identity, SETTLING status, multi-session index
-- ============================================================
alter table public.table_sessions
  add column if not exists session_token_hash text,
  add column if not exists device_token_hash text,
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists origin text not null default 'STAFF',
  add column if not exists settling_at timestamptz,
  add column if not exists last_seen_at timestamptz not null default now();

alter table public.table_sessions drop constraint if exists table_sessions_origin_chk;
alter table public.table_sessions add constraint table_sessions_origin_chk
  check (origin in ('STAFF','CUSTOMER_SCAN','AUTO'));

-- Widen the status domain with the additive intermediate state. The original
-- constraint was created inline by "create table", so it carries the default
-- name table_sessions_status_check.
alter table public.table_sessions drop constraint if exists table_sessions_status_check;
alter table public.table_sessions drop constraint if exists table_sessions_status_chk;
alter table public.table_sessions add constraint table_sessions_status_chk
  check (status in ('ACTIVE','SETTLING','CLOSED'));

-- THE core fix: a table may hold more than one open session during handoff.
drop index if exists public.table_sessions_one_active_per_table_uidx;

-- One open session per anonymous visitor token, per table. This is what makes
-- concurrent/duplicate scans idempotent instead of duplicating sessions.
create unique index if not exists table_sessions_session_token_uidx
  on public.table_sessions(session_token_hash)
  where session_token_hash is not null;
create unique index if not exists table_sessions_open_device_uidx
  on public.table_sessions(table_id, device_token_hash)
  where device_token_hash is not null and status in ('ACTIVE','SETTLING');
create index if not exists table_sessions_table_open_idx
  on public.table_sessions(table_id, status, opened_at desc);

-- ============================================================
-- 2. Session ownership for service requests and payment attempts
-- ============================================================
alter table public.service_requests
  add column if not exists table_session_id uuid references public.table_sessions(id) on delete set null;
create index if not exists service_requests_session_status_idx
  on public.service_requests(table_session_id, status);

alter table public.payment_attempts
  add column if not exists table_session_id uuid references public.table_sessions(id) on delete set null;
create index if not exists payment_attempts_session_idx
  on public.payment_attempts(table_session_id);

-- Backfill: attach still-open service requests to the newest open session of
-- their own table. Historical/resolved rows are intentionally left as-is.
update public.service_requests r
set table_session_id = (
  select s.id
  from public.table_sessions s
  where s.table_id = r.table_id
    and s.status in ('ACTIVE','SETTLING')
  order by s.opened_at desc
  limit 1
)
where r.table_session_id is null
  and r.status in ('OPEN','ACKNOWLEDGED');

-- ============================================================
-- 3. Token helper (tokens are only ever stored hashed)
-- ============================================================
create or replace function public.build19_hash_token(p_token text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
  select case
    when nullif(trim(coalesce(p_token,'')),'') is null then null
    else encode(extensions.digest(trim(p_token), 'sha256'), 'hex')
  end;
$$;
revoke execute on function public.build19_hash_token(text) from anon, authenticated, public;

-- ============================================================
-- 4. Session status refresh (ACTIVE <-> SETTLING, never auto-close)
-- ============================================================
create or replace function public.build19_refresh_session_status(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.table_sessions%rowtype;
  v_total integer := 0;
  v_open integer := 0;
  v_unsettled integer := 0;
  v_next text;
begin
  if p_session_id is null then
    return;
  end if;

  select * into v_session
  from public.table_sessions
  where id = p_session_id
  for update;

  if v_session.id is null or v_session.status = 'CLOSED' then
    return;
  end if;

  select
    count(*)::int,
    count(*) filter (
      where o.status in (
        'NEW'::public.order_status,
        'ACCEPTED'::public.order_status,
        'PREPARING'::public.order_status,
        'READY'::public.order_status
      )
    )::int,
    count(*) filter (
      where o.status not in ('CANCELLED'::public.order_status,'REJECTED'::public.order_status)
        and (
          o.payment_status <> 'PAID'::public.payment_status
          or o.status = 'SERVED'::public.order_status
        )
    )::int
  into v_total, v_open, v_unsettled
  from public.orders o
  where o.table_session_id = v_session.id;

  -- SETTLING = nothing left for the kitchen/floor to do, but money or
  -- completion is still outstanding. The customer may well be at the counter.
  if v_total > 0 and v_open = 0 and v_unsettled > 0 then
    v_next := 'SETTLING';
  else
    v_next := 'ACTIVE';
  end if;

  if v_next is distinct from v_session.status then
    update public.table_sessions
    set status = v_next,
        settling_at = case when v_next = 'SETTLING' then coalesce(settling_at, now()) else null end
    where id = v_session.id;
  end if;
end;
$$;
revoke execute on function public.build19_refresh_session_status(uuid) from anon, authenticated, public;

-- ============================================================
-- 5. Table state derived from ALL open sessions of the table
-- ============================================================
create or replace function public.build17_sync_table_operational_state(p_table_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open_sessions integer := 0;
  v_state text := 'AVAILABLE';
  v_bill boolean := false;
  v_order_count integer := 0;
  v_occupied_seats integer := 0;
  v_declared integer := 0;
  v_new integer := 0;
  v_preparing integer := 0;
  v_terminal integer := 0;
  v_unpaid integer := 0;
  v_has_orders boolean := false;
  v_seat_tracking boolean := false;
begin
  if p_table_id is null then
    return;
  end if;

  select count(*)::int, coalesce(sum(ts.occupancy_count),0)::int
  into v_open_sessions, v_declared
  from public.table_sessions ts
  where ts.table_id = p_table_id
    and ts.status in ('ACTIVE','SETTLING');

  -- A table is AVAILABLE only when it has no open session at all.
  if v_open_sessions = 0 then
    update public.tables
    set operational_state = 'AVAILABLE',
        occupancy_count = 0,
        operational_updated_at = now()
    where id = p_table_id;
    return;
  end if;

  select t.seat_tracking_enabled into v_seat_tracking
  from public.tables t
  where t.id = p_table_id;

  select count(*)::int into v_occupied_seats
  from public.table_seats s
  where s.table_id = p_table_id
    and s.status = 'OCCUPIED'
    and s.session_id in (
      select ts.id from public.table_sessions ts
      where ts.table_id = p_table_id and ts.status in ('ACTIVE','SETTLING')
    );

  select exists (
    select 1
    from public.service_requests r
    where r.table_id = p_table_id
      and r.status in ('OPEN','ACKNOWLEDGED')
      and r.type = 'BILL'
  ) into v_bill;

  select
    count(*)::int,
    count(*) filter (where o.status = 'NEW'::public.order_status)::int,
    count(*) filter (where o.status in ('ACCEPTED'::public.order_status,'PREPARING'::public.order_status))::int,
    count(*) filter (where o.status in ('COMPLETED'::public.order_status,'CANCELLED'::public.order_status,'REJECTED'::public.order_status))::int,
    count(*) filter (where o.payment_status <> 'PAID'::public.payment_status and o.status = 'COMPLETED'::public.order_status)::int
  into v_order_count, v_new, v_preparing, v_terminal, v_unpaid
  from public.orders o
  where o.table_session_id in (
    select ts.id from public.table_sessions ts
    where ts.table_id = p_table_id and ts.status in ('ACTIVE','SETTLING')
  );

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
  set operational_state = v_state,
      occupancy_count = case when v_seat_tracking then greatest(0, v_occupied_seats) else greatest(0, v_declared) end,
      operational_updated_at = now()
  where id = p_table_id;
end;
$$;
revoke execute on function public.build17_sync_table_operational_state(uuid) from anon, authenticated, public;

-- ============================================================
-- 6. Order -> session attachment honours an explicitly resolved session
-- ============================================================
create or replace function public.build17_attach_order_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.table_sessions%rowtype;
  v_session_id uuid;
begin
  if not exists (
    select 1
    from public.tables t
    where t.id = new.table_id
      and t.branch_id = new.branch_id
  ) then
    raise exception 'Order table does not belong to the order branch';
  end if;

  perform 1 from public.tables t where t.id = new.table_id for update;

  if new.table_session_id is not null then
    -- The caller already resolved the customer's own session. Validate it and
    -- keep it; never silently move the order onto somebody else's session.
    select * into v_session
    from public.table_sessions ts
    where ts.id = new.table_session_id
    for update;

    if v_session.id is null then
      raise exception 'Table session not found';
    end if;
    if v_session.table_id is distinct from new.table_id
       or v_session.branch_id is distinct from new.branch_id then
      raise exception 'Table session does not belong to this table/branch';
    end if;
    if v_session.status = 'CLOSED' then
      raise exception 'Table session is already closed';
    end if;

    new.received_at := coalesce(new.received_at, now());
    return new;
  end if;

  -- Legacy/staff path with no session context: reuse the newest open session
  -- of the table, exactly as Build 17 did, otherwise open one.
  select ts.id into v_session_id
  from public.table_sessions ts
  where ts.table_id = new.table_id
    and ts.status in ('ACTIVE','SETTLING')
  order by (ts.status = 'ACTIVE') desc, ts.opened_at desc
  limit 1;

  if v_session_id is null then
    insert into public.table_sessions(branch_id, table_id, status, occupancy_count, origin)
    values (new.branch_id, new.table_id, 'ACTIVE', 0, 'AUTO')
    returning id into v_session_id;
  end if;

  new.table_session_id := v_session_id;
  new.received_at := coalesce(new.received_at, now());
  return new;
end;
$$;
revoke execute on function public.build17_attach_order_session() from anon, authenticated, public;

drop trigger if exists build17_attach_order_session on public.orders;
create trigger build17_attach_order_session
before insert on public.orders
for each row
execute function public.build17_attach_order_session();

-- Orders now refresh their OWN session's status as well as the table state.
create or replace function public.build17_orders_sync_table_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.build19_refresh_session_status(old.table_session_id);
    perform public.build17_sync_table_operational_state(old.table_id);
  else
    if tg_op = 'UPDATE' and old.table_session_id is distinct from new.table_session_id then
      perform public.build19_refresh_session_status(old.table_session_id);
    end if;
    perform public.build19_refresh_session_status(new.table_session_id);
    if tg_op = 'UPDATE' and old.table_id is distinct from new.table_id then
      perform public.build17_sync_table_operational_state(old.table_id);
    end if;
    perform public.build17_sync_table_operational_state(new.table_id);
  end if;
  return coalesce(new, old);
end;
$$;
revoke execute on function public.build17_orders_sync_table_trigger() from anon, authenticated, public;

drop trigger if exists build17_orders_sync_table on public.orders;
create trigger build17_orders_sync_table
after insert or delete or update of status, payment_status, table_session_id on public.orders
for each row
execute function public.build17_orders_sync_table_trigger();

-- ============================================================
-- 7. Server-side session resolution for a QR scan
-- ============================================================
-- Internal: resolve the session a public write belongs to. A token that does
-- not match an OPEN session of THIS table is treated as a new visit.
create or replace function public.build19_resolve_session_for_write(
  p_table_id uuid,
  p_branch_id uuid,
  p_session_token text,
  p_device_token text,
  p_create_if_missing boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_hash text := public.build19_hash_token(p_session_token);
  v_device_hash text := public.build19_hash_token(p_device_token);
  v_id uuid;
begin
  if v_session_hash is not null then
    select ts.id into v_id
    from public.table_sessions ts
    where ts.session_token_hash = v_session_hash
      and ts.table_id = p_table_id
      and ts.status in ('ACTIVE','SETTLING')
    limit 1;
    if v_id is not null then
      update public.table_sessions set last_seen_at = now() where id = v_id;
      return v_id;
    end if;
  end if;

  if v_device_hash is not null then
    select ts.id into v_id
    from public.table_sessions ts
    where ts.device_token_hash = v_device_hash
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

  insert into public.table_sessions(branch_id, table_id, status, occupancy_count, origin, session_token_hash, device_token_hash)
  values (p_branch_id, p_table_id, 'ACTIVE', 0, 'CUSTOMER_SCAN', v_session_hash, v_device_hash)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  -- Concurrent scan from the same browser/visitor: reuse whatever won.
  select ts.id into v_id
  from public.table_sessions ts
  where ts.table_id = p_table_id
    and ts.status in ('ACTIVE','SETTLING')
    and (
      (v_session_hash is not null and ts.session_token_hash = v_session_hash)
      or (v_device_hash is not null and ts.device_token_hash = v_device_hash)
    )
  order by ts.opened_at desc
  limit 1;
  return v_id;
end;
$$;
revoke execute on function public.build19_resolve_session_for_write(uuid, uuid, text, text, boolean) from anon, authenticated, public;

-- Public RPC called by the customer app right after the QR is scanned.
drop function if exists public.resolve_public_table_session(text, text, text);
create function public.resolve_public_table_session(
  p_table_code text,
  p_session_token text default null,
  p_device_token text default null
)
returns table(
  session_id uuid,
  session_token text,
  status text,
  opened_at timestamptz,
  is_new boolean,
  table_number integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_session public.table_sessions%rowtype;
  v_token text;
  v_hash text;
  v_device text := nullif(left(trim(coalesce(p_device_token,'')),128),'');
  v_device_hash text;
  v_id uuid;
begin
  if not public.allow_rate_limit('session:' || trim(coalesce(p_table_code,'')), 60, 60) then
    raise exception 'Too many requests. Please wait a moment.';
  end if;

  -- Branch is ALWAYS resolved server-side from the scanned table code.
  select t.* into v_table
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;
  if v_table.id is null then
    raise exception 'This table QR is invalid or inactive';
  end if;

  v_hash := public.build19_hash_token(p_session_token);
  v_device_hash := public.build19_hash_token(v_device);

  if v_hash is not null then
    select * into v_session
    from public.table_sessions ts
    where ts.session_token_hash = v_hash
      and ts.table_id = v_table.id
      and ts.status in ('ACTIVE','SETTLING')
    limit 1;
    if v_session.id is not null then
      update public.table_sessions
      set last_seen_at = now(),
          device_token_hash = coalesce(device_token_hash, v_device_hash)
      where id = v_session.id;
      return query select v_session.id, trim(p_session_token), v_session.status, v_session.opened_at, false, v_table.table_number;
      return;
    end if;
  end if;

  if v_device_hash is not null then
    select * into v_session
    from public.table_sessions ts
    where ts.device_token_hash = v_device_hash
      and ts.table_id = v_table.id
      and ts.status in ('ACTIVE','SETTLING')
    limit 1;
    if v_session.id is not null then
      -- Same browser, same table, session still open, but the caller lost its
      -- token: re-issue a token for the SAME session instead of forking one.
      v_token := encode(extensions.gen_random_bytes(32),'hex');
      update public.table_sessions
      set session_token_hash = public.build19_hash_token(v_token),
          last_seen_at = now()
      where id = v_session.id;
      return query select v_session.id, v_token, v_session.status, v_session.opened_at, false, v_table.table_number;
      return;
    end if;
  end if;

  -- Genuinely new visit: NEW session, SAME table. Any previously open session
  -- on this table is left completely untouched.
  v_token := encode(extensions.gen_random_bytes(32),'hex');
  begin
    insert into public.table_sessions(branch_id, table_id, status, occupancy_count, origin, session_token_hash, device_token_hash)
    values (v_table.branch_id, v_table.id, 'ACTIVE', 0, 'CUSTOMER_SCAN', public.build19_hash_token(v_token), v_device_hash)
    returning * into v_session;
  exception when unique_violation then
    select * into v_session
    from public.table_sessions ts
    where ts.table_id = v_table.id
      and ts.device_token_hash = v_device_hash
      and ts.status in ('ACTIVE','SETTLING')
    order by ts.opened_at desc
    limit 1;
    if v_session.id is null then
      raise;
    end if;
    v_token := encode(extensions.gen_random_bytes(32),'hex');
    update public.table_sessions
    set session_token_hash = public.build19_hash_token(v_token), last_seen_at = now()
    where id = v_session.id;
    return query select v_session.id, v_token, v_session.status, v_session.opened_at, false, v_table.table_number;
    return;
  end;

  v_id := v_session.id;
  perform public.build17_sync_table_operational_state(v_table.id);
  return query select v_id, v_token, v_session.status, v_session.opened_at, true, v_table.table_number;
end;
$$;
grant execute on function public.resolve_public_table_session(text, text, text) to anon, authenticated;
revoke execute on function public.resolve_public_table_session(text, text, text) from public;

-- ============================================================
-- 8. Counter order creation (Build 18 signature + session token)
-- ============================================================
drop function if exists public.create_order_for_table_v18(text,jsonb,text,text,text,text,text,text);
drop function if exists public.create_order_for_table_v18(text,jsonb,text,text,text,text,text,text,text,text);
create function public.create_order_for_table_v18(
  p_table_code text,
  p_items jsonb,
  p_payment_method text default 'PAY_AT_COUNTER',
  p_idempotency_key text default null,
  p_customer_note text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_coupon_code text default null,
  p_session_token text default null,
  p_device_token text default null
)
returns table(order_id uuid,order_number bigint,tracking_token text,subtotal numeric,tax numeric,additional_charges numeric,discount numeric,total numeric,charge_breakdown jsonb,payment_status public.payment_status,status public.order_status)
language plpgsql security definer set search_path=public
as $$
declare
  v_table public.tables%rowtype;
  v_existing public.orders%rowtype;
  v_order public.orders%rowtype;
  v_snapshot jsonb;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2):=0;
  v_tax numeric(12,2):=0;
  v_additional numeric(12,2):=0;
  v_total numeric(12,2);
  v_breakdown jsonb:='[]'::jsonb;
  v_charge record;
  v_amt numeric(12,2);
  v_user_phone text:=nullif(regexp_replace(trim(coalesce(p_customer_phone,'')),'[^0-9]','','g'),'');
  v_name text:=nullif(left(trim(coalesce(p_customer_name,'')),120),'');
  v_idem text:=nullif(trim(coalesce(p_idempotency_key,'')),'');
  v_method text:=upper(trim(coalesce(p_payment_method,'PAY_AT_COUNTER')));
  v_coupon record;
  v_session_id uuid;
begin
  if v_name is null then raise exception 'Customer name is required'; end if;
  if v_user_phone is null then raise exception 'Valid customer phone is required'; end if;
  if length(v_user_phone)=12 and left(v_user_phone,2)='91' then v_user_phone:=right(v_user_phone,10); end if;
  if length(v_user_phone)<>10 or left(v_user_phone,1) not in ('6','7','8','9') then raise exception 'Valid customer phone is required'; end if;
  if v_method<>'PAY_AT_COUNTER' then raise exception 'Build 18 counter checkout only supports PAY_AT_COUNTER'; end if;
  select t.* into v_table from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if v_idem is not null then
    select * into v_existing from public.orders where branch_id=v_table.branch_id and idempotency_key=v_idem limit 1;
    if v_existing.id is not null then return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.subtotal,v_existing.tax,v_existing.additional_charges,v_existing.discount,v_existing.total,v_existing.charge_breakdown,v_existing.payment_status,v_existing.status; return; end if;
  end if;

  -- This customer's own session (creates one for a new visitor). Session A of
  -- another customer on the same table is never reused here.
  v_session_id := public.build19_resolve_session_for_write(v_table.id, v_table.branch_id, p_session_token, p_device_token, true);

  v_snapshot:=public.build16_calculate_cart(v_table.branch_id,p_items);
  v_subtotal:=round(coalesce((select sum((x->>'line_total')::numeric) from jsonb_array_elements(v_snapshot) x),0),2);
  if v_subtotal<=0 then raise exception 'Cart is empty'; end if;

  if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
    select * into v_coupon from public.build18_validate_coupon(v_table.branch_id,v_subtotal,v_snapshot,p_coupon_code,v_user_phone,true);
    v_discount:=coalesce(v_coupon.discount_amount,0);
  end if;

  for v_charge in select c.name,c.charge_type,c.calculation_type,c.value from public.restaurant_charge_settings c where c.enabled=true and (c.branch_id=v_table.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_table.branch_id))) order by c.sort_order,c.created_at loop
    if v_charge.calculation_type='PERCENT' then v_amt:=round((v_subtotal-v_discount)*v_charge.value/100.0,2); else v_amt:=round(v_charge.value,2); end if;
    v_amt:=greatest(0,v_amt);
    if v_charge.charge_type='TAX' then v_tax:=v_tax+v_amt; else v_additional:=v_additional+v_amt; end if;
    v_breakdown:=v_breakdown||jsonb_build_object('name',v_charge.name,'charge_type',v_charge.charge_type,'calculation_type',v_charge.calculation_type,'value',v_charge.value,'amount',v_amt);
  end loop;
  v_total:=round(v_subtotal-v_discount+v_tax+v_additional,2);
  if v_total>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;

  insert into public.orders(branch_id,table_id,table_session_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,coupon_id,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot)
  values(v_table.branch_id,v_table.id,v_session_id,'NEW','PENDING','PAY_AT_COUNTER',v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,coalesce(v_idem,encode(extensions.gen_random_bytes(16),'hex')),encode(extensions.gen_random_bytes(16),'hex'),nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_user_phone,case when v_coupon.id is null then null else v_coupon.coupon_id end,case when v_coupon.id is null then null else v_coupon.coupon_code end,case when v_coupon.id is null then null else v_coupon.discount_type end,case when v_coupon.id is null then null else v_coupon.discount_value end)
  returning * into v_order;

  -- Display identity for the floor staff; never overwritten once set.
  update public.table_sessions
  set customer_name = coalesce(customer_name, v_name),
      customer_phone = coalesce(customer_phone, v_user_phone),
      last_seen_at = now()
  where id = v_order.table_session_id;

  declare v_item jsonb; begin
    for v_item in select value from jsonb_array_elements(v_snapshot) loop
      insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions,selected_options,configuration_snapshot)
      values(v_order.id,(v_item->>'menu_item_id')::uuid,v_item->>'item_name_snapshot',(v_item->>'unit_price')::numeric,(v_item->>'quantity')::integer,coalesce(v_item->'selected_addons','[]'::jsonb),nullif(v_item->>'special_instructions',''),coalesce(v_item->'selected_options','[]'::jsonb),v_item);
    end loop;
  end;

  if v_coupon.id is not null then
    insert into public.coupon_usages(coupon_id,order_id,organization_id,branch_id,table_id,table_session_id,customer_phone,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot,discount_amount)
    values(v_coupon.coupon_id,v_order.id,(select organization_id from public.branches where id=v_order.branch_id),v_order.branch_id,v_order.table_id,v_order.table_session_id,v_user_phone,v_coupon.coupon_code,v_coupon.discount_type,v_coupon.discount_value,v_coupon.discount_amount);
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
    values(v_order.id,v_order.branch_id,'COUPON_APPLIED',null,jsonb_build_object('coupon_id',v_coupon.coupon_id,'coupon_code',v_coupon.coupon_code,'discount',v_coupon.discount_amount,'source','BUILD18_COUNTER','session_id',v_order.table_session_id));
  end if;

  return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.subtotal,v_order.tax,v_order.additional_charges,v_order.discount,v_order.total,v_order.charge_breakdown,v_order.payment_status,v_order.status;
exception when unique_violation then
  if v_idem is not null then select * into v_existing from public.orders where branch_id=v_table.branch_id and idempotency_key=v_idem limit 1; if v_existing.id is not null then return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.subtotal,v_existing.tax,v_existing.additional_charges,v_existing.discount,v_existing.total,v_existing.charge_breakdown,v_existing.payment_status,v_existing.status; return; end if; end if;
  raise;
end;
$$;
grant execute on function public.create_order_for_table_v18(text,jsonb,text,text,text,text,text,text,text,text) to anon,authenticated;
revoke execute on function public.create_order_for_table_v18(text,jsonb,text,text,text,text,text,text,text,text) from public;

-- ============================================================
-- 9. PAY_NOW attempt creation carries the session (payment-first preserved)
-- ============================================================
drop function if exists public.create_payment_attempt_for_table_v18(text,jsonb,text,text,text,text,text);
drop function if exists public.create_payment_attempt_for_table_v18(text,jsonb,text,text,text,text,text,text,text);
create function public.create_payment_attempt_for_table_v18(
  p_table_code text,
  p_items jsonb,
  p_idempotency_key text,
  p_customer_note text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_coupon_code text default null,
  p_session_token text default null,
  p_device_token text default null
)
returns table(payment_attempt_id uuid,attempt_token text,total numeric,payment_started_at timestamptz,payment_expires_at timestamptz)
language plpgsql security definer set search_path=public
as $$
declare
  v_table public.tables%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_snapshot jsonb;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2):=0;
  v_tax numeric(12,2):=0;
  v_additional numeric(12,2):=0;
  v_total numeric(12,2);
  v_breakdown jsonb:='[]'::jsonb;
  v_charge record;
  v_amt numeric(12,2);
  v_name text:=nullif(left(trim(coalesce(p_customer_name,'')),120),'');
  v_phone text:=nullif(regexp_replace(trim(coalesce(p_customer_phone,'')),'[^0-9]','','g'),'');
  v_idem text:=nullif(trim(coalesce(p_idempotency_key,'')),'');
  v_coupon record;
  v_now timestamptz:=now();
  v_session_id uuid;
begin
  if v_idem is null then raise exception 'Checkout session key is required'; end if;
  if v_name is null then raise exception 'Customer name is required'; end if;
  if v_phone is null then raise exception 'Valid customer phone is required'; end if;
  if length(v_phone)=12 and left(v_phone,2)='91' then v_phone:=right(v_phone,10); end if;
  if length(v_phone)<>10 or left(v_phone,1) not in ('6','7','8','9') then raise exception 'Valid customer phone is required'; end if;
  select t.* into v_table from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  select * into v_attempt from public.payment_attempts pa where pa.branch_id=v_table.branch_id and pa.idempotency_key=v_idem and pa.status in ('PENDING','PROCESSING') order by pa.created_at desc limit 1;
  if v_attempt.id is not null then
    if v_attempt.payment_expires_at<=v_now then
      update public.payment_attempts set status='EXPIRED',updated_at=v_now,failure_reason='Payment session expired',completed_at=v_now where id=v_attempt.id;
    else
      return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at; return;
    end if;
  end if;

  v_session_id := public.build19_resolve_session_for_write(v_table.id, v_table.branch_id, p_session_token, p_device_token, true);

  v_snapshot:=public.build16_calculate_cart(v_table.branch_id,p_items);
  v_subtotal:=round(coalesce((select sum((x->>'line_total')::numeric) from jsonb_array_elements(v_snapshot) x),0),2);
  if v_subtotal<=0 then raise exception 'Cart is empty'; end if;

  if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
    select * into v_coupon from public.build18_validate_coupon(v_table.branch_id,v_subtotal,v_snapshot,p_coupon_code,v_phone,true);
    v_discount:=coalesce(v_coupon.discount_amount,0);
  end if;

  for v_charge in select c.name,c.charge_type,c.calculation_type,c.value from public.restaurant_charge_settings c where c.enabled=true and (c.branch_id=v_table.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_table.branch_id))) order by c.sort_order,c.created_at loop
    if v_charge.calculation_type='PERCENT' then v_amt:=round((v_subtotal-v_discount)*v_charge.value/100.0,2); else v_amt:=round(v_charge.value,2); end if;
    v_amt:=greatest(0,v_amt);
    if v_charge.charge_type='TAX' then v_tax:=v_tax+v_amt; else v_additional:=v_additional+v_amt; end if;
    v_breakdown:=v_breakdown||jsonb_build_object('name',v_charge.name,'charge_type',v_charge.charge_type,'calculation_type',v_charge.calculation_type,'value',v_charge.value,'amount',v_amt);
  end loop;
  v_total:=round(v_subtotal-v_discount+v_tax+v_additional,2);
  if v_total>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;

  insert into public.payment_attempts(attempt_token,branch_id,table_id,table_session_id,idempotency_key,items_snapshot,subtotal,tax,discount,additional_charges,total,charge_breakdown,customer_note,customer_name,customer_phone,payment_started_at,payment_expires_at,coupon_id,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot)
  values(encode(extensions.gen_random_bytes(32),'hex'),v_table.branch_id,v_table.id,v_session_id,v_idem,v_snapshot,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_phone,v_now,v_now+interval '1 hour',case when v_coupon.id is null then null else v_coupon.coupon_id end,case when v_coupon.id is null then null else v_coupon.coupon_code end,case when v_coupon.id is null then null else v_coupon.discount_type end,case when v_coupon.id is null then null else v_coupon.discount_value end)
  returning * into v_attempt;
  return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at;
exception when unique_violation then
  select * into v_attempt from public.payment_attempts where branch_id=v_table.branch_id and idempotency_key=v_idem and status in ('PENDING','PROCESSING') order by created_at desc limit 1;
  if v_attempt.id is not null then return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at; return; end if;
  raise;
end;
$$;
grant execute on function public.create_payment_attempt_for_table_v18(text,jsonb,text,text,text,text,text,text,text) to anon,authenticated;
revoke execute on function public.create_payment_attempt_for_table_v18(text,jsonb,text,text,text,text,text,text,text) from public;

-- ============================================================
-- 10. PAY_NOW finalization attaches the order to the attempt's own session
-- ============================================================
create or replace function public.finalize_payment_attempt_v18(p_payment_attempt_id uuid,p_attempt_token text,p_razorpay_payment_id text,p_payment_method text)
returns table(order_id uuid,order_number bigint,tracking_token text,total numeric,payment_status public.payment_status,status public.order_status)
language plpgsql security definer set search_path=public
as $$
declare
  v_attempt public.payment_attempts%rowtype;
  v_order public.orders%rowtype;
  v_existing public.orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_now timestamptz:=now();
  v_item jsonb;
  v_method text:=upper(trim(coalesce(p_payment_method,'ONLINE')));
  v_token text:=nullif(trim(p_attempt_token),'');
  v_used_total bigint:=0;
  v_active_other bigint:=0;
  v_used_customer bigint:=0;
  v_active_other_customer bigint:=0;
  v_session_id uuid;
begin
  if p_payment_attempt_id is null or v_token is null then raise exception 'Invalid payment attempt'; end if;
  select * into v_attempt from public.payment_attempts where id=p_payment_attempt_id and attempt_token=v_token for update;
  if v_attempt.id is null then raise exception 'Payment attempt not found'; end if;
  if v_attempt.status='SUCCESS' and v_attempt.order_id is not null then
    select * into v_order from public.orders where id=v_attempt.order_id;
    if v_order.id is null then raise exception 'Payment attempt is finalized but its order is missing'; end if;
    return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.total,v_order.payment_status,v_order.status; return;
  end if;
  if v_attempt.status in ('FAILED','EXPIRED') then raise exception 'Payment attempt is no longer valid'; end if;
  if v_attempt.status not in ('PENDING','PROCESSING') then raise exception 'Payment attempt is not finalizable'; end if;
  if v_attempt.payment_expires_at<=v_now then
    update public.payment_attempts set status='EXPIRED',failure_reason='Payment session expired',updated_at=v_now,completed_at=v_now where id=v_attempt.id;
    raise exception 'Payment session expired. Please place a new order.';
  end if;
  if nullif(trim(coalesce(p_razorpay_payment_id,'')),'') is null then raise exception 'Razorpay payment ID is required'; end if;
  if nullif(trim(coalesce(v_attempt.razorpay_order_id,'')),'') is null then raise exception 'Razorpay order ID is missing'; end if;

  if v_attempt.coupon_id is not null then
    select c.* into v_coupon from public.coupons c where c.id=v_attempt.coupon_id for update;
    if v_coupon.id is null then raise exception 'Coupon snapshot is no longer available'; end if;
    if v_coupon.usage_limit_total is not null then
      select count(*) into v_used_total from public.coupon_usages u where u.coupon_id=v_coupon.id;
      select count(*) into v_active_other from public.payment_attempts pa where pa.coupon_id=v_coupon.id and pa.status in ('PENDING','PROCESSING') and pa.payment_expires_at>v_now and pa.id<>v_attempt.id;
      if v_used_total+v_active_other>=v_coupon.usage_limit_total then raise exception 'Coupon usage limit reached'; end if;
    end if;
    if v_coupon.usage_limit_per_customer is not null then
      select count(*) into v_used_customer from public.coupon_usages u where u.coupon_id=v_coupon.id and u.customer_phone=v_attempt.customer_phone;
      select count(*) into v_active_other_customer from public.payment_attempts pa where pa.coupon_id=v_coupon.id and pa.customer_phone=v_attempt.customer_phone and pa.status in ('PENDING','PROCESSING') and pa.payment_expires_at>v_now and pa.id<>v_attempt.id;
      if v_used_customer+v_active_other_customer>=v_coupon.usage_limit_per_customer then raise exception 'Customer usage limit reached'; end if;
    end if;
  end if;

  select * into v_existing from public.orders where branch_id=v_attempt.branch_id and idempotency_key=concat('payment-attempt:',v_attempt.id::text) limit 1 for update;
  if v_existing.id is not null then
    if v_existing.payment_status<>'PAID' then
      update public.orders set payment_status='PAID',payment_method=concat('PAY_NOW:',case when v_method='' then 'ONLINE' else v_method end),razorpay_payment_id=p_razorpay_payment_id,paid_at=coalesce(paid_at,v_now),updated_at=v_now where id=v_existing.id;
    end if;
    update public.payment_attempts set status='SUCCESS',razorpay_payment_id=p_razorpay_payment_id,order_id=v_existing.id,completed_at=v_now,updated_at=v_now where id=v_attempt.id;
    return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.total,'PAID'::public.payment_status,v_existing.status; return;
  end if;

  -- Use the session the attempt was started in, provided it is still open and
  -- still belongs to this table. Otherwise fall back to the Build 17 trigger.
  select ts.id into v_session_id
  from public.table_sessions ts
  where ts.id = v_attempt.table_session_id
    and ts.table_id = v_attempt.table_id
    and ts.status in ('ACTIVE','SETTLING')
  limit 1;

  insert into public.orders(branch_id,table_id,table_session_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,paid_at,razorpay_payment_id,coupon_id,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot)
  values(v_attempt.branch_id,v_attempt.table_id,v_session_id,'NEW','PAID',concat('PAY_NOW:',case when v_method='' then 'ONLINE' else v_method end),v_attempt.subtotal,v_attempt.tax,v_attempt.discount,v_attempt.additional_charges,v_attempt.total,v_attempt.charge_breakdown,concat('payment-attempt:',v_attempt.id::text),encode(extensions.gen_random_bytes(16),'hex'),v_attempt.customer_note,v_attempt.customer_name,v_attempt.customer_phone,v_now,p_razorpay_payment_id,v_attempt.coupon_id,v_attempt.coupon_code_snapshot,v_attempt.discount_type_snapshot,v_attempt.discount_value_snapshot)
  returning * into v_order;

  update public.table_sessions
  set customer_name = coalesce(customer_name, v_attempt.customer_name),
      customer_phone = coalesce(customer_phone, v_attempt.customer_phone),
      last_seen_at = now()
  where id = v_order.table_session_id;

  for v_item in select value from jsonb_array_elements(v_attempt.items_snapshot) loop
    insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions,selected_options,configuration_snapshot)
    values(v_order.id,(v_item->>'menu_item_id')::uuid,v_item->>'item_name_snapshot',(v_item->>'unit_price')::numeric,(v_item->>'quantity')::integer,coalesce(v_item->'selected_addons','[]'::jsonb),nullif(v_item->>'special_instructions',''),coalesce(v_item->'selected_options','[]'::jsonb),v_item);
  end loop;

  if v_attempt.coupon_id is not null then
    insert into public.coupon_usages(coupon_id,order_id,organization_id,branch_id,table_id,table_session_id,customer_phone,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot,discount_amount)
    values(v_attempt.coupon_id,v_order.id,(select organization_id from public.branches where id=v_order.branch_id),v_order.branch_id,v_order.table_id,v_order.table_session_id,v_attempt.customer_phone,v_attempt.coupon_code_snapshot,v_attempt.discount_type_snapshot,v_attempt.discount_value_snapshot,v_attempt.discount);
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
    values(v_order.id,v_order.branch_id,'COUPON_APPLIED',null,jsonb_build_object('coupon_id',v_attempt.coupon_id,'coupon_code',v_attempt.coupon_code_snapshot,'discount',v_attempt.discount,'source','BUILD18_PAYMENT_FIRST','session_id',v_order.table_session_id));
  end if;

  insert into public.payment_transactions(order_id,branch_id,provider,provider_order_id,provider_payment_id,amount,status,method,raw_metadata)
  values(v_order.id,v_order.branch_id,'RAZORPAY',v_attempt.razorpay_order_id,p_razorpay_payment_id,v_order.total,'CAPTURED',v_method,jsonb_build_object('payment_attempt_id',v_attempt.id,'source','build18-payment-first-finalize'))
  on conflict (provider_order_id) where provider_order_id is not null do update set order_id=excluded.order_id,provider_payment_id=excluded.provider_payment_id,amount=excluded.amount,status=excluded.status,method=excluded.method,raw_metadata=excluded.raw_metadata,updated_at=now();

  update public.payment_attempts set status='SUCCESS',razorpay_payment_id=p_razorpay_payment_id,order_id=v_order.id,completed_at=v_now,updated_at=v_now where id=v_attempt.id;
  return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.total,v_order.payment_status,v_order.status;
end;
$$;
revoke execute on function public.finalize_payment_attempt_v18(uuid,text,text,text) from anon,authenticated,public;
grant execute on function public.finalize_payment_attempt_v18(uuid,text,text,text) to service_role;

-- ============================================================
-- 11. Service requests belong to the requesting session
-- ============================================================
drop function if exists public.create_service_request_for_table(text, text, text);
drop function if exists public.create_service_request_for_table(text, text, text, text, text);
create function public.create_service_request_for_table(
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
begin
  if not public.allow_rate_limit('service:' || trim(coalesce(p_table_code, '')), 60, 10) then raise exception 'Too many service requests. Please wait a moment.'; end if;
  select t.* into v_table
  from public.tables t join public.branches b on b.id = t.branch_id join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code) and t.active and o.status = 'ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  select b.organization_id into v_org from public.branches b where b.id = v_table.branch_id;
  if not public.organization_has_feature(v_org, 'SERVICE_REQUESTS') then raise exception 'Service requests are not available on the current Tablely plan'; end if;
  if v_type not in ('WAITER', 'WATER', 'BILL', 'ASSISTANCE') then raise exception 'Unsupported service request'; end if;

  -- Resolve the caller's own session. A request is never created just because
  -- of a service call, so a scan-less caller simply gets the newest open one.
  v_session_id := public.build19_resolve_session_for_write(v_table.id, v_table.branch_id, p_session_token, p_device_token, false);
  if v_session_id is null then
    select ts.id into v_session_id
    from public.table_sessions ts
    where ts.table_id = v_table.id and ts.status in ('ACTIVE','SETTLING')
    order by (ts.status = 'ACTIVE') desc, ts.opened_at desc
    limit 1;
  end if;

  -- Duplicate guard is per session when we know it, per table otherwise, so
  -- two different customers on the same table can each call a waiter.
  if exists (
    select 1 from public.service_requests r
    where r.type = v_type
      and r.status in ('OPEN', 'ACKNOWLEDGED')
      and (
        (v_session_id is not null and r.table_session_id = v_session_id)
        or (v_session_id is null and r.table_id = v_table.id and r.table_session_id is null)
      )
  ) then raise exception 'This request is already open'; end if;

  return query insert into public.service_requests(branch_id, table_id, table_session_id, type, status, note)
  values(v_table.branch_id, v_table.id, v_session_id, v_type, 'OPEN', nullif(left(trim(coalesce(p_note, '')), 300), ''))
  returning service_requests.id, service_requests.branch_id, service_requests.table_id, service_requests.type, service_requests.status, service_requests.note, service_requests.created_at;
end;
$$;
grant execute on function public.create_service_request_for_table(text, text, text, text, text) to anon, authenticated;
revoke execute on function public.create_service_request_for_table(text, text, text, text, text) from public;

-- ============================================================
-- 12. Staff session RPCs: open / occupancy / close, per session
-- ============================================================
create or replace function public.open_table_session(p_table_id uuid,p_occupancy_count integer default 1)
returns public.table_sessions
language plpgsql security definer set search_path=public
as $$
declare
  v_table public.tables%rowtype;
  v_session public.table_sessions%rowtype;
  v_count integer := greatest(0,coalesce(p_occupancy_count,1));
  v_user uuid := auth.uid();
  v_free integer := 0;
begin
  select * into v_table from public.tables where id=p_table_id for update;
  if v_table.id is null then raise exception 'Table not found'; end if;
  if not v_table.active then raise exception 'Table is inactive'; end if;
  if not public.current_user_has_permission_for_branch(v_table.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to seat this table' using errcode='42501'; end if;
  if v_count > v_table.seats then raise exception 'Occupancy exceeds table capacity'; end if;

  -- Only a staff-opened session blocks another staff-opened session. Customer
  -- sessions that are still settling must never block seating new guests.
  if exists (
    select 1 from public.table_sessions ts
    where ts.table_id = p_table_id and ts.status = 'ACTIVE' and ts.origin = 'STAFF'
  ) then
    raise exception 'Table already has an active session';
  end if;

  insert into public.table_sessions(branch_id,table_id,occupancy_count,origin)
  values(v_table.branch_id,p_table_id,v_count,'STAFF')
  returning * into v_session;

  if v_table.seat_tracking_enabled then
    insert into public.table_seats(table_id,seat_number,status)
    select p_table_id,g,'FREE' from generate_series(1,greatest(v_table.seats,v_count)) g
    on conflict (table_id,seat_number) do nothing;
    select count(*)::int into v_free
    from public.table_seats s
    where s.table_id=p_table_id and (s.status='FREE' or s.session_id is null);
    if v_free < v_count then raise exception 'Not enough free seats on this table for a new session'; end if;
    update public.table_seats s
    set status='OCCUPIED',session_id=v_session.id,occupied_at=now(),released_at=null
    where s.id in (
      select s2.id from public.table_seats s2
      where s2.table_id=p_table_id and (s2.status='FREE' or s2.session_id is null)
      order by s2.seat_number
      limit v_count
    );
  end if;

  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  select o.id,o.branch_id,'TABLE_SESSION_OPENED',v_user,jsonb_build_object('session_id',v_session.id,'table_id',p_table_id,'occupancy_count',v_count)
  from public.orders o where o.table_session_id=v_session.id limit 1;
  perform public.build17_sync_table_operational_state(p_table_id);
  return v_session;
end;
$$;
grant execute on function public.open_table_session(uuid,integer) to authenticated;

create or replace function public.update_table_session_occupancy(p_session_id uuid,p_occupancy_count integer)
returns public.table_sessions
language plpgsql security definer set search_path=public
as $$
declare
  v_session public.table_sessions%rowtype;
  v_table public.tables%rowtype;
  v_user uuid := auth.uid();
  v_count integer := greatest(0,coalesce(p_occupancy_count,0));
  v_current integer := 0;
  v_free integer := 0;
begin
  select * into v_session from public.table_sessions where id=p_session_id for update;
  if v_session.id is null or v_session.status='CLOSED' then raise exception 'Session is not open'; end if;
  select * into v_table from public.tables where id=v_session.table_id for update;
  if not public.current_user_has_permission_for_branch(v_session.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to change occupancy' using errcode='42501'; end if;
  if v_count>v_table.seats then raise exception 'Occupancy exceeds table capacity'; end if;
  update public.table_sessions set occupancy_count=v_count where id=v_session.id returning * into v_session;

  if v_table.seat_tracking_enabled then
    select count(*)::int into v_current from public.table_seats s where s.table_id=v_table.id and s.session_id=v_session.id and s.status='OCCUPIED';
    if v_count > v_current then
      insert into public.table_seats(table_id,seat_number,status)
      select v_table.id,g,'FREE' from generate_series(1,v_table.seats) g
      on conflict (table_id,seat_number) do nothing;
      select count(*)::int into v_free from public.table_seats s where s.table_id=v_table.id and (s.status='FREE' or s.session_id is null);
      if v_free < (v_count - v_current) then raise exception 'Not enough free seats on this table'; end if;
      update public.table_seats s
      set status='OCCUPIED',session_id=v_session.id,occupied_at=coalesce(s.occupied_at,now()),released_at=null
      where s.id in (
        select s2.id from public.table_seats s2
        where s2.table_id=v_table.id and (s2.status='FREE' or s2.session_id is null)
        order by s2.seat_number limit (v_count - v_current)
      );
    elsif v_count < v_current then
      update public.table_seats s
      set status='FREE',session_id=null,released_at=now()
      where s.id in (
        select s2.id from public.table_seats s2
        where s2.table_id=v_table.id and s2.session_id=v_session.id and s2.status='OCCUPIED'
        order by s2.seat_number desc limit (v_current - v_count)
      );
    end if;
  end if;

  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  select o.id,o.branch_id,'TABLE_OCCUPANCY_CHANGED',v_user,jsonb_build_object('session_id',v_session.id,'occupancy_count',v_count)
  from public.orders o where o.table_session_id=v_session.id order by o.created_at desc limit 1;
  perform public.build17_sync_table_operational_state(v_session.table_id);
  return v_session;
end;
$$;
grant execute on function public.update_table_session_occupancy(uuid,integer) to authenticated;

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
  v_open_sessions integer;
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

  select count(*)::int into v_open_sessions
  from public.table_sessions ts
  where ts.table_id=v_session.table_id and ts.status in ('ACTIVE','SETTLING');

  -- Only this session's own service requests block it. Legacy rows with no
  -- session still block, but only while this is the table's last open session.
  select count(*)::int into v_requests
  from public.service_requests r
  where r.status in ('OPEN','ACKNOWLEDGED')
    and (
      r.table_session_id = v_session.id
      or (r.table_session_id is null and r.table_id = v_session.table_id and v_open_sessions <= 1)
    );
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

-- ============================================================
-- 13. Staff read model for multi-session tables
-- ============================================================
drop function if exists public.list_open_table_sessions_v19(uuid);
create function public.list_open_table_sessions_v19(p_branch_id uuid)
returns table(
  session_id uuid,
  table_id uuid,
  branch_id uuid,
  status text,
  origin text,
  occupancy_count integer,
  customer_name text,
  customer_phone text,
  opened_at timestamptz,
  settling_at timestamptz,
  order_count integer,
  unpaid_count integer,
  session_total numeric
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_branch_member(p_branch_id) then
    raise exception 'You are not authorized to view this branch' using errcode='42501';
  end if;
  return query
  select ts.id, ts.table_id, ts.branch_id, ts.status, ts.origin, ts.occupancy_count,
         ts.customer_name, ts.customer_phone, ts.opened_at, ts.settling_at,
         coalesce(o.order_count,0)::int,
         coalesce(o.unpaid_count,0)::int,
         coalesce(o.session_total,0)::numeric
  from public.table_sessions ts
  left join lateral (
    select count(*)::int as order_count,
           count(*) filter (
             where x.payment_status <> 'PAID'::public.payment_status
               and x.status not in ('CANCELLED'::public.order_status,'REJECTED'::public.order_status)
           )::int as unpaid_count,
           sum(x.total) filter (
             where x.status not in ('CANCELLED'::public.order_status,'REJECTED'::public.order_status)
           ) as session_total
    from public.orders x
    where x.table_session_id = ts.id
  ) o on true
  where ts.branch_id = p_branch_id
    and ts.status in ('ACTIVE','SETTLING')
  order by ts.table_id, ts.opened_at;
end;
$$;
grant execute on function public.list_open_table_sessions_v19(uuid) to authenticated;
revoke execute on function public.list_open_table_sessions_v19(uuid) from anon, public;

-- Staff may read sessions of their own branch, but never the bearer tokens.
revoke select on public.table_sessions from authenticated;
grant select (
  id, branch_id, table_id, status, occupancy_count, opened_at, closed_at,
  created_at, updated_at, customer_name, customer_phone, origin, settling_at,
  last_seen_at
) on public.table_sessions to authenticated;

-- ============================================================
-- 14. Re-derive existing data with the new rules
-- ============================================================
do $$
declare r record;
begin
  for r in select id from public.table_sessions where status in ('ACTIVE','SETTLING') loop
    perform public.build19_refresh_session_status(r.id);
  end loop;
  for r in select id from public.tables loop
    perform public.build17_sync_table_operational_state(r.id);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
