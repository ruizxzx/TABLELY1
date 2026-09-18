-- TABLELY: restaurant-configurable checkout charges (GST/platform/custom) + authoritative totals.
-- Additive migration. Charges are calculated independently against the discounted subtotal (discount is currently 0 in V1); no charge is compounded on another charge.

create table if not exists public.restaurant_charge_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  charge_type text not null default 'FEE' check (charge_type in ('TAX','FEE')),
  calculation_type text not null default 'PERCENT' check (calculation_type in ('PERCENT','FIXED')),
  value numeric(12,2) not null default 0 check (value >= 0 and value <= 1000000),
  enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists restaurant_charge_settings_org_idx on public.restaurant_charge_settings(organization_id, sort_order, created_at);

alter table public.restaurant_charge_settings enable row level security;
revoke all on public.restaurant_charge_settings from anon, authenticated;
drop policy if exists restaurant_charge_settings_owner_select on public.restaurant_charge_settings;
create policy restaurant_charge_settings_owner_select on public.restaurant_charge_settings for select to authenticated using (public.is_org_member(organization_id));
grant select on public.restaurant_charge_settings to authenticated;

drop trigger if exists restaurant_charge_settings_touch_updated_at on public.restaurant_charge_settings;
create trigger restaurant_charge_settings_touch_updated_at before update on public.restaurant_charge_settings for each row execute function public.touch_updated_at();

create or replace function public.list_restaurant_charge_settings()
returns table(id uuid,name text,charge_type text,calculation_type text,value numeric,enabled boolean,sort_order integer,updated_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare v_org uuid;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true and s.role in ('OWNER','MANAGER') order by s.created_at limit 1;
  if v_org is null then raise exception 'Restaurant manager access required' using errcode='42501'; end if;
  return query select c.id,c.name,c.charge_type,c.calculation_type,c.value,c.enabled,c.sort_order,c.updated_at
  from public.restaurant_charge_settings c where c.organization_id=v_org order by c.sort_order,c.created_at;
end;$$;
grant execute on function public.list_restaurant_charge_settings() to authenticated;

create or replace function public.upsert_restaurant_charge_setting(
  p_id uuid default null,
  p_name text default null,
  p_charge_type text default 'FEE',
  p_calculation_type text default 'PERCENT',
  p_value numeric default 0,
  p_enabled boolean default true,
  p_sort_order integer default 0
)
returns public.restaurant_charge_settings
language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_row public.restaurant_charge_settings%rowtype; v_id uuid:=p_id;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode='42501'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Charge name is required'; end if;
  if upper(trim(coalesce(p_charge_type,''))) not in ('TAX','FEE') then raise exception 'Invalid charge type'; end if;
  if upper(trim(coalesce(p_calculation_type,''))) not in ('PERCENT','FIXED') then raise exception 'Invalid calculation type'; end if;
  if p_value is null or p_value < 0 or p_value > 1000000 then raise exception 'Charge value is invalid'; end if;
  if p_sort_order < 0 or p_sort_order > 1000 then raise exception 'Sort order is invalid'; end if;
  if v_id is not null then
    update public.restaurant_charge_settings set name=left(trim(p_name),80),charge_type=upper(trim(p_charge_type)),calculation_type=upper(trim(p_calculation_type)),value=round(p_value,2),enabled=coalesce(p_enabled,true),sort_order=p_sort_order,updated_at=now()
    where id=v_id and organization_id=v_org returning * into v_row;
    if v_row.id is null then raise exception 'Charge not found'; end if;
  else
    insert into public.restaurant_charge_settings(organization_id,name,charge_type,calculation_type,value,enabled,sort_order)
    values(v_org,left(trim(p_name),80),upper(trim(p_charge_type)),upper(trim(p_calculation_type)),round(p_value,2),coalesce(p_enabled,true),p_sort_order)
    returning * into v_row;
  end if;
  return v_row;
end;$$;
grant execute on function public.upsert_restaurant_charge_setting(uuid,text,text,text,numeric,boolean,integer) to authenticated;

create or replace function public.delete_restaurant_charge_setting(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_org uuid;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode='42501'; end if;
  delete from public.restaurant_charge_settings where id=p_id and organization_id=v_org;
end;$$;
grant execute on function public.delete_restaurant_charge_setting(uuid) to authenticated;

create or replace function public.get_public_checkout_charges(p_table_code text)
returns table(name text,charge_type text,calculation_type text,value numeric)
language sql security definer stable set search_path=public as $$
  select c.name,c.charge_type,c.calculation_type,c.value
  from public.tables t
  join public.branches b on b.id=t.branch_id
  join public.organizations o on o.id=b.organization_id
  join public.restaurant_charge_settings c on c.organization_id=o.id and c.enabled=true
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
  order by c.sort_order,c.created_at;
$$;
grant execute on function public.get_public_checkout_charges(text) to anon,authenticated;

alter table public.orders add column if not exists additional_charges numeric(12,2) not null default 0 check (additional_charges >= 0);
alter table public.orders add column if not exists charge_breakdown jsonb not null default '[]'::jsonb;

-- Rebuild create_order_for_table so server-side totals use current restaurant charges.
drop function if exists public.create_order_for_table(text,jsonb,text,text,text);
create function public.create_order_for_table(
  p_table_code text,
  p_items jsonb,
  p_payment_method text default 'PAY_AT_COUNTER',
  p_idempotency_key text default null,
  p_customer_note text default null
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
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Cart is empty'; end if;
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

  for v_charge in select name,charge_type,calculation_type,value from public.restaurant_charge_settings where organization_id=(select organization_id from public.branches where id=v_branch_id) and enabled=true order by sort_order,created_at loop
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

  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note)
  values(v_branch_id,v_table.id,'NEW','PENDING',v_payment_method,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,coalesce(v_idempotency,encode(extensions.gen_random_bytes(16),'hex')),encode(extensions.gen_random_bytes(16),'hex'),nullif(trim(coalesce(p_customer_note,'')),''))
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
grant execute on function public.create_order_for_table(text,jsonb,text,text,text) to anon,authenticated;
alter function public.create_order_for_table(text,jsonb,text,text,text) set search_path=public;

-- Financial breakdown for customer tracking; internal order data remains protected by existing RLS.
drop function if exists public.get_public_order_financials(text);
create function public.get_public_order_financials(p_tracking_token text)
returns table(subtotal numeric,tax numeric,additional_charges numeric,discount numeric,total numeric,charge_breakdown jsonb)
language sql stable security definer set search_path=public as $$
  select o.subtotal,o.tax,o.additional_charges,o.discount,o.total,o.charge_breakdown
  from public.orders o where o.tracking_token=trim(p_tracking_token) limit 1;
$$;
grant execute on function public.get_public_order_financials(text) to anon,authenticated;

notify pgrst, 'reload schema';
