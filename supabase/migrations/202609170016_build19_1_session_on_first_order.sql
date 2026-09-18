-- TABLELY BUILD 19.1 — SESSION IS CREATED BY THE FIRST REAL ORDER, NOT BY A SCAN
--
-- Correction pass on Build 19 (202609170015). Additive only: no Build 1-18
-- migration is rewritten, nothing is deleted, and there is still exactly one
-- session system (public.table_sessions).
--
-- What was wrong in Build 19
-- -------------------------
-- resolve_public_table_session() inserted a persistent row into
-- public.table_sessions the moment the customer app opened, so a QR scan alone
-- made the table OCCUPIED and left stray empty sessions behind. Session reuse
-- also keyed on device_token_hash, which merges two different customers who
-- happen to share a phone/browser into one session.
--
-- New rule
-- --------
--   QR scan  -> restaurant/branch/table context + a purely client-side visit
--               token. NO database write of any kind.
--   1st order-> the server resolves the visit token to an open session on this
--               table, or creates the persistent session, then attaches the
--               order (and the customer name/phone) to it.
--   PAY_NOW  -> the payment attempt stores only the visit token hash; the
--               session and the order are created by finalize, i.e. after
--               Razorpay verification, preserving payment-first.

begin;

-- ============================================================
-- 1. Indexes: stop device-token session merging, allow token reuse
--    once the previous session of that visit is closed
-- ============================================================
-- A device/browser is NOT an identity. Two customers may share one phone.
drop index if exists public.table_sessions_open_device_uidx;

-- The visit token identifies one visit. It may only ever own one OPEN session;
-- once that session closes, the same browser starting a new visit is free to
-- create a new session.
drop index if exists public.table_sessions_session_token_uidx;
create unique index if not exists table_sessions_open_visit_token_uidx
  on public.table_sessions(session_token_hash)
  where session_token_hash is not null and status in ('ACTIVE','SETTLING');

comment on column public.table_sessions.session_token_hash is
  'SHA-256 of the anonymous client visit token that created this session. Never a customer account.';
comment on column public.table_sessions.device_token_hash is
  'SHA-256 of the browser device token, informational only. Build 19.1: never used to reuse or merge sessions.';

-- ============================================================
-- 2. Payment attempts carry the visit token, not a session
-- ============================================================
alter table public.payment_attempts
  add column if not exists visit_token_hash text,
  add column if not exists device_token_hash text;

-- ============================================================
-- 3. A QR scan performs no database write at all
-- ============================================================
drop function if exists public.resolve_public_table_session(text, text, text);

-- ============================================================
-- 4. Session resolution (by hash, no device-token reuse)
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
  -- Only the visit token can adopt an existing session, and only an OPEN one
  -- on THIS table. A device token never adopts a session: the same browser in
  -- the hands of a different customer must not inherit the previous visit.
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

  insert into public.table_sessions(branch_id, table_id, status, occupancy_count, origin, session_token_hash, device_token_hash)
  values (p_branch_id, p_table_id, 'ACTIVE', 0, 'CUSTOMER_SCAN', p_visit_hash, p_device_hash)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  -- Two writes of the same visit raced each other: adopt the winner.
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

-- Same signature as Build 19 so create_order_for_table_v18 keeps working
-- unchanged; the body now delegates and no longer reuses by device token.
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
begin
  return public.build19_resolve_session_by_hash(
    p_table_id,
    p_branch_id,
    public.build19_hash_token(p_session_token),
    public.build19_hash_token(p_device_token),
    p_create_if_missing
  );
end;
$$;
revoke execute on function public.build19_resolve_session_for_write(uuid, uuid, text, text, boolean) from anon, authenticated, public;

