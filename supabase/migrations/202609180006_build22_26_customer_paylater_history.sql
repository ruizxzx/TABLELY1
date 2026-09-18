-- TABLELY REMAINING ARCHITECTURE — BUILDS 22 THROUGH 26
--
-- Additive customer identity, authenticated Pay-Later sessions, settlement,
-- customer history, restaurant relationships, and shared-tab membership.
-- Existing anonymous, counter, and online-payment RPCs remain unchanged.

begin;

-- ============================================================
-- BUILD 22 — customer identity
-- ============================================================
create table if not exists public.customer_profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  name text,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.build22_sync_customer_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.customer_profiles(auth_user_id, name, email, phone)
  values (
    new.id,
    nullif(left(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), 120), ''),
    new.email,
    nullif(left(trim(coalesce(new.raw_user_meta_data->>'phone', '')), 40), '')
  )
  on conflict (auth_user_id) do update
  set name = coalesce(excluded.name, customer_profiles.name),
      email = coalesce(excluded.email, customer_profiles.email),
      phone = coalesce(excluded.phone, customer_profiles.phone),
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists build22_customer_profile_on_auth_user on auth.users;
create trigger build22_customer_profile_on_auth_user
after insert or update of email, raw_user_meta_data on auth.users
for each row execute function public.build22_sync_customer_profile();

alter table public.orders
  add column if not exists customer_profile_id uuid references public.customer_profiles(id) on delete set null;

alter table public.table_sessions
  add column if not exists owner_customer_id uuid references public.customer_profiles(id) on delete set null,
  add column if not exists is_pay_later boolean not null default false,
  add column if not exists join_code_hash text;

create index if not exists orders_customer_profile_idx
  on public.orders(customer_profile_id, created_at desc);
create index if not exists table_sessions_owner_customer_idx
  on public.table_sessions(owner_customer_id, status, opened_at desc);
create unique index if not exists table_sessions_join_code_hash_uidx
  on public.table_sessions(join_code_hash)
  where join_code_hash is not null and status in ('ACTIVE','SETTLING');

alter table public.customer_profiles enable row level security;
revoke all on public.customer_profiles from anon, public;
grant select, update on public.customer_profiles to authenticated;
drop policy if exists build22_customer_profile_own on public.customer_profiles;
create policy build22_customer_profile_own on public.customer_profiles
for all to authenticated
using (auth_user_id = auth.uid())
with check (auth_user_id = auth.uid());

create or replace function public.build22_current_customer_profile()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if auth.uid() is null then
    return null;
  end if;
  insert into public.customer_profiles(auth_user_id, email)
  select auth.uid(), email from auth.users where id = auth.uid()
  on conflict (auth_user_id) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.customer_profiles where auth_user_id = auth.uid();
  end if;
  return v_id;
end;
$$;
revoke execute on function public.build22_current_customer_profile() from anon, public;
grant execute on function public.build22_current_customer_profile() to authenticated;

create or replace function public.update_customer_profile(p_name text, p_phone text)
returns public.customer_profiles
language plpgsql
security definer
set search_path = public
as $$
declare v_profile public.customer_profiles%rowtype;
begin
  select * into v_profile from public.customer_profiles
  where auth_user_id = auth.uid() for update;
  if v_profile.id is null then
    raise exception 'Customer profile not found' using errcode = '42501';
  end if;
  update public.customer_profiles
  set name = nullif(left(trim(coalesce(p_name, '')), 120), ''),
      phone = nullif(left(trim(coalesce(p_phone, '')), 40), ''),
      updated_at = now()
  where id = v_profile.id
  returning * into v_profile;
  return v_profile;
end;
$$;
revoke execute on function public.update_customer_profile(text, text) from anon, public;
grant execute on function public.update_customer_profile(text, text) to authenticated;

-- ============================================================
-- BUILD 23 — Pay-Later session/order model
-- ============================================================
create or replace function public.build23_effective_pay_later_enabled(p_branch_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select rbps.pay_later_enabled from public.restaurant_branch_payment_settings rbps where rbps.branch_id = p_branch_id),
    (select rps.pay_later_enabled from public.restaurant_payment_settings rps
     join public.branches b on b.organization_id = rps.organization_id where b.id = p_branch_id),
    false
  );
$$;
revoke execute on function public.build23_effective_pay_later_enabled(uuid) from anon, authenticated, public;

