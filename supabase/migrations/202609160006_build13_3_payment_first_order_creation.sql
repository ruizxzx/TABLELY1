-- TABLELY BUILD 13.3 — PAYMENT-FIRST ORDER CREATION
-- PAY_NOW creates a payment attempt first. A restaurant order is created only after
-- server-side Razorpay verification succeeds. PAY_AT_COUNTER keeps the normal flow.

begin;

create table if not exists public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  attempt_token text not null unique,
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  idempotency_key text not null,
  payment_method text not null default 'PAY_NOW' check (payment_method = 'PAY_NOW'),
  items_snapshot jsonb not null,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  tax numeric(12,2) not null default 0 check (tax >= 0),
  discount numeric(12,2) not null default 0 check (discount >= 0),
  additional_charges numeric(12,2) not null default 0 check (additional_charges >= 0),
  total numeric(12,2) not null check (total >= 0),
  charge_breakdown jsonb not null default '[]'::jsonb,
  customer_note text,
  customer_name text not null,
  customer_phone text not null,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','SUCCESS','FAILED','EXPIRED')),
  razorpay_order_id text unique,
  razorpay_payment_id text,
  order_id uuid unique references public.orders(id) on delete set null,
  failure_reason text,
  payment_started_at timestamptz not null default now(),
  payment_expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_attempts_active_idempotency_uidx
  on public.payment_attempts(branch_id, idempotency_key)
  where status in ('PENDING','PROCESSING');
create index if not exists payment_attempts_expiry_idx
  on public.payment_attempts(payment_expires_at)
  where status in ('PENDING','PROCESSING');
create index if not exists payment_attempts_branch_created_idx
  on public.payment_attempts(branch_id, created_at desc);

alter table public.payment_attempts enable row level security;
revoke all on public.payment_attempts from anon, authenticated, public;