-- ============================================================
-- 5. Service requests never invent or borrow a session
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
begin
  if not public.allow_rate_limit('service:' || trim(coalesce(p_table_code, '')), 60, 10) then raise exception 'Too many service requests. Please wait a moment.'; end if;
  select t.* into v_table
  from public.tables t join public.branches b on b.id = t.branch_id join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code) and t.active and o.status = 'ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  select b.organization_id into v_org from public.branches b where b.id = v_table.branch_id;
  if not public.organization_has_feature(v_org, 'SERVICE_REQUESTS') then raise exception 'Service requests are not available on the current Tablely plan'; end if;
  if v_type not in ('WAITER', 'WATER', 'BILL', 'ASSISTANCE') then raise exception 'Unsupported service request'; end if;

  -- Attach ONLY to this visit's own session. Before the first order there is no
  -- persistent session yet, and a service request must never create one nor
  -- borrow another customer's session.
  v_session_id := public.build19_resolve_session_for_write(v_table.id, v_table.branch_id, p_session_token, p_device_token, false);

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
-- 6. PAY_NOW attempt: remember the visit, create NO session
-- ============================================================
create or replace function public.create_payment_attempt_for_table_v18(
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
  v_visit_hash text:=public.build19_hash_token(p_session_token);
  v_device_hash text:=public.build19_hash_token(p_device_token);
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

  -- Build 19.1: no table_session_id here. An abandoned or failed PAY_NOW must
  -- leave no restaurant-visible order and no persistent session behind.
  insert into public.payment_attempts(attempt_token,branch_id,table_id,visit_token_hash,device_token_hash,idempotency_key,items_snapshot,subtotal,tax,discount,additional_charges,total,charge_breakdown,customer_note,customer_name,customer_phone,payment_started_at,payment_expires_at,coupon_id,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot)
  values(encode(extensions.gen_random_bytes(32),'hex'),v_table.branch_id,v_table.id,v_visit_hash,v_device_hash,v_idem,v_snapshot,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_phone,v_now,v_now+interval '1 hour',case when v_coupon.id is null then null else v_coupon.coupon_id end,case when v_coupon.id is null then null else v_coupon.coupon_code end,case when v_coupon.id is null then null else v_coupon.discount_type end,case when v_coupon.id is null then null else v_coupon.discount_value end)
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
-- 7. PAY_NOW finalize: verification first, THEN session + order
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

  -- Payment is verified at this point: NOW the persistent session is created or
  -- adopted, from the visit token the checkout was started with. A legacy
  -- Build 19 attempt that still carries table_session_id is honoured if that
  -- session is open and still belongs to this table.
  if v_attempt.table_session_id is not null then
    select ts.id into v_session_id
    from public.table_sessions ts
    where ts.id = v_attempt.table_session_id
      and ts.table_id = v_attempt.table_id
      and ts.status in ('ACTIVE','SETTLING')
    limit 1;
  end if;
  if v_session_id is null then
    v_session_id := public.build19_resolve_session_by_hash(v_attempt.table_id, v_attempt.branch_id, v_attempt.visit_token_hash, v_attempt.device_token_hash, true);
  end if;

  insert into public.orders(branch_id,table_id,table_session_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,paid_at,razorpay_payment_id,coupon_id,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot)
  values(v_attempt.branch_id,v_attempt.table_id,v_session_id,'NEW','PAID',concat('PAY_NOW:',case when v_method='' then 'ONLINE' else v_method end),v_attempt.subtotal,v_attempt.tax,v_attempt.discount,v_attempt.additional_charges,v_attempt.total,v_attempt.charge_breakdown,concat('payment-attempt:',v_attempt.id::text),encode(extensions.gen_random_bytes(16),'hex'),v_attempt.customer_note,v_attempt.customer_name,v_attempt.customer_phone,v_now,p_razorpay_payment_id,v_attempt.coupon_id,v_attempt.coupon_code_snapshot,v_attempt.discount_type_snapshot,v_attempt.discount_value_snapshot)
  returning * into v_order;

  update public.payment_attempts set table_session_id=v_order.table_session_id where id=v_attempt.id;

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
-- 8. Seat capacity is enforced across ALL open sessions
-- ============================================================
create or replace function public.build19_open_seat_usage(p_table_id uuid, p_exclude_session uuid default null)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(ts.occupancy_count),0)::int
  from public.table_sessions ts
  where ts.table_id = p_table_id
    and ts.status in ('ACTIVE','SETTLING')
    and (p_exclude_session is null or ts.id <> p_exclude_session);