create or replace function public.build21_assert_counter_enabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_method = 'PAY_LATER' then
    if auth.uid() is null
       or not exists(select 1 from public.customer_profiles cp where cp.auth_user_id = auth.uid())
       or not public.build23_effective_pay_later_enabled(new.branch_id) then
      raise exception 'PAY_LATER_NOT_AVAILABLE' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.payment_method = 'PAY_AT_COUNTER'
     and not public.build21_effective_counter_enabled(new.branch_id) then
    raise exception 'Pay at counter is not enabled for this branch' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.get_public_ordering_options(p_table_code text)
returns table(pay_at_counter_enabled boolean, pay_later_enabled boolean, online_payment_enabled boolean, pay_later_available boolean, plan_id text)
language sql security definer stable set search_path = public
as $$
  select
    coalesce(rbps.pay_at_counter_enabled, rps.pay_at_counter_enabled, true),
    coalesce(rbps.pay_later_enabled, rps.pay_later_enabled, false),
    public.organization_has_feature(o.id, 'ONLINE_PAYMENTS') and coalesce(rbps.enabled, rps.enabled, false),
    public.build23_effective_pay_later_enabled(b.id),
    os.plan_id
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  left join public.organization_subscriptions os on os.organization_id = o.id
  left join public.restaurant_branch_payment_settings rbps on rbps.branch_id = b.id
  left join public.restaurant_payment_settings rps on rps.organization_id = o.id
  where t.table_code = trim(p_table_code) and t.active = true and o.status = 'ACTIVE'::public.account_status
  limit 1;
$$;
revoke execute on function public.get_public_ordering_options(text) from public;
grant execute on function public.get_public_ordering_options(text) to anon, authenticated;

create or replace function public.open_pay_later_session(
  p_table_code text,
  p_session_token text default null,
  p_device_token text default null
)
returns public.table_sessions
language plpgsql security definer set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_profile uuid := public.build22_current_customer_profile();
  v_session public.table_sessions%rowtype;
  v_token_hash text := public.build19_hash_token(p_session_token);
  v_device_hash text := public.build19_hash_token(p_device_token);
begin
  if v_profile is null then raise exception 'Customer authentication is required' using errcode = '42501'; end if;
  select t.* into v_table from public.tables t join public.organizations o on o.id = (select organization_id from public.branches where id=t.branch_id)
  where t.table_code = trim(p_table_code) and t.active and o.status='ACTIVE'::public.account_status;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if not public.build23_effective_pay_later_enabled(v_table.branch_id) then
    raise exception 'Pay After Delivery is not enabled for this branch' using errcode='42501';
  end if;

  select * into v_session from public.table_sessions
  where table_id = v_table.id and owner_customer_id = v_profile
    and is_pay_later and status in ('ACTIVE','SETTLING')
  order by opened_at desc limit 1 for update;
  if v_session.id is not null then
    update public.table_sessions set last_seen_at=now(), updated_at=now()
    where id=v_session.id returning * into v_session;
    return v_session;
  end if;

  insert into public.table_sessions(
    branch_id, table_id, status, session_token_hash, device_token_hash,
    origin, owner_customer_id, is_pay_later, last_seen_at
  )
  values(v_table.branch_id, v_table.id, 'ACTIVE', v_token_hash, v_device_hash,
         'CUSTOMER_SCAN', v_profile, true, now())
  returning * into v_session;
  return v_session;
exception when unique_violation then
  select * into v_session from public.table_sessions
  where table_id=v_table.id and owner_customer_id=v_profile and is_pay_later
    and status in ('ACTIVE','SETTLING')
  order by opened_at desc limit 1;
  if v_session.id is null then raise; end if;
  return v_session;
end;
$$;
revoke execute on function public.open_pay_later_session(text,text,text) from anon, public;
grant execute on function public.open_pay_later_session(text,text,text) to authenticated;

create or replace function public.create_pay_later_order_for_table(
  p_table_code text,
  p_items jsonb,
  p_session_id uuid,
  p_idempotency_key text,
  p_customer_note text default null,
  p_coupon_code text default null
)
returns table(order_id uuid, order_number bigint, tracking_token text, total numeric, payment_status public.payment_status, status public.order_status, table_session_id uuid)
language plpgsql security definer set search_path = public
as $$
declare
  v_profile uuid := public.build22_current_customer_profile();
  v_session public.table_sessions%rowtype;
  v_table public.tables%rowtype;
  v_existing public.orders%rowtype;
  v_snapshot jsonb;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2) := 0;
  v_tax numeric(12,2) := 0;
  v_additional numeric(12,2) := 0;
  v_total numeric(12,2);
  v_charge record;
  v_amt numeric(12,2);
  v_order public.orders%rowtype;
  v_item jsonb;
  v_coupon record;
