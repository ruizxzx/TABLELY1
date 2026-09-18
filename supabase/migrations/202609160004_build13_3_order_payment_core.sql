-- TABLELY BUILD 13.3 — ORDER & PAYMENT CORE
-- Additive, data-preserving migration for branch/date order numbering, customer
-- details, payment-failure cancellation, retries, manual cancellation and
-- counter-payment settlement. Reuses the existing Build 13.2 architecture.

begin;

-- ---------------------------------------------------------------------------
-- 1) Order data additions
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists customer_name text;
alter table public.orders add column if not exists customer_phone text;
alter table public.orders add column if not exists order_business_date date;
alter table public.orders add column if not exists retry_of_order_id uuid references public.orders(id) on delete set null;
alter table public.orders add column if not exists cancellation_reason text;
alter table public.orders add column if not exists cancelled_by uuid references auth.users(id) on delete set null;
alter table public.orders add column if not exists cancelled_at timestamptz;

create index if not exists orders_retry_of_order_idx on public.orders(retry_of_order_id) where retry_of_order_id is not null;
create index if not exists orders_branch_business_date_idx on public.orders(branch_id,order_business_date,created_at desc);

-- ---------------------------------------------------------------------------
-- 2) Branch/date order-number counters
-- ---------------------------------------------------------------------------
create table if not exists public.order_number_counters (
  branch_id uuid not null references public.branches(id) on delete cascade,
  business_date date not null,
  next_order_number bigint not null check (next_order_number >= 1),
  primary key (branch_id,business_date)
);

alter table public.order_number_counters enable row level security;
revoke all on public.order_number_counters from anon, authenticated;

update public.orders o
set order_business_date = ((o.created_at at time zone coalesce(b.timezone,'Asia/Kolkata'))::date)
from public.branches b
where b.id=o.branch_id and o.order_business_date is null;

insert into public.order_number_counters(branch_id,business_date,next_order_number)
select o.branch_id,o.order_business_date,coalesce(max(o.order_number),0)+1
from public.orders o
where o.order_business_date is not null
group by o.branch_id,o.order_business_date
on conflict (branch_id,business_date) do update
set next_order_number=greatest(public.order_number_counters.next_order_number,excluded.next_order_number);

drop index if exists public.orders_order_number_uidx;
create unique index if not exists orders_branch_business_order_number_uidx
  on public.orders(branch_id,order_business_date,order_number);

alter table public.orders alter column order_number drop default;

create or replace function public.assign_branch_order_number()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  v_date date;
  v_next bigint;
begin
  select ((now() at time zone coalesce(b.timezone,'Asia/Kolkata'))::date) into v_date
  from public.branches b where b.id=new.branch_id;
  if v_date is null then raise exception 'Order branch not found'; end if;
  new.order_business_date:=v_date;
  insert into public.order_number_counters(branch_id,business_date,next_order_number)
  values(new.branch_id,v_date,2)
  on conflict (branch_id,business_date)
  do update set next_order_number=public.order_number_counters.next_order_number+1
  returning next_order_number-1 into v_next;
  new.order_number:=v_next;
  return new;
end;
$$;

drop trigger if exists orders_assign_branch_order_number on public.orders;
create trigger orders_assign_branch_order_number
before insert on public.orders
for each row execute function public.assign_branch_order_number();

-- ---------------------------------------------------------------------------
-- 3) Recreate public order creation with customer data
-- ---------------------------------------------------------------------------
drop function if exists public.create_order_for_table(text,jsonb,text,text,text);
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
  if v_payment_method not in ('PAY_NOW','PAY_AT_COUNTER') then raise exception 'Unsupported payment method'; end if;

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

  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone)
  values(v_branch_id,v_table.id,'NEW','PENDING',v_payment_method,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,coalesce(v_idempotency,encode(extensions.gen_random_bytes(16),'hex')),encode(extensions.gen_random_bytes(16),'hex'),nullif(trim(coalesce(p_customer_note,'')),''),v_customer_name,v_customer_phone)
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