-- A direct PAY_NOW call to the old public order RPC is no longer valid.
drop function if exists public.create_order_for_table(text,jsonb,text,text,text,text,text);
create function public.create_order_for_table(
  p_table_code text,
  p_items jsonb,
  p_payment_method text default 'PAY_AT_COUNTER',
  p_idempotency_key text default null,
  p_customer_note text default null,
  p_customer_name text default null,
  p_customer_phone text default null
)
returns table (
  order_id uuid,
  order_number bigint,
  tracking_token text,
  subtotal numeric,
  tax numeric,
  additional_charges numeric,
  discount numeric,
  total numeric,
  charge_breakdown jsonb,
  payment_status public.payment_status,
  status public.order_status
)
language plpgsql security definer set search_path=public as $$
declare
  v_table public.tables%rowtype;
  v_existing public.orders%rowtype;
  v_order_id uuid;
  v_order_number bigint;
  v_tracking_token text;
  v_subtotal numeric(12,2) := 0;
  v_discount numeric(12,2) := 0;
  v_tax numeric(12,2) := 0;
  v_additional numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_breakdown jsonb := '[]'::jsonb;
  v_payment_method text := upper(trim(coalesce(p_payment_method, 'PAY_AT_COUNTER')));
  v_idempotency text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_item jsonb;
  v_menu public.menu_items%rowtype;
  v_qty integer;
  v_line numeric(12,2);
  v_branch_id uuid;
  v_charge record;
  v_charge_amount numeric(12,2);
  v_customer_name text := nullif(left(trim(coalesce(p_customer_name,'')),120),'');
  v_customer_phone text := nullif(regexp_replace(trim(coalesce(p_customer_phone,'')), '[^0-9]', '', 'g'),'');
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Cart is empty'; end if;
  if v_customer_name is null then raise exception 'Customer name is required'; end if;
  if v_customer_phone is null or length(v_customer_phone) < 10 or length(v_customer_phone) > 15 then raise exception 'Valid customer phone is required'; end if;
  if length(v_customer_phone)=12 and left(v_customer_phone,2)='91' then v_customer_phone:=right(v_customer_phone,10); end if;
  if length(v_customer_phone) <> 10 or left(v_customer_phone,1) not in ('6','7','8','9') then raise exception 'Valid customer phone is required'; end if;
  select t.* into v_table
  from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  v_branch_id:=v_table.branch_id;
  if v_idempotency is not null then
    select * into v_existing from public.orders where branch_id=v_branch_id and idempotency_key=v_idempotency limit 1;
    if v_existing.id is not null then
      return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.subtotal,v_existing.tax,v_existing.additional_charges,v_existing.discount,v_existing.total,v_existing.charge_breakdown,v_existing.payment_status,v_existing.status;
      return;
    end if;
  end if;
  if v_payment_method = 'PAY_NOW' then raise exception 'PAY_NOW orders must use the payment-first checkout flow' using errcode='P0001'; end if;
  if v_payment_method <> 'PAY_AT_COUNTER' then raise exception 'Unsupported payment method'; end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if not (v_item ? 'menu_item_id') or not (v_item ? 'quantity') then raise exception 'Invalid cart item'; end if;
    v_qty:=greatest(0,least(50,(v_item->>'quantity')::integer));
    if v_qty<=0 then raise exception 'Item quantity must be positive'; end if;
    select * into v_menu from public.menu_items where id=(v_item->>'menu_item_id')::uuid and branch_id=v_branch_id and is_available=true;
    if v_menu.id is null then raise exception 'One or more items are unavailable'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested where not exists(select 1 from jsonb_array_elements(v_menu.addons) a where a->>'name'=requested->>'name')) then raise exception 'One or more selected add-ons are invalid'; end if;
    v_line:=round((v_menu.price+coalesce((select sum(coalesce((a->>'price')::numeric,0)) from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested join jsonb_array_elements(v_menu.addons) a on a->>'name'=requested->>'name'),0))*v_qty,2);
    v_subtotal:=v_subtotal+v_line;
    if v_subtotal>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;
  end loop;

  for v_charge in
    select c.name,c.charge_type,c.calculation_type,c.value
    from public.restaurant_charge_settings c
    where c.enabled=true
      and (
        c.branch_id=v_branch_id
        or (
          c.branch_id is null
          and not exists (
            select 1 from public.restaurant_charge_settings cb
            where cb.organization_id=c.organization_id
              and cb.branch_id=v_branch_id
          )
        )
      )
    order by c.sort_order,c.created_at
  loop
    if v_charge.calculation_type='PERCENT' then
      v_charge_amount:=round((v_subtotal-v_discount)*v_charge.value/100.0,2);
    else
      v_charge_amount:=round(v_charge.value,2);
    end if;
    if v_charge_amount<0 then v_charge_amount:=0; end if;
    if v_charge.charge_type='TAX' then v_tax:=v_tax+v_charge_amount; else v_additional:=v_additional+v_charge_amount; end if;
    v_breakdown:=v_breakdown || jsonb_build_object('name',v_charge.name,'charge_type',v_charge.charge_type,'calculation_type',v_charge.calculation_type,'value',v_charge.value,'amount',v_charge_amount);
  end loop;
  v_total:=round(v_subtotal-v_discount+v_tax+v_additional,2);
  if v_total>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;

  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,payment_started_at,payment_expires_at)
  values(v_branch_id,v_table.id,'NEW','PENDING',v_payment_method,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,coalesce(v_idempotency,encode(extensions.gen_random_bytes(16),'hex')),encode(extensions.gen_random_bytes(16),'hex'),nullif(trim(coalesce(p_customer_note,'')),''),v_customer_name,v_customer_phone,case when v_payment_method='PAY_NOW' then now() else null end,case when v_payment_method='PAY_NOW' then now() + interval '1 hour' else null end)
  returning id into v_order_id;

  select o.order_number,o.tracking_token into v_order_number,v_tracking_token from public.orders o where o.id=v_order_id;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty:=(v_item->>'quantity')::integer;
    select * into v_menu from public.menu_items where id=(v_item->>'menu_item_id')::uuid and branch_id=v_branch_id;
    insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions)
    values(v_order_id,v_menu.id,v_menu.name,v_menu.price+coalesce((select sum(coalesce((a->>'price')::numeric,0)) from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested join jsonb_array_elements(v_menu.addons) a on a->>'name'=requested->>'name'),0),v_qty,coalesce((select jsonb_agg(jsonb_build_object('name',a->>'name','price',coalesce((a->>'price')::numeric,0)) order by a->>'name') from jsonb_array_elements(v_menu.addons) a where exists(select 1 from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested where requested->>'name'=a->>'name')),'[]'::jsonb),nullif(trim(coalesce(v_item->>'note','')),''));
  end loop;

  return query select v_order_id,v_order_number,v_tracking_token,v_subtotal,v_tax,v_additional,v_discount,v_total,v_breakdown,(select o.payment_status from public.orders o where o.id=v_order_id),(select o.status from public.orders o where o.id=v_order_id);