begin
  if v_profile is null then raise exception 'Customer authentication is required' using errcode='42501'; end if;
  select * into v_session from public.table_sessions where id=p_session_id for update;
  if v_session.id is null or not v_session.is_pay_later or v_session.status not in ('ACTIVE','SETTLING')
     or (v_session.owner_customer_id<>v_profile and not exists(
       select 1 from public.table_session_members m
       where m.session_id=v_session.id and m.customer_profile_id=v_profile
     )) then
    raise exception 'Invalid Pay-Later session' using errcode='42501';
  end if;
  select * into v_table from public.tables where id=v_session.table_id and table_code=trim(p_table_code) and active;
  if v_table.id is null then raise exception 'Invalid table context'; end if;
  if not public.build23_effective_pay_later_enabled(v_session.branch_id) then raise exception 'Pay After Delivery is not enabled'; end if;
  select * into v_existing from public.orders where branch_id=v_session.branch_id and idempotency_key=p_idempotency_key limit 1;
  if v_existing.id is not null then return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.total,v_existing.payment_status,v_existing.status,v_existing.table_session_id; return; end if;
  v_snapshot := public.build16_calculate_cart(v_session.branch_id, p_items);
  v_subtotal := round(coalesce((select sum((x->>'line_total')::numeric) from jsonb_array_elements(v_snapshot) x),0),2);
  if v_subtotal <= 0 then raise exception 'Cart is empty'; end if;
  if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
    select * into v_coupon from public.build18_validate_coupon(v_session.branch_id,v_subtotal,v_snapshot,p_coupon_code,null,true);
    v_discount := coalesce(v_coupon.discount_amount,0);
  end if;
  for v_charge in select c.name,c.charge_type,c.calculation_type,c.value from public.restaurant_charge_settings c
    where c.enabled and (c.branch_id=v_session.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_session.branch_id)))
    order by c.sort_order,c.created_at loop
    if v_charge.calculation_type='PERCENT' then v_amt:=round((v_subtotal-v_discount)*v_charge.value/100,2); else v_amt:=round(v_charge.value,2); end if;
    if v_charge.charge_type='TAX' then v_tax:=v_tax+greatest(v_amt,0); else v_additional:=v_additional+greatest(v_amt,0); end if;
  end loop;
  v_total:=round(v_subtotal-v_discount+v_tax+v_additional,2);
  insert into public.orders(branch_id,table_id,table_session_id,customer_profile_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_name,customer_phone,customer_note)
  values(v_session.branch_id,v_session.table_id,v_session.id,v_profile,'NEW','PENDING','PAY_LATER',v_subtotal,v_tax,v_discount,v_additional,v_total,'[]'::jsonb,p_idempotency_key,encode(extensions.gen_random_bytes(16),'hex'),(select name from public.customer_profiles where id=v_profile),(select phone from public.customer_profiles where id=v_profile),nullif(trim(coalesce(p_customer_note,'')),''))
  returning * into v_order;
  for v_item in select value from jsonb_array_elements(v_snapshot) loop
    insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions,selected_options,configuration_snapshot)
    values(v_order.id,(v_item->>'menu_item_id')::uuid,v_item->>'item_name_snapshot',(v_item->>'unit_price')::numeric,(v_item->>'quantity')::integer,coalesce(v_item->'selected_addons','[]'::jsonb),nullif(v_item->>'special_instructions',''),coalesce(v_item->'selected_options','[]'::jsonb),v_item);
  end loop;
  return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.total,v_order.payment_status,v_order.status,v_order.table_session_id;
exception when unique_violation then
  select * into v_existing from public.orders where branch_id=v_session.branch_id and idempotency_key=p_idempotency_key limit 1;
  if v_existing.id is null then raise; end if;
  return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.total,v_existing.payment_status,v_existing.status,v_existing.table_session_id;
end;
$$;
revoke execute on function public.create_pay_later_order_for_table(text,jsonb,uuid,text,text,text) from anon, public;
grant execute on function public.create_pay_later_order_for_table(text,jsonb,uuid,text,text,text) to authenticated;

-- ============================================================
-- BUILD 23.1 — settlement
-- ============================================================
create or replace function public.settle_pay_later_session(p_session_id uuid, p_method text)
returns table(session_id uuid, outstanding numeric, status text)
language plpgsql security definer set search_path=public
as $$
declare
  v_profile uuid := public.build22_current_customer_profile();
  v_session public.table_sessions%rowtype;
  v_total numeric(12,2);
  v_order public.orders%rowtype;
  v_method text := upper(trim(coalesce(p_method,'')));