-- ---------------------------------------------------------------------------
-- 4) Stronger order completion rule
-- ---------------------------------------------------------------------------
drop function if exists public.transition_order_status(uuid,public.order_status);
create or replace function public.transition_order_status(
  p_order_id uuid,
  p_new_status public.order_status
)
returns table(
  id uuid,
  order_number bigint,
  table_id uuid,
  branch_id uuid,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  subtotal numeric,
  tax numeric,
  discount numeric,
  total numeric,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_allowed boolean := false;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select o.* into v_order
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  select s.* into v_staff
  from public.staff s
  where s.user_id = v_user
    and s.branch_id = v_order.branch_id
    and s.active = true
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  if v_staff.id is null then
    -- Organization owners are allowed to operate across every branch.
    select s.* into v_staff
    from public.staff s
    join public.branches b on b.organization_id = s.organization_id and b.id = v_order.branch_id
    where s.user_id = v_user
      and s.active = true
      and s.role = 'OWNER'
    order by s.created_at
    limit 1;
  end if;

  if v_staff.id is null then
    raise exception 'You do not have access to this order' using errcode = '42501';
  end if;

  if v_order.status = 'NEW'::public.order_status
     and p_new_status = 'ACCEPTED'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS');
  elsif v_order.status = 'ACCEPTED'::public.order_status
        and p_new_status = 'PREPARING'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen);
  elsif v_order.status = 'PREPARING'::public.order_status
        and p_new_status = 'READY'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen);
  elsif v_order.status = 'READY'::public.order_status
        and p_new_status = 'SERVED'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);
  elsif v_order.status = 'SERVED'::public.order_status
        and p_new_status = 'COMPLETED'::public.order_status then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);
  end if;

  if not v_allowed then
    raise exception 'Invalid or unauthorized order status transition: % → %', v_order.status, p_new_status using errcode = '42501';
  end if;

  if p_new_status = 'COMPLETED'::public.order_status and v_order.payment_status <> 'PAID'::public.payment_status then
    raise exception 'Payment must be marked paid before completing this order' using errcode = 'P0001';
  end if;

  update public.orders ord
  set status = p_new_status, updated_at = now()
  where ord.id = v_order.id;

  insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id)
  values (v_order.id, v_order.branch_id, 'STATUS_CHANGED', v_order.status::text, p_new_status::text, v_user);

  return query
  select ord.id, ord.order_number, ord.table_id, ord.branch_id, ord.status,
         ord.payment_status, ord.payment_method, ord.subtotal, ord.tax,
         ord.discount, ord.total, ord.created_at, ord.updated_at
  from public.orders ord
  where ord.id = v_order.id;
end;
$$;
grant execute on function public.transition_order_status(uuid,public.order_status) to authenticated;
revoke execute on function public.transition_order_status(uuid,public.order_status) from anon,public;
alter function public.transition_order_status(uuid,public.order_status) set search_path=public;