exception when unique_violation then
  if v_idempotency is not null then
    select * into v_existing from public.orders where branch_id=v_branch_id and idempotency_key=v_idempotency limit 1;
    if v_existing.id is not null then
      return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.subtotal,v_existing.tax,v_existing.additional_charges,v_existing.discount,v_existing.total,v_existing.charge_breakdown,v_existing.payment_status,v_existing.status;
      return;
    end if;
  end if;
  raise;
end;$$;
grant execute on function public.create_order_for_table(text,jsonb,text,text,text,text,text) to anon,authenticated;
revoke execute on function public.create_order_for_table(text,jsonb,text,text,text,text,text) from public;
alter function public.create_order_for_table(text,jsonb,text,text,text,text,text) set search_path=public;


create or replace function public.create_payment_attempt_for_table(
  p_table_code text,
  p_items jsonb,
  p_idempotency_key text,
  p_customer_note text default null,
  p_customer_name text default null,
  p_customer_phone text default null
)
returns table(
  payment_attempt_id uuid,
  attempt_token text,
  total numeric,
  payment_started_at timestamptz,
  payment_expires_at timestamptz
)
language plpgsql security definer set search_path=public as $$
declare
  v_table public.tables%rowtype;
  v_attempt public.payment_attempts%rowtype;
  v_subtotal numeric(12,2):=0;
  v_discount numeric(12,2):=0;
  v_tax numeric(12,2):=0;
  v_additional numeric(12,2):=0;
  v_total numeric(12,2):=0;
  v_breakdown jsonb:='[]'::jsonb;
  v_snapshot jsonb:='[]'::jsonb;
  v_item jsonb;
  v_menu public.menu_items%rowtype;
  v_qty integer;
  v_unit numeric(12,2);
  v_line numeric(12,2);
  v_charge record;
  v_charge_amount numeric(12,2);
  v_name text:=nullif(left(trim(coalesce(p_customer_name,'')),120),'');
  v_phone text:=nullif(regexp_replace(trim(coalesce(p_customer_phone,'')),'[^0-9]','','g'),'');
  v_idem text:=nullif(trim(coalesce(p_idempotency_key,'')),'');
  v_now timestamptz:=now();