begin
  if v_profile is null or v_method not in ('CASH','UPI') then raise exception 'Authenticated customer and CASH or UPI are required' using errcode='42501'; end if;
  select * into v_session from public.table_sessions where id=p_session_id and is_pay_later and owner_customer_id=v_profile for update;
  if v_session.id is null then raise exception 'Pay-Later session not found' using errcode='42501'; end if;
  select coalesce(sum(total),0) into v_total from public.orders where table_session_id=v_session.id and payment_status='PENDING' and status<>'CANCELLED';
  if v_total <= 0 then raise exception 'No outstanding balance'; end if;
  for v_order in select * from public.orders where table_session_id=v_session.id and payment_status='PENDING' and status<>'CANCELLED' for update loop
    update public.orders set payment_status='PAID', payment_method=v_method, paid_at=coalesce(paid_at,now()), updated_at=now() where id=v_order.id;
    insert into public.payment_transactions(order_id,branch_id,amount,status,method,raw_metadata)
    values(v_order.id,v_order.branch_id,v_order.total,'SUCCEEDED',v_method,jsonb_build_object('source','PAY_LATER_SETTLEMENT','session_id',v_session.id));
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
    values(v_order.id,v_order.branch_id,'PAY_LATER_SETTLED',auth.uid(),jsonb_build_object('method',v_method,'session_id',v_session.id));
  end loop;
  if not exists(select 1 from public.orders where table_session_id=v_session.id and status not in ('COMPLETED','CANCELLED')) then
    update public.table_sessions set status='CLOSED',closed_at=now(),updated_at=now() where id=v_session.id;
  end if;
  return query select v_session.id,v_total,(select status from public.table_sessions where id=v_session.id);
end;
$$;
revoke execute on function public.settle_pay_later_session(uuid,text) from anon, public;
grant execute on function public.settle_pay_later_session(uuid,text) to authenticated;

-- ============================================================
-- BUILD 24 — customer history
-- ============================================================
create or replace function public.get_my_customer_history()
returns table(order_id uuid, order_number bigint, restaurant_name text, created_at timestamptz, total numeric, status public.order_status)
language sql security definer stable set search_path=public
as $$
  select o.id,o.order_number,org.name,o.created_at,o.total,o.status
  from public.orders o
  join public.branches b on b.id=o.branch_id
  join public.organizations org on org.id=b.organization_id
  join public.customer_profiles cp on cp.id=o.customer_profile_id
  where cp.auth_user_id=auth.uid()
  order by o.created_at desc;
$$;
revoke execute on function public.get_my_customer_history() from anon, public;
grant execute on function public.get_my_customer_history() to authenticated;

create or replace function public.get_my_active_pay_later_sessions()
returns table(session_id uuid, table_id uuid, table_number integer, restaurant_name text, outstanding numeric, status text)
language sql security definer stable set search_path=public
as $$
  select s.id,s.table_id,t.table_number,o.name,
    coalesce((select sum(ord.total) from public.orders ord where ord.table_session_id=s.id and ord.payment_status='PENDING' and ord.status<>'CANCELLED'),0),
    s.status
  from public.table_sessions s
  join public.tables t on t.id=s.table_id
  join public.branches b on b.id=s.branch_id
  join public.organizations o on o.id=b.organization_id
  join public.customer_profiles cp on cp.id=s.owner_customer_id
  where cp.auth_user_id=auth.uid() and s.is_pay_later and s.status in ('ACTIVE','SETTLING')
  order by s.opened_at desc;
$$;
revoke execute on function public.get_my_active_pay_later_sessions() from anon, public;
grant execute on function public.get_my_active_pay_later_sessions() to authenticated;

-- ============================================================
-- BUILD 25 — organization-scoped relationship/history
-- ============================================================
create table if not exists public.restaurant_customer_relationships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  customer_profile_id uuid not null references public.customer_profiles(id) on delete cascade,
  first_order_at timestamptz not null default now(),
  last_order_at timestamptz not null default now(),
  total_orders integer not null default 0,
  total_spend numeric(12,2) not null default 0,
  primary key(organization_id, customer_profile_id)
);
create or replace function public.build25_sync_customer_relationship()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_org uuid;
begin
  if new.customer_profile_id is null then return new; end if;
  select organization_id into v_org from public.branches where id=new.branch_id;
  insert into public.restaurant_customer_relationships(organization_id,customer_profile_id,total_orders,total_spend)
  values(v_org,new.customer_profile_id,1,new.total)
  on conflict (organization_id,customer_profile_id) do update
  set last_order_at=now(), total_orders=restaurant_customer_relationships.total_orders+1,
      total_spend=restaurant_customer_relationships.total_spend+excluded.total;
  return new;