-- ---------------------------------------------------------------------------
-- 5) Manual payments + atomic completion
-- ---------------------------------------------------------------------------
drop function if exists public.mark_order_paid(uuid,text,text);
create or replace function public.mark_order_paid(
  p_order_id uuid,
  p_method text,
  p_reference text default null
)
returns table (
  id uuid,
  payment_status public.payment_status,
  payment_method text,
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_method text := upper(trim(coalesce(p_method, 'CASH')));
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select ord.* into v_order
  from public.orders ord
  where ord.id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  select st.* into v_staff
  from public.staff st
  where st.user_id = v_user
    and st.active = true
    and (st.branch_id = v_order.branch_id or st.role = 'OWNER')
    and exists (
      select 1 from public.branches b
      where b.id = v_order.branch_id
        and b.organization_id = st.organization_id
    )
  order by case when st.role = 'OWNER' then 0 when st.role = 'MANAGER' then 1 else 2 end
  limit 1;

  if v_staff.id is null or not public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS') then
    raise exception 'You are not authorized to mark payments' using errcode = '42501';
  end if;

  if v_method not in ('CASH', 'UPI', 'CARD') then
    raise exception 'Unsupported manual payment method';
  end if;

  if v_order.status = 'CANCELLED'::public.order_status then
    raise exception 'Cancelled orders cannot be marked paid' using errcode = 'P0001';
  end if;

  if v_order.status = 'COMPLETED'::public.order_status then
    raise exception 'Completed orders cannot be marked paid again' using errcode = 'P0001';
  end if;

  if v_order.payment_status = 'PAID'::public.payment_status then
    raise exception 'Order is already paid' using errcode = 'P0001';
  end if;

  if v_order.payment_method = 'PAY_NOW' or left(coalesce(v_order.payment_method,''),8) = 'PAY_NOW:' then
    raise exception 'Online orders must be settled by the online payment flow' using errcode='P0001';
  end if;

  if v_order.payment_status <> 'PAID' then
    update public.orders ord
    set payment_status = 'PAID',
        payment_method = v_method,
        paid_at = coalesce(ord.paid_at, now()),
        updated_at = now()
    where ord.id = p_order_id;

    insert into public.payment_transactions
      (order_id, branch_id, provider, amount, status, method, raw_metadata)
    values
      (
        v_order.id,
        v_order.branch_id,
        'MANUAL',
        v_order.total,
        'PAID',
        v_method,
        jsonb_build_object(
          'reference', nullif(left(trim(coalesce(p_reference, '')), 120), ''),
          'actor_user_id', v_user::text
        )
      );

    insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
    values (v_order.id, v_order.branch_id, 'PAYMENT_MARKED_PAID', v_user, jsonb_build_object('method', v_method));
  end if;

  return query
  select ord.id, ord.payment_status, ord.payment_method, ord.paid_at
  from public.orders ord
  where ord.id = p_order_id;
end;
$$;
grant execute on function public.mark_order_paid(uuid,text,text) to authenticated;
revoke execute on function public.mark_order_paid(uuid,text,text) from anon,public;
alter function public.mark_order_paid(uuid,text,text) set search_path=public;

create or replace function public.complete_order_with_manual_payment(
  p_order_id uuid, p_method text, p_reference text default null
)
returns table(id uuid,order_number bigint,table_id uuid,branch_id uuid,status public.order_status,payment_status public.payment_status,payment_method text,paid_at timestamptz,total numeric)
language plpgsql security definer set search_path=public as $$
declare
  v_order public.orders%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid();
  v_method text:=upper(trim(coalesce(p_method,'')));
  v_allowed boolean:=false;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select ord.* into v_order from public.orders ord where ord.id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found' using errcode='P0002'; end if;
  select st.* into v_staff from public.staff st
  where st.user_id=v_user and st.active=true and (st.branch_id=v_order.branch_id or st.role='OWNER')
    and exists(select 1 from public.branches b where b.id=v_order.branch_id and b.organization_id=st.organization_id)
  order by case when st.role='OWNER' then 0 when st.role='MANAGER' then 1 else 2 end,st.created_at limit 1;
  v_allowed:=v_staff.id is not null and public.current_user_has_permission_for_branch(v_order.branch_id,'EDIT_ORDERS')
    and public.current_user_has_permission_for_branch(v_order.branch_id,'PAYMENTS')
    and v_staff.role in ('OWNER','MANAGER','WAITER');
  if not v_allowed then raise exception 'You are not authorized to complete this order' using errcode='42501'; end if;
  if v_order.status<>'SERVED'::public.order_status then raise exception 'Only served orders can be completed' using errcode='P0001'; end if;
  if v_order.payment_status='PAID'::public.payment_status then raise exception 'Order is already paid; use normal completion' using errcode='P0001'; end if;
  if v_order.payment_method not in ('PAY_AT_COUNTER','CASH','UPI') and v_order.payment_method is not null then raise exception 'This order is not a counter-payment order' using errcode='P0001'; end if;
  if v_method not in ('CASH','UPI') then raise exception 'Unsupported counter payment method' using errcode='P0001'; end if;
  update public.orders ord set payment_status='PAID',payment_method=v_method,paid_at=coalesce(ord.paid_at,now()),status='COMPLETED',updated_at=now() where ord.id=v_order.id;
  insert into public.payment_transactions(order_id,branch_id,provider,amount,status,method,raw_metadata)
  values(v_order.id,v_order.branch_id,'MANUAL',v_order.total,'PAID',v_method,jsonb_build_object('reference',nullif(left(trim(coalesce(p_reference,'')),120),''),'actor_user_id',v_user::text,'completion','ORDER_PAGE'));
  insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'PAYMENT_MARKED_PAID_AND_ORDER_COMPLETED',v_order.status::text,'COMPLETED',v_user,jsonb_build_object('method',v_method));
  return query select ord.id,ord.order_number,ord.table_id,ord.branch_id,ord.status,ord.payment_status,ord.payment_method,ord.paid_at,ord.total from public.orders ord where ord.id=v_order.id;
