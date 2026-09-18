-- TABLELY BUILD 13.3 — fix "Could not finalize payment." after a successful
-- Razorpay charge.
--
-- Root cause: payment_transactions_provider_order_uidx (see
-- 202609150026_fix_razorpay_order_columns.sql) is a PARTIAL unique index:
--   create unique index ... on payment_transactions(provider_order_id)
--     where provider_order_id is not null;
-- Postgres can only use a partial unique index as an ON CONFLICT arbiter if
-- the statement's ON CONFLICT clause repeats the exact same WHERE predicate.
-- finalize_payment_attempt(), record_online_payment_failure() and
-- record_online_payment_failure_by_provider() all did:
--   on conflict (provider_order_id) do update set ...
-- with no predicate, so Postgres cannot resolve an arbiter at all and raises
--   42P10: there is no unique or exclusion constraint matching the ON
--   CONFLICT specification
-- on every single call -- not just on an actual duplicate. That is exactly
-- what happened after every successful online payment: Razorpay charges the
-- customer, the client calls /api/payments/verify, the route calls
-- finalize_payment_attempt(), and that RPC has always failed at the
-- "insert into payment_transactions ... on conflict (provider_order_id)"
-- step, so the order was never created/marked paid and the customer saw
-- "Could not finalize payment." even though their money was taken.
--
-- Fix: add "where provider_order_id is not null" to every ON CONFLICT
-- clause targeting that column so it matches the partial index's predicate.
-- Also route the two remaining raw-JS upserts (payments/webhook and the
-- legacy branch of payments/verify) through a new SECURITY DEFINER RPC that
-- has the same fix baked in, since PostgREST's `.upsert(..., {onConflict})`
-- cannot express a WHERE predicate on the conflict target from JS.

begin;

-- 1) finalize_payment_attempt: both INSERT ... ON CONFLICT sites fixed.
create or replace function public.finalize_payment_attempt(
  p_payment_attempt_id uuid,
  p_attempt_token text,
  p_razorpay_payment_id text,
  p_payment_method text
)
returns table(order_id uuid,order_number bigint,tracking_token text,total numeric,payment_status public.payment_status,status public.order_status)
language plpgsql security definer set search_path=public as $$
declare
  v_attempt public.payment_attempts%rowtype;
  v_order public.orders%rowtype;
  v_existing public.orders%rowtype;
  v_now timestamptz:=now();
  v_item jsonb;
  v_method text:=upper(trim(coalesce(p_payment_method,'ONLINE')));
  v_token text:=nullif(trim(p_attempt_token),'');
  v_idempotency_key text;