end;
$$;
drop trigger if exists build25_customer_relationship_on_order on public.orders;
create trigger build25_customer_relationship_on_order
after insert on public.orders for each row execute function public.build25_sync_customer_relationship();
alter table public.restaurant_customer_relationships enable row level security;
revoke all on public.restaurant_customer_relationships from anon, public;
grant select on public.restaurant_customer_relationships to authenticated;
drop policy if exists build25_staff_relationships on public.restaurant_customer_relationships;
create policy build25_staff_relationships on public.restaurant_customer_relationships
for select to authenticated using (public.is_org_member(organization_id));

create or replace function public.get_branch_customer_history(p_branch_id uuid)
returns table(customer_profile_id uuid, name text, email text, phone text, total_orders bigint, total_spend numeric, last_order_at timestamptz)
language sql security definer stable set search_path=public
as $$
  select cp.id,cp.name,cp.email,cp.phone,count(o.id),coalesce(sum(o.total),0),max(o.created_at)
  from public.orders o
  join public.customer_profiles cp on cp.id=o.customer_profile_id
  join public.branches b on b.id=o.branch_id
  where o.branch_id=p_branch_id and public.current_user_has_permission_for_branch(p_branch_id,'EDIT_ORDERS')
  group by cp.id,cp.name,cp.email,cp.phone order by max(o.created_at) desc;
$$;
revoke execute on function public.get_branch_customer_history(uuid) from anon, public;
grant execute on function public.get_branch_customer_history(uuid) to authenticated;

-- ============================================================
-- BUILD 26 — shared tabs
-- ============================================================
create table if not exists public.table_session_members (
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  customer_profile_id uuid not null references public.customer_profiles(id) on delete cascade,
  role text not null check(role in ('OWNER','MEMBER')),
  joined_at timestamptz not null default now(),
  primary key(session_id,customer_profile_id)
);
alter table public.table_session_members enable row level security;
revoke all on public.table_session_members from anon, public;
grant select on public.table_session_members to authenticated;
drop policy if exists build26_member_self_or_shared on public.table_session_members;
create policy build26_member_self_or_shared on public.table_session_members
for select to authenticated using (
  customer_profile_id = public.build22_current_customer_profile()
  or exists(select 1 from public.table_session_members m where m.session_id=table_session_members.session_id and m.customer_profile_id=public.build22_current_customer_profile())
);

create or replace function public.create_shared_pay_later_tab(p_table_code text, p_session_token text default null, p_device_token text default null)
returns table(session public.table_sessions, join_code text)
language plpgsql security definer set search_path=public
as $$
declare v_session public.table_sessions%rowtype; v_profile uuid:=public.build22_current_customer_profile(); v_code text;
begin
  v_session:=public.open_pay_later_session(p_table_code,p_session_token,p_device_token);
  insert into public.table_session_members(session_id,customer_profile_id,role) values(v_session.id,v_profile,'OWNER')
  on conflict (session_id,customer_profile_id) do nothing;
  if v_session.join_code_hash is null then
    v_code := upper(substr(encode(extensions.gen_random_bytes(6),'hex'),1,10));
    update public.table_sessions set join_code_hash=public.build19_hash_token(v_code) where id=v_session.id returning * into v_session;
  end if;
  return query select v_session, v_code;
end;
$$;
revoke execute on function public.create_shared_pay_later_tab(text,text,text) from anon, public;
grant execute on function public.create_shared_pay_later_tab(text,text,text) to authenticated;

create or replace function public.join_shared_pay_later_tab(p_join_code text)
returns public.table_sessions
language plpgsql security definer set search_path=public
as $$
declare v_profile uuid:=public.build22_current_customer_profile(); v_session public.table_sessions%rowtype;
begin
  if v_profile is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into v_session from public.table_sessions where join_code_hash=public.build19_hash_token(trim(p_join_code)) and is_pay_later and status in ('ACTIVE','SETTLING') for update;
  if v_session.id is null then raise exception 'Invalid or expired join code'; end if;
  insert into public.table_session_members(session_id,customer_profile_id,role) values(v_session.id,v_profile,'MEMBER')
  on conflict (session_id,customer_profile_id) do nothing;
  return v_session;
end;
$$;
revoke execute on function public.join_shared_pay_later_tab(text) from anon, public;
grant execute on function public.join_shared_pay_later_tab(text) to authenticated;

commit;
notify pgrst, 'reload schema';