end;
$$;
grant execute on function public.complete_order_with_manual_payment(uuid,text,text) to authenticated;
revoke execute on function public.complete_order_with_manual_payment(uuid,text,text) from anon,public;

-- ---------------------------------------------------------------------------
-- 6) Manual cancellation
-- ---------------------------------------------------------------------------
create or replace function public.cancel_order(p_order_id uuid,p_reason text default 'OTHER')
returns table(id uuid,order_number bigint,table_id uuid,branch_id uuid,status public.order_status,payment_status public.payment_status,payment_method text,cancellation_reason text,cancelled_by uuid,cancelled_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare
  v_order public.orders%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid(); v_reason text:=nullif(left(trim(coalesce(p_reason,'OTHER')),120),'');
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select ord.* into v_order from public.orders ord where ord.id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found' using errcode='P0002'; end if;
  select st.* into v_staff from public.staff st where st.user_id=v_user and st.active=true and (st.branch_id=v_order.branch_id or st.role='OWNER')
    and exists(select 1 from public.branches b where b.id=v_order.branch_id and b.organization_id=st.organization_id)
  order by case when st.role='OWNER' then 0 when st.role='MANAGER' then 1 else 2 end,st.created_at limit 1;
  if v_staff.id is null or not public.current_user_has_permission_for_branch(v_order.branch_id,'CANCEL_ORDERS') then raise exception 'You do not have permission to cancel this order' using errcode='42501'; end if;
  if v_order.status in ('CANCELLED','COMPLETED','SERVED') then raise exception 'This order cannot be cancelled in its current state' using errcode='P0001'; end if;
  if v_order.payment_status='PAID' then raise exception 'Paid orders require refund handling before cancellation' using errcode='P0001'; end if;
  if (v_order.payment_method = 'PAY_NOW' or left(coalesce(v_order.payment_method,''),8) = 'PAY_NOW:') and v_order.payment_status = 'PENDING' then
    raise exception 'Online payment is still pending; cancellation is not available for this payment state' using errcode='P0001';
  end if;
  update public.orders ord set status='CANCELLED',cancellation_reason=coalesce(v_reason,'OTHER'),cancelled_by=v_user,cancelled_at=now(),updated_at=now() where ord.id=v_order.id;
  insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'MANUAL_CANCELLATION',v_order.status::text,'CANCELLED',v_user,jsonb_build_object('reason',coalesce(v_reason,'OTHER')));
  return query select ord.id,ord.order_number,ord.table_id,ord.branch_id,ord.status,ord.payment_status,ord.payment_method,ord.cancellation_reason,ord.cancelled_by,ord.cancelled_at from public.orders ord where ord.id=v_order.id;
end;
$$;
grant execute on function public.cancel_order(uuid,text) to authenticated;
revoke execute on function public.cancel_order(uuid,text) from anon,public;

-- ---------------------------------------------------------------------------
-- 7) Retry / pay-at-counter fallback
-- ---------------------------------------------------------------------------
create or replace function public.retry_order_after_payment_failure(p_order_id uuid,p_tracking_token text,p_payment_method text)
returns table(order_id uuid,order_number bigint,tracking_token text,total numeric,payment_status public.payment_status,status public.order_status,payment_method text)
language plpgsql security definer set search_path=public as $$
declare
  v_old public.orders%rowtype; v_new_id uuid; v_new_token text; v_method text:=upper(trim(coalesce(p_payment_method,'')));