begin
  if p_payment_attempt_id is null or v_token is null then
    raise exception 'Invalid payment attempt' using errcode='P0001';
  end if;

  select * into v_attempt
  from public.payment_attempts
  where id=p_payment_attempt_id and attempt_token=v_token
  for update;

  if v_attempt.id is null then
    raise exception 'Payment attempt not found' using errcode='P0002';
  end if;

  -- Idempotent replay: if this attempt already created its order, return it.
  if v_attempt.status='SUCCESS' and v_attempt.order_id is not null then
    select * into v_order from public.orders where id=v_attempt.order_id;
    if v_order.id is null then
      raise exception 'Payment attempt is finalized but its order is missing' using errcode='P0001';
    end if;
    return query select v_order.id,v_order.order_number,v_order.tracking_token,
      v_order.total,v_order.payment_status,v_order.status;
    return;
  end if;

  if v_attempt.status in ('FAILED','EXPIRED') then
    raise exception 'Payment attempt is no longer valid' using errcode='P0001';
  end if;

  if v_attempt.status not in ('PENDING','PROCESSING') then
    raise exception 'Payment attempt is not finalizable' using errcode='P0001';
  end if;

  if v_attempt.payment_expires_at<=v_now then
    update public.payment_attempts
      set status='EXPIRED',failure_reason='Payment session expired',
          updated_at=v_now,completed_at=v_now
    where id=v_attempt.id;
    raise exception 'Payment session expired. Please place a new order.' using errcode='P0001';
  end if;

  if nullif(trim(coalesce(p_razorpay_payment_id,'')),'') is null then
    raise exception 'Razorpay payment ID is required' using errcode='P0001';
  end if;

  if nullif(trim(coalesce(v_attempt.razorpay_order_id,'')),'') is null then
    raise exception 'Razorpay order ID is missing' using errcode='P0001';
  end if;

  v_idempotency_key := concat('payment-attempt:',v_attempt.id::text);

  -- Defensive idempotency check in case a prior attempt created the order but
  -- the payment_attempt row was not finalized by an older server execution.
  select * into v_existing
  from public.orders
  where branch_id=v_attempt.branch_id
    and idempotency_key=v_idempotency_key
  limit 1
  for update;

  if v_existing.id is not null then
    if v_existing.payment_status::text <> 'PAID' then
      update public.orders
      set payment_status='PAID',
          payment_method=concat('PAY_NOW:',case when v_method='' then 'ONLINE' else v_method end),
          razorpay_payment_id=p_razorpay_payment_id,
          paid_at=coalesce(paid_at,v_now),
          updated_at=v_now
      where id=v_existing.id;
      select * into v_existing from public.orders where id=v_existing.id;
    end if;

    insert into public.payment_transactions(
      order_id,branch_id,provider,provider_order_id,provider_payment_id,
      amount,status,method,raw_metadata
    )
    values(
      v_existing.id,v_existing.branch_id,'RAZORPAY',v_attempt.razorpay_order_id,
      p_razorpay_payment_id,v_existing.total,'CAPTURED',v_method,
      jsonb_build_object('payment_attempt_id',v_attempt.id,'source','payment-first-finalize')
    )
    on conflict (provider_order_id) where provider_order_id is not null do update set
      order_id=excluded.order_id,
      provider_payment_id=excluded.provider_payment_id,
      amount=excluded.amount,
      status=excluded.status,
      method=excluded.method,
      raw_metadata=excluded.raw_metadata,
      updated_at=now();

    update public.payment_attempts
    set status='SUCCESS',razorpay_payment_id=p_razorpay_payment_id,
        order_id=v_existing.id,completed_at=v_now,updated_at=v_now
    where id=v_attempt.id;

    return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,
      v_existing.total,v_existing.payment_status,v_existing.status;
    return;
  end if;

  insert into public.orders(
    branch_id,table_id,status,payment_status,payment_method,
    subtotal,tax,discount,additional_charges,total,charge_breakdown,
    idempotency_key,tracking_token,customer_note,customer_name,customer_phone,
    paid_at,razorpay_payment_id
  )
  values(
    v_attempt.branch_id,v_attempt.table_id,'NEW','PAID',
    concat('PAY_NOW:',case when v_method='' then 'ONLINE' else v_method end),
    v_attempt.subtotal,v_attempt.tax,v_attempt.discount,v_attempt.additional_charges,
    v_attempt.total,v_attempt.charge_breakdown,v_idempotency_key,
    encode(extensions.gen_random_bytes(16),'hex'),v_attempt.customer_note,
    v_attempt.customer_name,v_attempt.customer_phone,v_now,p_razorpay_payment_id
  )
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(v_attempt.items_snapshot) loop
    insert into public.order_items(
      order_id,menu_item_id,item_name_snapshot,unit_price,quantity,
      selected_addons,special_instructions
    )
    values(
      v_order.id,
      (v_item->>'menu_item_id')::uuid,
      v_item->>'item_name_snapshot',
      (v_item->>'unit_price')::numeric,
      (v_item->>'quantity')::integer,
      coalesce(v_item->'selected_addons','[]'::jsonb),
      nullif(v_item->>'special_instructions','')
    );
  end loop;

  insert into public.payment_transactions(
    order_id,branch_id,provider,provider_order_id,provider_payment_id,
    amount,status,method,raw_metadata
  )
  values(
    v_order.id,v_order.branch_id,'RAZORPAY',v_attempt.razorpay_order_id,
    p_razorpay_payment_id,v_order.total,'CAPTURED',v_method,
    jsonb_build_object('payment_attempt_id',v_attempt.id,'source','payment-first-finalize')
  )
  on conflict (provider_order_id) where provider_order_id is not null do update set
    order_id=excluded.order_id,
    provider_payment_id=excluded.provider_payment_id,
    amount=excluded.amount,
    status=excluded.status,
    method=excluded.method,
    raw_metadata=excluded.raw_metadata,
    updated_at=now();

  update public.payment_attempts
  set status='SUCCESS',razorpay_payment_id=p_razorpay_payment_id,
      order_id=v_order.id,completed_at=v_now,updated_at=v_now
  where id=v_attempt.id;

  return query select v_order.id,v_order.order_number,v_order.tracking_token,
    v_order.total,v_order.payment_status,v_order.status;
end;
$$;

revoke execute on function public.finalize_payment_attempt(uuid,text,text,text) from anon,authenticated,public;
grant execute on function public.finalize_payment_attempt(uuid,text,text,text) to service_role;
alter function public.finalize_payment_attempt(uuid,text,text,text) set search_path=public;

