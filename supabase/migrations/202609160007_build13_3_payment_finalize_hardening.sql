-- TABLELY BUILD 13.3 — payment-first finalization hardening
-- Ensures the payment finalizer can complete successfully on databases where
-- the provider-order uniqueness migration was not present, and keeps the
-- operation idempotent per payment attempt.

begin;

create unique index if not exists payment_transactions_provider_order_uidx
  on public.payment_transactions(provider_order_id)
  where provider_order_id is not null;

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
    on conflict (provider_order_id) do update set
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
  on conflict (provider_order_id) do update set
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

notify pgrst, 'reload schema';

commit;