begin
  if v_idem is null then raise exception 'Checkout session key is required'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Cart is empty'; end if;
  if v_name is null then raise exception 'Customer name is required'; end if;
  if v_phone is null or length(v_phone)<10 or length(v_phone)>15 then raise exception 'Valid customer phone is required'; end if;
  if length(v_phone)=12 and left(v_phone,2)='91' then v_phone:=right(v_phone,10); end if;
  if length(v_phone)<>10 or left(v_phone,1) not in ('6','7','8','9') then raise exception 'Valid customer phone is required'; end if;

  select * into v_table
  from public.tables t
  join public.branches b on b.id=t.branch_id
  join public.organizations o on o.id=b.organization_id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
  limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;

  -- Reuse an active idempotent attempt; expired/failed attempts with the same browser
  -- session key are intentionally allowed to create a fresh attempt.
  select pa.* into v_attempt
  from public.payment_attempts pa
  where pa.branch_id=v_table.branch_id
    and pa.idempotency_key=v_idem
    and pa.status in ('PENDING','PROCESSING')
  order by pa.created_at desc limit 1;
  if v_attempt.id is not null then
    if v_attempt.payment_expires_at<=v_now then
      update public.payment_attempts set status='EXPIRED',updated_at=v_now,failure_reason='Payment session expired' where id=v_attempt.id;
    else
      return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at;
      return;
    end if;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    if not (v_item ? 'menu_item_id') or not (v_item ? 'quantity') then raise exception 'Invalid cart item'; end if;
    v_qty:=greatest(0,least(50,(v_item->>'quantity')::integer));
    if v_qty<=0 then raise exception 'Item quantity must be positive'; end if;
    select * into v_menu from public.menu_items where id=(v_item->>'menu_item_id')::uuid and branch_id=v_table.branch_id and is_available=true;
    if v_menu.id is null then raise exception 'One or more items are unavailable'; end if;
    if exists(select 1 from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested where not exists(select 1 from jsonb_array_elements(v_menu.addons) a where a->>'name'=requested->>'name')) then raise exception 'One or more selected add-ons are invalid'; end if;
    v_unit:=round(v_menu.price+coalesce((select sum(coalesce((a->>'price')::numeric,0)) from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested join jsonb_array_elements(v_menu.addons) a on a->>'name'=requested->>'name'),0),2);
    v_line:=round(v_unit*v_qty,2);
    v_subtotal:=v_subtotal+v_line;
    if v_subtotal>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;
    v_snapshot:=v_snapshot||jsonb_build_array(jsonb_build_object(
      'menu_item_id',v_menu.id,
      'item_name_snapshot',v_menu.name,
      'unit_price',v_unit,
      'quantity',v_qty,
      'selected_addons',coalesce((select jsonb_agg(jsonb_build_object('name',a->>'name','price',coalesce((a->>'price')::numeric,0)) order by a->>'name') from jsonb_array_elements(v_menu.addons) a where exists(select 1 from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested where requested->>'name'=a->>'name')),'[]'::jsonb),
      'special_instructions',nullif(trim(coalesce(v_item->>'note','')),'')));
  end loop;

  for v_charge in
    select c.name,c.charge_type,c.calculation_type,c.value
    from public.restaurant_charge_settings c
    where c.enabled=true and (c.branch_id=v_table.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_table.branch_id)))
    order by c.sort_order,c.created_at
  loop
    if v_charge.calculation_type='PERCENT' then v_charge_amount:=round((v_subtotal-v_discount)*v_charge.value/100.0,2); else v_charge_amount:=round(v_charge.value,2); end if;
    if v_charge_amount<0 then v_charge_amount:=0; end if;
    if v_charge.charge_type='TAX' then v_tax:=v_tax+v_charge_amount; else v_additional:=v_additional+v_charge_amount; end if;
    v_breakdown:=v_breakdown||jsonb_build_object('name',v_charge.name,'charge_type',v_charge.charge_type,'calculation_type',v_charge.calculation_type,'value',v_charge.value,'amount',v_charge_amount);
  end loop;
  v_total:=round(v_subtotal-v_discount+v_tax+v_additional,2);
  if v_total>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;

  insert into public.payment_attempts(attempt_token,branch_id,table_id,idempotency_key,items_snapshot,subtotal,tax,discount,additional_charges,total,charge_breakdown,customer_note,customer_name,customer_phone,payment_started_at,payment_expires_at)
  values(encode(extensions.gen_random_bytes(32),'hex'),v_table.branch_id,v_table.id,v_idem,v_snapshot,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_phone,v_now,v_now+interval '1 hour')
  returning * into v_attempt;

  return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at;