$$;
revoke execute on function public.build19_open_seat_usage(uuid, uuid) from anon, authenticated, public;

create or replace function public.open_table_session(p_table_id uuid,p_occupancy_count integer default 1)
returns public.table_sessions
language plpgsql security definer set search_path=public
as $$
declare
  v_table public.tables%rowtype;
  v_session public.table_sessions%rowtype;
  v_count integer := greatest(0,coalesce(p_occupancy_count,1));
  v_user uuid := auth.uid();
  v_other integer := 0;
  v_free integer := 0;
begin
  select * into v_table from public.tables where id=p_table_id for update;
  if v_table.id is null then raise exception 'Table not found'; end if;
  if not v_table.active then raise exception 'Table is inactive'; end if;
  if not public.current_user_has_permission_for_branch(v_table.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to seat this table' using errcode='42501'; end if;
  if v_count > v_table.seats then raise exception 'Occupancy exceeds table capacity'; end if;

  if exists (
    select 1 from public.table_sessions ts
    where ts.table_id = p_table_id and ts.status = 'ACTIVE' and ts.origin = 'STAFF'
  ) then
    raise exception 'Table already has an active session';
  end if;

  -- Build 19.1: with seat tracking on, the COMBINED occupancy of every open
  -- session must fit the table. The row lock on public.tables above makes this
  -- check transactional against concurrent seatings of the same table.
  if v_table.seat_tracking_enabled then
    v_other := public.build19_open_seat_usage(p_table_id, null);
    if v_other + v_count > v_table.seats then
      raise exception 'Combined occupancy of open sessions (% + %) exceeds table capacity of %', v_other, v_count, v_table.seats;
    end if;
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
  v_other integer := 0;
  v_free integer := 0;
begin
  select * into v_session from public.table_sessions where id=p_session_id for update;
  if v_session.id is null or v_session.status='CLOSED' then raise exception 'Session is not open'; end if;
  select * into v_table from public.tables where id=v_session.table_id for update;
  if not public.current_user_has_permission_for_branch(v_session.branch_id,'EDIT_ORDERS') then raise exception 'You are not authorized to change occupancy' using errcode='42501'; end if;
  if v_count>v_table.seats then raise exception 'Occupancy exceeds table capacity'; end if;

  if v_table.seat_tracking_enabled then
    v_other := public.build19_open_seat_usage(v_table.id, v_session.id);
    if v_other + v_count > v_table.seats then
      raise exception 'Combined occupancy of open sessions (% + %) exceeds table capacity of %', v_other, v_count, v_table.seats;
    end if;
  end if;

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

-- ============================================================
-- 9. Retire the stray scan-only sessions Build 19 created
-- ============================================================
-- Only sessions that can be proven empty are closed: customer-scan origin, no
-- orders (of any status, including cancelled/rejected), no service requests of
-- any status, no coupon usage, and zero declared occupancy. Nothing is deleted,
-- so the rows stay queryable as history.
with stray as (
  select ts.id
  from public.table_sessions ts
  where ts.status in ('ACTIVE','SETTLING')
    and ts.origin = 'CUSTOMER_SCAN'
    and coalesce(ts.occupancy_count,0) = 0
    and not exists (select 1 from public.orders o where o.table_session_id = ts.id)
    and not exists (select 1 from public.service_requests r where r.table_session_id = ts.id)
    and not exists (select 1 from public.coupon_usages u where u.table_session_id = ts.id)
    and not exists (select 1 from public.table_seats s where s.session_id = ts.id and s.status = 'OCCUPIED')
)
update public.table_sessions t
set status = 'CLOSED',
    closed_at = coalesce(t.closed_at, now()),
    updated_at = now()
from stray
where t.id = stray.id;

-- Re-derive every table so freed tables return to AVAILABLE immediately.
do $$
declare r record;
begin
  for r in select id from public.tables loop
    perform public.build17_sync_table_operational_state(r.id);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