-- 2) record_online_payment_failure / record_online_payment_failure_by_provider:
--    same ON CONFLICT arbiter fix.
create or replace function public.record_online_payment_failure(p_order_id uuid,p_tracking_token text,p_razorpay_order_id text,p_razorpay_payment_id text default null,p_reason text default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype;
begin
  select o.* into v_order from public.orders o where o.id=p_order_id and o.tracking_token=trim(p_tracking_token) for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.razorpay_order_id is null or v_order.razorpay_order_id<>p_razorpay_order_id then raise exception 'Payment order mismatch'; end if;
  if v_order.payment_status='PAID' or v_order.status='COMPLETED' then return false; end if;
  if v_order.status='CANCELLED' and coalesce(v_order.cancellation_reason,'')<>'ONLINE_PAYMENT_FAILED' then return false; end if;
  insert into public.payment_transactions(order_id,branch_id,provider,provider_order_id,provider_payment_id,amount,status,method,failure_reason,raw_metadata)
  values(v_order.id,v_order.branch_id,'RAZORPAY',p_razorpay_order_id,p_razorpay_payment_id,v_order.total,'FAILED',null,nullif(left(trim(coalesce(p_reason,'Online payment failed')),200),''),jsonb_build_object('source','customer_checkout_failure'))
  on conflict (provider_order_id) where provider_order_id is not null do update set status='FAILED',provider_payment_id=coalesce(excluded.provider_payment_id,payment_transactions.provider_payment_id),failure_reason=excluded.failure_reason,raw_metadata=excluded.raw_metadata,updated_at=now();
  update public.orders ord set payment_status='FAILED',status='CANCELLED',cancellation_reason='ONLINE_PAYMENT_FAILED',cancelled_by=null,cancelled_at=coalesce(ord.cancelled_at,now()),updated_at=now() where ord.id=v_order.id and ord.payment_status='PENDING' and ord.status<>'CANCELLED';
  return true;
end;
$$;
grant execute on function public.record_online_payment_failure(uuid,text,text,text,text) to anon,authenticated;
revoke execute on function public.record_online_payment_failure(uuid,text,text,text,text) from public;
alter function public.record_online_payment_failure(uuid,text,text,text,text) set search_path=public;

create or replace function public.record_online_payment_failure_by_provider(p_razorpay_order_id text,p_razorpay_payment_id text default null,p_reason text default null,p_metadata jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype;
begin
  select o.* into v_order from public.orders o where o.razorpay_order_id=p_razorpay_order_id for update;
  if v_order.id is null then return false; end if;
  if v_order.payment_status='PAID' or v_order.status='COMPLETED' then return false; end if;
  if v_order.status='CANCELLED' and coalesce(v_order.cancellation_reason,'')<>'ONLINE_PAYMENT_FAILED' then return false; end if;
  insert into public.payment_transactions(order_id,branch_id,provider,provider_order_id,provider_payment_id,amount,status,method,failure_reason,raw_metadata)
  values(v_order.id,v_order.branch_id,'RAZORPAY',p_razorpay_order_id,p_razorpay_payment_id,v_order.total,'FAILED',null,nullif(left(trim(coalesce(p_reason,'Online payment failed')),200),''),coalesce(p_metadata,'{}'::jsonb))
  on conflict (provider_order_id) where provider_order_id is not null do update set status='FAILED',provider_payment_id=coalesce(excluded.provider_payment_id,payment_transactions.provider_payment_id),failure_reason=excluded.failure_reason,raw_metadata=excluded.raw_metadata,updated_at=now();
  update public.orders ord set payment_status='FAILED',status='CANCELLED',cancellation_reason='ONLINE_PAYMENT_FAILED',cancelled_by=null,cancelled_at=coalesce(ord.cancelled_at,now()),updated_at=now() where ord.id=v_order.id and ord.payment_status='PENDING' and ord.status<>'CANCELLED';
  return true;
end;
$$;
revoke all on function public.record_online_payment_failure_by_provider(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_online_payment_failure_by_provider(text,text,text,jsonb) to service_role;
alter function public.record_online_payment_failure_by_provider(text,text,text,jsonb) set search_path=public;

-- 3) New RPC for the two remaining raw-JS upserts (payments/webhook and the
--    legacy branch of payments/verify) which used
--    `.upsert(..., {onConflict:'provider_order_id'})` -- PostgREST generates
--    a plain `ON CONFLICT (provider_order_id) DO UPDATE` with no predicate,
--    the exact same defect, just triggered from JS instead of PL/pgSQL.
--    Routing both call sites through this RPC applies the same fix.
create or replace function public.record_razorpay_payment_transaction(
  p_order_id uuid,
  p_branch_id uuid,
  p_provider_order_id text,
  p_provider_payment_id text,
  p_amount numeric,
  p_currency text,
  p_status text,
  p_method text,
  p_raw_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql security definer set search_path=public as $$
begin
  insert into public.payment_transactions(
    order_id,branch_id,provider,provider_order_id,provider_payment_id,
    amount,currency,status,method,raw_metadata
  )
  values(
    p_order_id,p_branch_id,'RAZORPAY',p_provider_order_id,p_provider_payment_id,
    p_amount,coalesce(nullif(trim(coalesce(p_currency,'')),''),'INR'),
    p_status,p_method,coalesce(p_raw_metadata,'{}'::jsonb)
  )
  on conflict (provider_order_id) where provider_order_id is not null do update set
    order_id=excluded.order_id,
    provider_payment_id=excluded.provider_payment_id,
    amount=excluded.amount,
    currency=excluded.currency,
    status=excluded.status,
    method=excluded.method,
    raw_metadata=excluded.raw_metadata,
    updated_at=now();
end;
$$;
revoke all on function public.record_razorpay_payment_transaction(uuid,uuid,text,text,numeric,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_razorpay_payment_transaction(uuid,uuid,text,text,numeric,text,text,text,jsonb) to service_role;
alter function public.record_razorpay_payment_transaction(uuid,uuid,text,text,numeric,text,text,text,jsonb) set search_path=public;

notify pgrst, 'reload schema';

commit;