exception when unique_violation then
  select * into v_attempt from public.payment_attempts where branch_id=v_table.branch_id and idempotency_key=v_idem and status in ('PENDING','PROCESSING') order by created_at desc limit 1;
  if v_attempt.id is not null then return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at; return; end if;
  raise;
end;
$$;
grant execute on function public.create_payment_attempt_for_table(text,jsonb,text,text,text,text) to anon,authenticated;
revoke execute on function public.create_payment_attempt_for_table(text,jsonb,text,text,text,text) from public;
alter function public.create_payment_attempt_for_table(text,jsonb,text,text,text,text) set search_path=public;

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
  v_now timestamptz:=now();
  v_item jsonb;
  v_method text:=upper(trim(coalesce(p_payment_method,'ONLINE')));
  v_token text:=nullif(trim(p_attempt_token),'');
begin
  if v_payment_attempt_id is null or v_token is null then raise exception 'Invalid payment attempt'; end if;
  select * into v_attempt from public.payment_attempts where id=p_payment_attempt_id and attempt_token=v_token for update;
  if v_attempt.id is null then raise exception 'Payment attempt not found' using errcode='P0002'; end if;
  if v_attempt.status='SUCCESS' and v_attempt.order_id is not null then
    select * into v_order from public.orders where id=v_attempt.order_id;
    return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.total,v_order.payment_status,v_order.status;
    return;
  end if;
  if v_attempt.status in ('FAILED','EXPIRED') then raise exception 'Payment attempt is no longer valid' using errcode='P0001'; end if;
  if v_attempt.payment_expires_at<=v_now then
    update public.payment_attempts set status='EXPIRED',failure_reason='Payment session expired',updated_at=v_now,completed_at=v_now where id=v_attempt.id;
    raise exception 'Payment session expired. Please place a new order.' using errcode='P0001';
  end if;

  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,paid_at,razorpay_payment_id)
  values(v_attempt.branch_id,v_attempt.table_id,'NEW','PAID',concat('PAY_NOW:',case when v_method='' then 'ONLINE' else v_method end),v_attempt.subtotal,v_attempt.tax,v_attempt.discount,v_attempt.additional_charges,v_attempt.total,v_attempt.charge_breakdown,concat('payment-attempt:',v_attempt.id::text),encode(extensions.gen_random_bytes(16),'hex'),v_attempt.customer_note,v_attempt.customer_name,v_attempt.customer_phone,v_now,p_razorpay_payment_id)
  returning * into v_order;

  for v_item in select * from jsonb_array_elements(v_attempt.items_snapshot) loop
    insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions)
    values(v_order.id,(v_item->>'menu_item_id')::uuid,v_item->>'item_name_snapshot',(v_item->>'unit_price')::numeric,(v_item->>'quantity')::integer,coalesce(v_item->'selected_addons','[]'::jsonb),nullif(v_item->>'special_instructions',''));
  end loop;

  insert into public.payment_transactions(order_id,branch_id,provider,provider_order_id,provider_payment_id,amount,status,method,raw_metadata)
  values(v_order.id,v_order.branch_id,'RAZORPAY',v_attempt.razorpay_order_id,p_razorpay_payment_id,v_order.total,'CAPTURED',v_method,jsonb_build_object('payment_attempt_id',v_attempt.id,'source','payment-first-finalize'))
  on conflict (provider_order_id) do update set order_id=excluded.order_id,provider_payment_id=excluded.provider_payment_id,amount=excluded.amount,status=excluded.status,method=excluded.method,raw_metadata=excluded.raw_metadata,updated_at=now();

  update public.payment_attempts set status='SUCCESS',razorpay_payment_id=p_razorpay_payment_id,order_id=v_order.id,completed_at=v_now,updated_at=v_now where id=v_attempt.id;

  return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.total,v_order.payment_status,v_order.status;