begin
  if v_method not in ('PAY_NOW','PAY_AT_COUNTER') then raise exception 'Unsupported payment method'; end if;
  select o.* into v_old from public.orders o where o.id=p_order_id and o.tracking_token=trim(p_tracking_token) for update;
  if v_old.id is null then raise exception 'Order not found'; end if;
  if v_old.status<>'CANCELLED'::public.order_status or v_old.payment_status<>'FAILED'::public.payment_status or coalesce(v_old.payment_method,'')<>'PAY_NOW' and left(coalesce(v_old.payment_method,''),8)<>'PAY_NOW:' then raise exception 'This order is not eligible for payment retry'; end if;
  if v_method='PAY_NOW' then
    if not (select public.organization_has_feature(b.organization_id,'ONLINE_PAYMENTS') from public.branches b where b.id=v_old.branch_id) then raise exception 'Online payments are not available for this branch'; end if;
    if not coalesce((select rbps.enabled from public.restaurant_branch_payment_settings rbps where rbps.branch_id=v_old.branch_id),(select rps.enabled from public.restaurant_payment_settings rps join public.branches b2 on b2.organization_id=rps.organization_id where b2.id=v_old.branch_id),false) then raise exception 'Online payments are not enabled for this branch'; end if;
  end if;
  v_new_token:=encode(extensions.gen_random_bytes(16),'hex');
  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,retry_of_order_id)
  values(v_old.branch_id,v_old.table_id,'NEW','PENDING',v_method,v_old.subtotal,v_old.tax,v_old.discount,v_old.additional_charges,v_old.total,v_old.charge_breakdown,encode(extensions.gen_random_bytes(16),'hex'),v_new_token,v_old.customer_note,v_old.customer_name,v_old.customer_phone,v_old.id) returning id into v_new_id;
  insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions) select v_new_id,oi.menu_item_id,oi.item_name_snapshot,oi.unit_price,oi.quantity,oi.selected_addons,oi.special_instructions from public.order_items oi where oi.order_id=v_old.id order by oi.id;
  return query select n.id,n.order_number,n.tracking_token,n.total,n.payment_status,n.status,n.payment_method from public.orders n where n.id=v_new_id;
end;
$$;
revoke execute on function public.retry_order_after_payment_failure(uuid,text,text) from public;
grant execute on function public.retry_order_after_payment_failure(uuid,text,text) to anon,authenticated;
alter function public.retry_order_after_payment_failure(uuid,text,text) set search_path=public;

-- ---------------------------------------------------------------------------
-- 8) Payment failure handling
-- ---------------------------------------------------------------------------
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
  on conflict (provider_order_id) do update set status='FAILED',provider_payment_id=coalesce(excluded.provider_payment_id,payment_transactions.provider_payment_id),failure_reason=excluded.failure_reason,raw_metadata=excluded.raw_metadata,updated_at=now();
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
  on conflict (provider_order_id) do update set status='FAILED',provider_payment_id=coalesce(excluded.provider_payment_id,payment_transactions.provider_payment_id),failure_reason=excluded.failure_reason,raw_metadata=excluded.raw_metadata,updated_at=now();
  update public.orders ord set payment_status='FAILED',status='CANCELLED',cancellation_reason='ONLINE_PAYMENT_FAILED',cancelled_by=null,cancelled_at=coalesce(ord.cancelled_at,now()),updated_at=now() where ord.id=v_order.id and ord.payment_status='PENDING' and ord.status<>'CANCELLED';
  return true;
end;
$$;
revoke all on function public.record_online_payment_failure_by_provider(text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_online_payment_failure_by_provider(text,text,text,jsonb) to service_role;
alter function public.record_online_payment_failure_by_provider(text,text,text,jsonb) set search_path=public;

commit;
notify pgrst,'reload schema';
