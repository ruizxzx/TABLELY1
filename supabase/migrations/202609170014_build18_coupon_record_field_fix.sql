-- Fix: checkout fails with
--   "record \"v_coupon\" is not assigned yet"          (no coupon entered)
--   "record \"v_coupon\" has no field \"id\""            (coupon entered)
--
-- Root cause: create_order_for_table_v18 (PAY_AT_COUNTER checkout) and
-- create_payment_attempt_for_table_v18 (PAY_NOW checkout) both declare:
--   v_coupon record;
-- and only assign it inside "if a coupon code was submitted then select
-- into v_coupon ...". A bare `record` variable has no fields at all until
-- something is actually selected into it, so:
--   - With no coupon code, the assignment never runs, and any later
--     reference to v_coupon.id raises "record \"v_coupon\" is not assigned
--     yet" -- this is a hard PL/pgSQL error, not a null check.
--   - With a coupon code, v_coupon is populated from
--     build18_validate_coupon(...), whose return columns are
--     (coupon_id, coupon_code, discount_type, discount_value,
--     eligible_subtotal, discount_amount) -- there is no column literally
--     named "id". Every v_coupon.id reference in these two functions was
--     simply wrong; it should be v_coupon.coupon_id throughout (which is
--     what was correctly used everywhere else in the same statements).
--
-- This bug existed in the original Build 18 migration
-- (202609170011_build18_discounts_coupons.sql) and is unrelated to the
-- Manager branch-scoping fix (202609170012) or the permission-whitelist
-- fix (202609170013) added afterward.
--
-- Not affected, and intentionally left untouched: build18_validate_coupon
-- and finalize_payment_attempt_v18 both declare v_coupon as
-- public.coupons%rowtype (a real table row, which does have a genuine
-- "id" column), so their existing v_coupon.id references are correct.
--
-- Fix: re-create both functions with every v_coupon.id reference changed
-- to v_coupon.coupon_id. No other logic changes.
-- Additive/idempotent.

drop function if exists public.create_order_for_table_v18(text,jsonb,text,text,text,text,text,text);
create function public.create_order_for_table_v18(
  p_table_code text,
  p_items jsonb,
  p_payment_method text default 'PAY_AT_COUNTER',
  p_idempotency_key text default null,
  p_customer_note text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_coupon_code text default null
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

  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,coupon_id,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot)
  values(v_table.branch_id,v_table.id,'NEW','PENDING','PAY_AT_COUNTER',v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,coalesce(v_idem,encode(extensions.gen_random_bytes(16),'hex')),encode(extensions.gen_random_bytes(16),'hex'),nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_user_phone,case when v_coupon.coupon_id is null then null else v_coupon.coupon_id end,case when v_coupon.coupon_id is null then null else v_coupon.coupon_code end,case when v_coupon.coupon_id is null then null else v_coupon.discount_type end,case when v_coupon.coupon_id is null then null else v_coupon.discount_value end)
  returning * into v_order;

  declare v_item jsonb; begin
    for v_item in select value from jsonb_array_elements(v_snapshot) loop
      insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions,selected_options,configuration_snapshot)
      values(v_order.id,(v_item->>'menu_item_id')::uuid,v_item->>'item_name_snapshot',(v_item->>'unit_price')::numeric,(v_item->>'quantity')::integer,coalesce(v_item->'selected_addons','[]'::jsonb),nullif(v_item->>'special_instructions',''),coalesce(v_item->'selected_options','[]'::jsonb),v_item);
    end loop;
  end;

  if v_coupon.coupon_id is not null then
    insert into public.coupon_usages(coupon_id,order_id,organization_id,branch_id,table_id,table_session_id,customer_phone,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot,discount_amount)
    values(v_coupon.coupon_id,v_order.id,(select organization_id from public.branches where id=v_order.branch_id),v_order.branch_id,v_order.table_id,v_order.table_session_id,v_user_phone,v_coupon.coupon_code,v_coupon.discount_type,v_coupon.discount_value,v_coupon.discount_amount);
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
    values(v_order.id,v_order.branch_id,'COUPON_APPLIED',null,jsonb_build_object('coupon_id',v_coupon.coupon_id,'coupon_code',v_coupon.coupon_code,'discount',v_coupon.discount_amount,'source','BUILD18_COUNTER'));
  end if;

  return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.subtotal,v_order.tax,v_order.additional_charges,v_order.discount,v_order.total,v_order.charge_breakdown,v_order.payment_status,v_order.status;
exception when unique_violation then
  if v_idem is not null then select * into v_existing from public.orders where branch_id=v_table.branch_id and idempotency_key=v_idem limit 1; if v_existing.id is not null then return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.subtotal,v_existing.tax,v_existing.additional_charges,v_existing.discount,v_existing.total,v_existing.charge_breakdown,v_existing.payment_status,v_existing.status; return; end if; end if;
  raise;
end;
$$;
grant execute on function public.create_order_for_table_v18(text,jsonb,text,text,text,text,text,text) to anon,authenticated;

drop function if exists public.create_payment_attempt_for_table_v18(text,jsonb,text,text,text,text,text);
create function public.create_payment_attempt_for_table_v18(
  p_table_code text,
  p_items jsonb,
  p_idempotency_key text,
  p_customer_note text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_coupon_code text default null
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

  insert into public.payment_attempts(attempt_token,branch_id,table_id,idempotency_key,items_snapshot,subtotal,tax,discount,additional_charges,total,charge_breakdown,customer_note,customer_name,customer_phone,payment_started_at,payment_expires_at,coupon_id,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot)
  values(encode(extensions.gen_random_bytes(32),'hex'),v_table.branch_id,v_table.id,v_idem,v_snapshot,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_phone,v_now,v_now+interval '1 hour',case when v_coupon.coupon_id is null then null else v_coupon.coupon_id end,case when v_coupon.coupon_id is null then null else v_coupon.coupon_code end,case when v_coupon.coupon_id is null then null else v_coupon.discount_type end,case when v_coupon.coupon_id is null then null else v_coupon.discount_value end)
  returning * into v_attempt;
  return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at;
exception when unique_violation then
  select * into v_attempt from public.payment_attempts where branch_id=v_table.branch_id and idempotency_key=v_idem and status in ('PENDING','PROCESSING') order by created_at desc limit 1;
  if v_attempt.id is not null then return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at; return; end if;
  raise;
end;
$$;
grant execute on function public.create_payment_attempt_for_table_v18(text,jsonb,text,text,text,text,text) to anon,authenticated;

select pg_notify('pgrst','reload schema');