end;
$$;
revoke execute on function public.finalize_payment_attempt(uuid,text,text,text) from anon,authenticated,public;
grant execute on function public.finalize_payment_attempt(uuid,text,text,text) to service_role;
alter function public.finalize_payment_attempt(uuid,text,text,text) set search_path=public;

create or replace function public.mark_payment_attempt_failed(
  p_payment_attempt_id uuid,
  p_attempt_token text,
  p_razorpay_payment_id text default null,
  p_reason text default null
)
returns boolean
language plpgsql security definer set search_path=public as $$
declare v_attempt public.payment_attempts%rowtype;
begin
  select * into v_attempt from public.payment_attempts where id=p_payment_attempt_id and attempt_token=p_attempt_token for update;
  if v_attempt.id is null then raise exception 'Payment attempt not found' using errcode='P0002'; end if;
  if v_attempt.status='SUCCESS' then return false; end if;
  if v_attempt.status in ('FAILED','EXPIRED') then return false; end if;
  update public.payment_attempts set status='FAILED',razorpay_payment_id=coalesce(p_razorpay_payment_id,razorpay_payment_id),failure_reason=nullif(left(trim(coalesce(p_reason,'Online payment failed')),200),''),updated_at=now(),completed_at=now() where id=v_attempt.id;
  return true;
end;
$$;
revoke execute on function public.mark_payment_attempt_failed(uuid,text,text,text) from anon,authenticated,public;
grant execute on function public.mark_payment_attempt_failed(uuid,text,text,text) to service_role;
alter function public.mark_payment_attempt_failed(uuid,text,text,text) set search_path=public;

create or replace function public.expire_stale_payment_attempts()
returns integer
language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  update public.payment_attempts
  set status='EXPIRED',failure_reason='Payment session expired',updated_at=now(),completed_at=now()
  where status in ('PENDING','PROCESSING') and payment_expires_at<=now();
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;
revoke execute on function public.expire_stale_payment_attempts() from anon,authenticated,public;
grant execute on function public.expire_stale_payment_attempts() to service_role;
alter function public.expire_stale_payment_attempts() set search_path=public;

create or replace function public.set_payment_attempt_razorpay_order(
  p_payment_attempt_id uuid,
  p_attempt_token text,
  p_razorpay_order_id text
)
returns boolean
language plpgsql security definer set search_path=public as $$
declare v_attempt public.payment_attempts%rowtype;
begin
  select * into v_attempt from public.payment_attempts where id=p_payment_attempt_id and attempt_token=p_attempt_token for update;
  if v_attempt.id is null then raise exception 'Payment attempt not found' using errcode='P0002'; end if;
  if v_attempt.status in ('FAILED','EXPIRED','SUCCESS') then raise exception 'Payment attempt is no longer active' using errcode='P0001'; end if;
  if v_attempt.payment_expires_at<=now() then
    update public.payment_attempts set status='EXPIRED',failure_reason='Payment session expired',updated_at=now(),completed_at=now() where id=v_attempt.id;
    raise exception 'Payment session expired. Please place a new order.' using errcode='P0001';
  end if;
  update public.payment_attempts set razorpay_order_id=p_razorpay_order_id,status='PROCESSING',updated_at=now() where id=v_attempt.id;
  return true;
end;
$$;
revoke execute on function public.set_payment_attempt_razorpay_order(uuid,text,text) from anon,authenticated,public;
grant execute on function public.set_payment_attempt_razorpay_order(uuid,text,text) to service_role;
alter function public.set_payment_attempt_razorpay_order(uuid,text,text) set search_path=public;

-- Schedule the server-side expiry every minute when pg_cron is available.
do $$
begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    begin perform cron.unschedule('tablely-expire-payment-attempts'); exception when others then null; end;
    perform cron.schedule('tablely-expire-payment-attempts','* * * * *','select public.expire_stale_payment_attempts();');
  end if;
exception when others then
  raise notice 'TABLELY: pg_cron scheduling unavailable; expiry remains enforced lazily by payment APIs.';
end;
$$;

commit;
