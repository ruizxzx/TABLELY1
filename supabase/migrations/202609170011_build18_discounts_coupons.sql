-- TABLELY BUILD 18 — DISCOUNTS + COUPONS + CUSTOMER OFFER EXPERIENCE
-- Additive migration. Build 1–17 migrations/RPCs remain intact; Build 18 uses
-- dedicated v18 public checkout RPCs so existing security-sensitive signatures
-- are not replaced.
begin;

-- ---------------------------------------------------------------------------
-- 1) Coupon definitions and usage history
-- ---------------------------------------------------------------------------
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  code text not null,
  title text,
  description text,
  offer_type text not null default 'STANDARD' check (offer_type in ('STANDARD','TIME_BASED','RUSH_HOUR','SPECIAL_OFFER')),
  discount_type text not null check (discount_type in ('PERCENTAGE','FIXED')),
  discount_value numeric(12,2) not null check (discount_value >= 0),
  minimum_order_amount numeric(12,2) not null default 0 check (minimum_order_amount >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit_total integer check (usage_limit_total is null or usage_limit_total >= 1),
  usage_limit_per_customer integer check (usage_limit_per_customer is null or usage_limit_per_customer >= 1),
  is_active boolean not null default true,
  promote boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check ((discount_type = 'PERCENTAGE' and discount_value <= 100) or discount_type = 'FIXED')
);

create unique index if not exists coupons_org_code_uq on public.coupons(organization_id, lower(code));
create index if not exists coupons_branch_active_idx on public.coupons(branch_id,is_active,starts_at,ends_at);
create index if not exists coupons_org_active_idx on public.coupons(organization_id,is_active,starts_at,ends_at);

create table if not exists public.coupon_menu_items (
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  primary key(coupon_id,menu_item_id)
);
create index if not exists coupon_menu_items_item_idx on public.coupon_menu_items(menu_item_id,coupon_id);

create table if not exists public.coupon_categories (
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  category_id uuid not null references public.menu_categories(id) on delete cascade,
  primary key(coupon_id,category_id)
);
create index if not exists coupon_categories_category_idx on public.coupon_categories(category_id,coupon_id);

create table if not exists public.coupon_usages (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  table_id uuid references public.tables(id) on delete set null,
  table_session_id uuid references public.table_sessions(id) on delete set null,
  customer_phone text,
  coupon_code_snapshot text not null,
  discount_type_snapshot text not null,
  discount_value_snapshot numeric(12,2) not null,
  discount_amount numeric(12,2) not null check (discount_amount >= 0),
  applied_at timestamptz not null default now(),
  unique(coupon_id,order_id)
);
create index if not exists coupon_usages_coupon_idx on public.coupon_usages(coupon_id,applied_at desc);
create index if not exists coupon_usages_customer_idx on public.coupon_usages(coupon_id,customer_phone,applied_at desc);
create index if not exists coupon_usages_branch_idx on public.coupon_usages(branch_id,applied_at desc);

-- Historical discount snapshot on both finalized orders and payment attempts.
alter table public.orders
  add column if not exists coupon_id uuid references public.coupons(id) on delete set null,
  add column if not exists coupon_code_snapshot text,
  add column if not exists discount_type_snapshot text,
  add column if not exists discount_value_snapshot numeric(12,2);

alter table public.payment_attempts
  add column if not exists coupon_id uuid references public.coupons(id) on delete set null,
  add column if not exists coupon_code_snapshot text,
  add column if not exists discount_type_snapshot text,
  add column if not exists discount_value_snapshot numeric(12,2);

create index if not exists orders_coupon_idx on public.orders(coupon_id,created_at desc) where coupon_id is not null;
create index if not exists payment_attempts_coupon_idx on public.payment_attempts(coupon_id,status,created_at desc) where coupon_id is not null;

-- Coupon tables are never writable directly by authenticated/anonymous clients.
alter table public.coupons enable row level security;
alter table public.coupon_menu_items enable row level security;
alter table public.coupon_categories enable row level security;
alter table public.coupon_usages enable row level security;
revoke all on public.coupons from anon,authenticated,public;
revoke all on public.coupon_menu_items from anon,authenticated,public;
revoke all on public.coupon_categories from anon,authenticated,public;
revoke all on public.coupon_usages from anon,authenticated,public;

-- Updated-at trigger uses the existing helper.
drop trigger if exists coupons_touch_updated_at on public.coupons;
create trigger coupons_touch_updated_at before update on public.coupons for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2) Reusable coupon validation/calculation helper
-- ---------------------------------------------------------------------------
drop function if exists public.build18_validate_coupon(uuid,numeric,jsonb,text,text,boolean);
create function public.build18_validate_coupon(
  p_branch_id uuid,
  p_subtotal numeric,
  p_snapshot jsonb,
  p_coupon_code text,
  p_customer_phone text default null,
  p_lock_coupon boolean default false
)
returns table(
  coupon_id uuid,
  coupon_code text,
  discount_type text,
  discount_value numeric,
  eligible_subtotal numeric,
  discount_amount numeric
)
language plpgsql
security definer
set search_path=public
as $$
declare
  v_coupon public.coupons%rowtype;
  v_code text := upper(trim(coalesce(p_coupon_code,'')));
  v_phone text := nullif(regexp_replace(trim(coalesce(p_customer_phone,'')),'[^0-9]','','g'),'');
  v_now timestamptz := now();
  v_used_total bigint := 0;
  v_used_customer bigint := 0;
  v_active_attempts bigint := 0;
  v_eligible numeric(12,2) := 0;
  v_discount numeric(12,2) := 0;
  v_has_item_scope boolean := false;
  v_has_category_scope boolean := false;
begin
  if v_code is null or v_code='' then
    return;
  end if;
  if p_branch_id is null then raise exception 'Invalid branch'; end if;
  if p_subtotal is null or p_subtotal < 0 then raise exception 'Invalid order subtotal'; end if;
  if jsonb_typeof(coalesce(p_snapshot,'[]'::jsonb)) <> 'array' then raise exception 'Invalid cart snapshot'; end if;

  if p_lock_coupon then
    select c.* into v_coupon
    from public.coupons c
    where c.organization_id = (select b.organization_id from public.branches b where b.id=p_branch_id)
      and lower(c.code)=lower(v_code)
    for update;
  else
    select c.* into v_coupon
    from public.coupons c
    where c.organization_id = (select b.organization_id from public.branches b where b.id=p_branch_id)
      and lower(c.code)=lower(v_code)
    limit 1;
  end if;

  if v_coupon.id is null then raise exception 'Invalid coupon'; end if;
  if not v_coupon.is_active then raise exception 'Coupon is not active'; end if;
  if v_coupon.branch_id is not null and v_coupon.branch_id<>p_branch_id then raise exception 'Coupon not valid for this branch'; end if;
  if v_coupon.starts_at is not null and v_now < v_coupon.starts_at then raise exception 'Coupon is not active yet'; end if;
  if v_coupon.ends_at is not null and v_now >= v_coupon.ends_at then raise exception 'Coupon expired'; end if;
  if p_subtotal < v_coupon.minimum_order_amount then raise exception 'Minimum order not met'; end if;

  select exists(select 1 from public.coupon_menu_items x where x.coupon_id=v_coupon.id),
         exists(select 1 from public.coupon_categories x where x.coupon_id=v_coupon.id)
    into v_has_item_scope,v_has_category_scope;
  v_has_item_scope := coalesce(v_has_item_scope,false);
  v_has_category_scope := coalesce(v_has_category_scope,false);

  if not v_has_item_scope and not v_has_category_scope then
    v_eligible := round(p_subtotal,2);
  else
    select coalesce(sum((x->>'line_total')::numeric),0)::numeric(12,2)
      into v_eligible
    from jsonb_array_elements(p_snapshot) x
    where exists(
      select 1 from public.menu_items mi
      where mi.id=(x->>'menu_item_id')::uuid
        and mi.branch_id=p_branch_id
        and (
          (v_has_item_scope and exists(select 1 from public.coupon_menu_items ci where ci.coupon_id=v_coupon.id and ci.menu_item_id=mi.id))
          or
          (v_has_category_scope and mi.category_id is not null and exists(select 1 from public.coupon_categories cc where cc.coupon_id=v_coupon.id and cc.category_id=mi.category_id))
        )
    );
    if v_eligible<=0 then raise exception 'Coupon not valid for these items'; end if;
  end if;

  if v_coupon.usage_limit_total is not null then
    select count(*) into v_used_total from public.coupon_usages u where u.coupon_id=v_coupon.id;
    select count(*) into v_active_attempts from public.payment_attempts pa where pa.coupon_id=v_coupon.id and pa.status in ('PENDING','PROCESSING') and pa.payment_expires_at>v_now;
    if v_used_total + v_active_attempts >= v_coupon.usage_limit_total then raise exception 'Coupon usage limit reached'; end if;
  end if;

  if v_phone is not null then
    if length(v_phone)=12 and left(v_phone,2)='91' then v_phone:=right(v_phone,10); end if;
    if length(v_phone)=10 and left(v_phone,1) in ('6','7','8','9') and v_coupon.usage_limit_per_customer is not null then
      select count(*) into v_used_customer from public.coupon_usages u where u.coupon_id=v_coupon.id and u.customer_phone=v_phone;
      select count(*) into v_active_attempts from public.payment_attempts pa where pa.coupon_id=v_coupon.id and pa.customer_phone=v_phone and pa.status in ('PENDING','PROCESSING') and pa.payment_expires_at>v_now;
      if v_used_customer + v_active_attempts >= v_coupon.usage_limit_per_customer then raise exception 'Customer usage limit reached'; end if;
    end if;
  end if;

  if v_coupon.discount_type='PERCENTAGE' then
    v_discount := round(v_eligible*v_coupon.discount_value/100.0,2);
  else
    v_discount := least(round(v_coupon.discount_value,2),v_eligible);
  end if;
  v_discount := greatest(0,least(v_discount,round(p_subtotal,2)));

  return query select v_coupon.id,v_coupon.code,v_coupon.discount_type,v_coupon.discount_value,v_eligible,v_discount;
end;
$$;
revoke execute on function public.build18_validate_coupon(uuid,numeric,jsonb,text,text,boolean) from anon,authenticated,public;

-- ---------------------------------------------------------------------------
-- 3) Customer-facing checkout preview
-- ---------------------------------------------------------------------------
drop function if exists public.preview_public_checkout_v18(text,jsonb,text,text);
create function public.preview_public_checkout_v18(
  p_table_code text,
  p_items jsonb,
  p_coupon_code text default null,
  p_customer_phone text default null
)
returns table(
  subtotal numeric,
  discount numeric,
  discounted_subtotal numeric,
  tax numeric,
  additional_charges numeric,
  total numeric,
  charge_breakdown jsonb,
  coupon_id uuid,
  coupon_code text,
  discount_type text,
  discount_value numeric
)
language plpgsql
security definer
set search_path=public
as $$
declare
  v_table public.tables%rowtype;
  v_snapshot jsonb;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2):=0;
  v_tax numeric(12,2):=0;
  v_additional numeric(12,2):=0;
  v_total numeric(12,2);
  v_breakdown jsonb:='[]'::jsonb;
  v_coupon_id uuid:=null;
  v_coupon_code text:=null;
  v_discount_type text:=null;
  v_discount_value numeric:=null;
  v_charge record;
  v_amt numeric(12,2);
begin
  select t.* into v_table
  from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
  limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  v_snapshot:=public.build16_calculate_cart(v_table.branch_id,p_items);
  v_subtotal:=round(coalesce((select sum((x->>'line_total')::numeric) from jsonb_array_elements(v_snapshot) x),0),2);
  if v_subtotal<=0 then raise exception 'Cart is empty'; end if;

  if nullif(trim(coalesce(p_coupon_code,'')),'') is not null then
    select x.coupon_id,x.coupon_code,x.discount_type,x.discount_value,x.discount_amount
      into v_coupon_id,v_coupon_code,v_discount_type,v_discount_value,v_discount
    from public.build18_validate_coupon(v_table.branch_id,v_subtotal,v_snapshot,p_coupon_code,p_customer_phone,false) x;
  end if;

  for v_charge in
    select c.name,c.charge_type,c.calculation_type,c.value
    from public.restaurant_charge_settings c
    where c.enabled=true
      and (c.branch_id=v_table.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_table.branch_id)))
    order by c.sort_order,c.created_at
  loop
    if v_charge.calculation_type='PERCENT' then v_amt:=round((v_subtotal-v_discount)*v_charge.value/100.0,2); else v_amt:=round(v_charge.value,2); end if;
    v_amt:=greatest(0,v_amt);
    if v_charge.charge_type='TAX' then v_tax:=v_tax+v_amt; else v_additional:=v_additional+v_amt; end if;
    v_breakdown:=v_breakdown||jsonb_build_object('name',v_charge.name,'charge_type',v_charge.charge_type,'calculation_type',v_charge.calculation_type,'value',v_charge.value,'amount',v_amt);
  end loop;
  v_total:=round(v_subtotal-v_discount+v_tax+v_additional,2);
  if v_total<0 then raise exception 'Calculated total is invalid'; end if;
  if v_total>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;

  return query select v_subtotal,v_discount,round(v_subtotal-v_discount,2),round(v_tax,2),round(v_additional,2),v_total,v_breakdown,v_coupon_id,v_coupon_code,v_discount_type,v_discount_value;
end;
$$;
grant execute on function public.preview_public_checkout_v18(text,jsonb,text,text) to anon,authenticated;
revoke execute on function public.preview_public_checkout_v18(text,jsonb,text,text) from public;

-- ---------------------------------------------------------------------------
-- 4) Public active offers for menu/customer promotion
-- ---------------------------------------------------------------------------
drop function if exists public.get_public_active_offers_v18(text,jsonb);
create function public.get_public_active_offers_v18(p_table_code text,p_items jsonb default '[]'::jsonb)
returns table(id uuid,code text,title text,description text,offer_type text,discount_type text,discount_value numeric,minimum_order_amount numeric,starts_at timestamptz,ends_at timestamptz,eligible_item_ids uuid[])
language plpgsql
security definer
stable
set search_path=public
as $$
declare
  v_table public.tables%rowtype;
  v_snapshot jsonb:=coalesce(p_items,'[]'::jsonb);
  v_subtotal numeric:=0;
begin
  if jsonb_typeof(v_snapshot)<>'array' then v_snapshot:='[]'::jsonb; end if;
  select t.* into v_table
  from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if jsonb_array_length(v_snapshot)>0 then
    v_snapshot:=public.build16_calculate_cart(v_table.branch_id,v_snapshot);
    select round(coalesce(sum((x->>'line_total')::numeric),0),2) into v_subtotal from jsonb_array_elements(v_snapshot) x;
  end if;
  return query
  select c.id,c.code,coalesce(c.title,c.code),c.description,c.offer_type,c.discount_type,c.discount_value,c.minimum_order_amount,c.starts_at,c.ends_at,
         coalesce((select array_agg(distinct mi.id order by mi.id)
                   from public.menu_items mi
                   where mi.branch_id=v_table.branch_id
                     and (exists(select 1 from public.coupon_menu_items ci where ci.coupon_id=c.id and ci.menu_item_id=mi.id)
                          or (mi.category_id is not null and exists(select 1 from public.coupon_categories cc where cc.coupon_id=c.id and cc.category_id=mi.category_id)))), '{}'::uuid[])
  from public.coupons c
  where c.is_active=true
    and c.promote=true
    and c.organization_id=(select b.organization_id from public.branches b where b.id=v_table.branch_id)
    and (c.branch_id is null or c.branch_id=v_table.branch_id)
    and (c.starts_at is null or now()>=c.starts_at)
    and (c.ends_at is null or now()<c.ends_at)
    and (jsonb_array_length(v_snapshot)=0 or v_subtotal>=c.minimum_order_amount)
    and (c.usage_limit_total is null or (select count(*) from public.coupon_usages u where u.coupon_id=c.id) + (select count(*) from public.payment_attempts pa where pa.coupon_id=c.id and pa.status in ('PENDING','PROCESSING') and pa.payment_expires_at>now()) < c.usage_limit_total)
    and (
      jsonb_array_length(v_snapshot)=0
      or (not exists(select 1 from public.coupon_menu_items x where x.coupon_id=c.id) and not exists(select 1 from public.coupon_categories x where x.coupon_id=c.id))
      or exists(
        select 1 from jsonb_array_elements(v_snapshot) x
        where exists(select 1 from public.menu_items mi where mi.id=(x->>'menu_item_id')::uuid and mi.branch_id=v_table.branch_id and (
          exists(select 1 from public.coupon_menu_items ci where ci.coupon_id=c.id and ci.menu_item_id=mi.id)
          or (mi.category_id is not null and exists(select 1 from public.coupon_categories cc where cc.coupon_id=c.id and cc.category_id=mi.category_id))
        ))
      )
    )
  order by c.starts_at nulls first,c.created_at desc
  limit 8;
end;
$$;
grant execute on function public.get_public_active_offers_v18(text,jsonb) to anon,authenticated;
revoke execute on function public.get_public_active_offers_v18(text,jsonb) from public;

-- ---------------------------------------------------------------------------
-- 5) Owner coupon management RPCs
-- ---------------------------------------------------------------------------
drop function if exists public.list_coupons_v18(uuid);
create function public.list_coupons_v18(p_branch_id uuid default null)
returns table(id uuid,branch_id uuid,code text,title text,description text,offer_type text,discount_type text,discount_value numeric,minimum_order_amount numeric,starts_at timestamptz,ends_at timestamptz,usage_limit_total integer,usage_limit_per_customer integer,is_active boolean,promote boolean,usage_count bigint,updated_at timestamptz)
language plpgsql
security definer
set search_path=public
as $$
declare v_org uuid;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode='42501'; end if;
  if p_branch_id is not null and not exists(select 1 from public.branches b where b.id=p_branch_id and b.organization_id=v_org) then raise exception 'Branch not found'; end if;
  return query
  select c.id,c.branch_id,c.code,c.title,c.description,c.offer_type,c.discount_type,c.discount_value,c.minimum_order_amount,c.starts_at,c.ends_at,c.usage_limit_total,c.usage_limit_per_customer,c.is_active,c.promote,
         (select count(*) from public.coupon_usages u where u.coupon_id=c.id),c.updated_at
  from public.coupons c
  where c.organization_id=v_org and (p_branch_id is null or c.branch_id is null or c.branch_id=p_branch_id)
  order by c.created_at desc;
end;
$$;
grant execute on function public.list_coupons_v18(uuid) to authenticated;
revoke execute on function public.list_coupons_v18(uuid) from public;

drop function if exists public.upsert_coupon_v18(uuid,uuid,text,text,text,text,text,numeric,numeric,timestamptz,timestamptz,integer,integer,boolean,boolean,uuid[],uuid[]);
create function public.upsert_coupon_v18(
  p_id uuid default null,
  p_branch_id uuid default null,
  p_code text default null,
  p_title text default null,
  p_description text default null,
  p_offer_type text default 'STANDARD',
  p_discount_type text default 'PERCENTAGE',
  p_discount_value numeric default 0,
  p_minimum_order_amount numeric default 0,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null,
  p_usage_limit_total integer default null,
  p_usage_limit_per_customer integer default null,
  p_is_active boolean default true,
  p_promote boolean default false,
  p_category_ids uuid[] default '{}',
  p_menu_item_ids uuid[] default '{}'
)
returns public.coupons
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org uuid;
  v_coupon public.coupons%rowtype;
  v_before public.coupons%rowtype;
  v_code text:=upper(trim(coalesce(p_code,'')));
  v_branch_org uuid;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode='42501'; end if;
  if v_code is null or v_code='' or length(v_code)>64 or v_code !~ '^[A-Z0-9][A-Z0-9_-]*$' then raise exception 'Coupon code must use letters, numbers, hyphen or underscore'; end if;
  if p_discount_type not in ('PERCENTAGE','FIXED') then raise exception 'Invalid discount type'; end if;
  if p_offer_type not in ('STANDARD','TIME_BASED','RUSH_HOUR','SPECIAL_OFFER') then raise exception 'Invalid offer type'; end if;
  if p_discount_value is null or p_discount_value<0 or (p_discount_type='PERCENTAGE' and p_discount_value>100) then raise exception 'Invalid discount value'; end if;
  if p_minimum_order_amount is null or p_minimum_order_amount<0 then raise exception 'Invalid minimum order amount'; end if;
  if p_ends_at is not null and p_starts_at is not null and p_ends_at<=p_starts_at then raise exception 'End time must be after start time'; end if;
  if p_usage_limit_total is not null and p_usage_limit_total<1 then raise exception 'Invalid total usage limit'; end if;
  if p_usage_limit_per_customer is not null and p_usage_limit_per_customer<1 then raise exception 'Invalid customer usage limit'; end if;
  if p_branch_id is not null then
    select b.organization_id into v_branch_org from public.branches b where b.id=p_branch_id and b.is_active=true;
    if v_branch_org is null or v_branch_org<>v_org then raise exception 'Branch not found'; end if;
  end if;

  if exists(select 1 from unnest(coalesce(p_menu_item_ids,'{}'::uuid[])) x where not exists(select 1 from public.menu_items mi join public.branches b on b.id=mi.branch_id where mi.id=x and b.organization_id=v_org and (p_branch_id is null or mi.branch_id=p_branch_id))) then raise exception 'One or more menu items are outside this restaurant or branch'; end if;
  if exists(select 1 from unnest(coalesce(p_category_ids,'{}'::uuid[])) x where not exists(select 1 from public.menu_categories mc join public.branches b on b.id=mc.branch_id where mc.id=x and b.organization_id=v_org and (p_branch_id is null or mc.branch_id=p_branch_id))) then raise exception 'One or more categories are outside this restaurant or branch'; end if;

  if p_id is null then
    insert into public.coupons(organization_id,branch_id,code,title,description,offer_type,discount_type,discount_value,minimum_order_amount,starts_at,ends_at,usage_limit_total,usage_limit_per_customer,is_active,promote)
    values(v_org,p_branch_id,v_code,nullif(left(trim(coalesce(p_title,'')),120),''),nullif(left(trim(coalesce(p_description,'')),500),''),p_offer_type,p_discount_type,round(p_discount_value,2),round(p_minimum_order_amount,2),p_starts_at,p_ends_at,p_usage_limit_total,p_usage_limit_per_customer,coalesce(p_is_active,true),coalesce(p_promote,false))
    returning * into v_coupon;
  else
    select c.* into v_before from public.coupons c where c.id=p_id and c.organization_id=v_org for update;
    if v_before.id is null then raise exception 'Coupon not found'; end if;
    update public.coupons c set branch_id=p_branch_id,code=v_code,title=nullif(left(trim(coalesce(p_title,'')),120),''),description=nullif(left(trim(coalesce(p_description,'')),500),''),offer_type=p_offer_type,discount_type=p_discount_type,discount_value=round(p_discount_value,2),minimum_order_amount=round(p_minimum_order_amount,2),starts_at=p_starts_at,ends_at=p_ends_at,usage_limit_total=p_usage_limit_total,usage_limit_per_customer=p_usage_limit_per_customer,is_active=coalesce(p_is_active,true),promote=coalesce(p_promote,false),updated_at=now()
    where c.id=p_id and c.organization_id=v_org
    returning * into v_coupon;
    if v_coupon.id is null then raise exception 'Coupon not found'; end if;
  end if;

  delete from public.coupon_menu_items where coupon_id=v_coupon.id;
  delete from public.coupon_categories where coupon_id=v_coupon.id;
  insert into public.coupon_menu_items(coupon_id,menu_item_id) select v_coupon.id,x from unnest(coalesce(p_menu_item_ids,'{}'::uuid[])) x;
  insert into public.coupon_categories(coupon_id,category_id) select v_coupon.id,x from unnest(coalesce(p_category_ids,'{}'::uuid[])) x;

  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(
    auth.uid(),
    case
      when v_before.id is null then 'COUPON_CREATED'
      when v_before.is_active and not v_coupon.is_active then 'COUPON_DISABLED'
      when not v_before.is_active and v_coupon.is_active then 'COUPON_ENABLED'
      else 'COUPON_UPDATED'
    end,
    'COUPON',
    v_coupon.id,
    jsonb_build_object(
      'organization_id',v_coupon.organization_id,
      'branch_id',v_coupon.branch_id,
      'code',v_coupon.code,
      'discount_type',v_coupon.discount_type,
      'discount_value',v_coupon.discount_value,
      'minimum_order_amount',v_coupon.minimum_order_amount,
      'is_active',v_coupon.is_active,
      'promote',v_coupon.promote,
      'previous_active',case when v_before.id is null then null else v_before.is_active end
    )
  );

  return v_coupon;
exception when unique_violation then
  raise exception 'A coupon with this code already exists';
end;
$$;
grant execute on function public.upsert_coupon_v18(uuid,uuid,text,text,text,text,text,numeric,numeric,timestamptz,timestamptz,integer,integer,boolean,boolean,uuid[],uuid[]) to authenticated;
revoke execute on function public.upsert_coupon_v18(uuid,uuid,text,text,text,text,text,numeric,numeric,timestamptz,timestamptz,integer,integer,boolean,boolean,uuid[],uuid[]) from public;

drop function if exists public.get_coupon_config_v18(uuid);
create function public.get_coupon_config_v18(p_id uuid)
returns table(category_ids uuid[],menu_item_ids uuid[])
language plpgsql security definer
set search_path=public
as $$
declare v_org uuid;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode='42501'; end if;
  return query select
    coalesce((select array_agg(category_id order by category_id) from public.coupon_categories where coupon_id=p_id),'{}'::uuid[]),
    coalesce((select array_agg(menu_item_id order by menu_item_id) from public.coupon_menu_items where coupon_id=p_id),'{}'::uuid[])
  where exists(select 1 from public.coupons c where c.id=p_id and c.organization_id=v_org);
end;
$$;
grant execute on function public.get_coupon_config_v18(uuid) to authenticated;
revoke execute on function public.get_coupon_config_v18(uuid) from public;

drop function if exists public.list_coupon_usage_v18(uuid);
create function public.list_coupon_usage_v18(p_coupon_id uuid)
returns table(order_id uuid,order_number bigint,branch_id uuid,table_id uuid,customer_phone text,discount_amount numeric,applied_at timestamptz)
language plpgsql
security definer
set search_path=public
as $$
declare v_org uuid;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode='42501'; end if;
  return query select u.order_id,o.order_number,u.branch_id,u.table_id,u.customer_phone,u.discount_amount,u.applied_at
  from public.coupon_usages u join public.orders o on o.id=u.order_id
  where u.coupon_id=p_coupon_id and u.organization_id=v_org order by u.applied_at desc;
end;
$$;
grant execute on function public.list_coupon_usage_v18(uuid) to authenticated;
revoke execute on function public.list_coupon_usage_v18(uuid) from public;

-- ---------------------------------------------------------------------------
-- 6) Build 18 counter-order creation (new signature, old function preserved)
-- ---------------------------------------------------------------------------
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
  values(v_table.branch_id,v_table.id,'NEW','PENDING','PAY_AT_COUNTER',v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,coalesce(v_idem,encode(extensions.gen_random_bytes(16),'hex')),encode(extensions.gen_random_bytes(16),'hex'),nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_user_phone,case when v_coupon.id is null then null else v_coupon.coupon_id end,case when v_coupon.id is null then null else v_coupon.coupon_code end,case when v_coupon.id is null then null else v_coupon.discount_type end,case when v_coupon.id is null then null else v_coupon.discount_value end)
  returning * into v_order;

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
    values(v_order.id,v_order.branch_id,'COUPON_APPLIED',null,jsonb_build_object('coupon_id',v_coupon.coupon_id,'coupon_code',v_coupon.coupon_code,'discount',v_coupon.discount_amount,'source','BUILD18_COUNTER'));
  end if;

  return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.subtotal,v_order.tax,v_order.additional_charges,v_order.discount,v_order.total,v_order.charge_breakdown,v_order.payment_status,v_order.status;
exception when unique_violation then
  if v_idem is not null then select * into v_existing from public.orders where branch_id=v_table.branch_id and idempotency_key=v_idem limit 1; if v_existing.id is not null then return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.subtotal,v_existing.tax,v_existing.additional_charges,v_existing.discount,v_existing.total,v_existing.charge_breakdown,v_existing.payment_status,v_existing.status; return; end if; end if;
  raise;
end;
$$;
grant execute on function public.create_order_for_table_v18(text,jsonb,text,text,text,text,text,text) to anon,authenticated;
revoke execute on function public.create_order_for_table_v18(text,jsonb,text,text,text,text,text,text) from public;

-- ---------------------------------------------------------------------------
-- 7) Build 18 payment attempt creation with discount snapshot
-- ---------------------------------------------------------------------------
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
  values(encode(extensions.gen_random_bytes(32),'hex'),v_table.branch_id,v_table.id,v_idem,v_snapshot,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_phone,v_now,v_now+interval '1 hour',case when v_coupon.id is null then null else v_coupon.coupon_id end,case when v_coupon.id is null then null else v_coupon.coupon_code end,case when v_coupon.id is null then null else v_coupon.discount_type end,case when v_coupon.id is null then null else v_coupon.discount_value end)
  returning * into v_attempt;
  return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at;
exception when unique_violation then
  select * into v_attempt from public.payment_attempts where branch_id=v_table.branch_id and idempotency_key=v_idem and status in ('PENDING','PROCESSING') order by created_at desc limit 1;
  if v_attempt.id is not null then return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at; return; end if;
  raise;
end;
$$;
grant execute on function public.create_payment_attempt_for_table_v18(text,jsonb,text,text,text,text,text) to anon,authenticated;
revoke execute on function public.create_payment_attempt_for_table_v18(text,jsonb,text,text,text,text,text) from public;

-- ---------------------------------------------------------------------------
-- 8) Finalize payment-first attempt with immutable discount snapshot + usage
-- ---------------------------------------------------------------------------
drop function if exists public.finalize_payment_attempt_v18(uuid,text,text,text);
create function public.finalize_payment_attempt_v18(p_payment_attempt_id uuid,p_attempt_token text,p_razorpay_payment_id text,p_payment_method text)
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

  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,paid_at,razorpay_payment_id,coupon_id,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot)
  values(v_attempt.branch_id,v_attempt.table_id,'NEW','PAID',concat('PAY_NOW:',case when v_method='' then 'ONLINE' else v_method end),v_attempt.subtotal,v_attempt.tax,v_attempt.discount,v_attempt.additional_charges,v_attempt.total,v_attempt.charge_breakdown,concat('payment-attempt:',v_attempt.id::text),encode(extensions.gen_random_bytes(16),'hex'),v_attempt.customer_note,v_attempt.customer_name,v_attempt.customer_phone,v_now,p_razorpay_payment_id,v_attempt.coupon_id,v_attempt.coupon_code_snapshot,v_attempt.discount_type_snapshot,v_attempt.discount_value_snapshot)
  returning * into v_order;

  for v_item in select value from jsonb_array_elements(v_attempt.items_snapshot) loop
    insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions,selected_options,configuration_snapshot)
    values(v_order.id,(v_item->>'menu_item_id')::uuid,v_item->>'item_name_snapshot',(v_item->>'unit_price')::numeric,(v_item->>'quantity')::integer,coalesce(v_item->'selected_addons','[]'::jsonb),nullif(v_item->>'special_instructions',''),coalesce(v_item->'selected_options','[]'::jsonb),v_item);
  end loop;

  if v_attempt.coupon_id is not null then
    insert into public.coupon_usages(coupon_id,order_id,organization_id,branch_id,table_id,table_session_id,customer_phone,coupon_code_snapshot,discount_type_snapshot,discount_value_snapshot,discount_amount)
    values(v_attempt.coupon_id,v_order.id,(select organization_id from public.branches where id=v_order.branch_id),v_order.branch_id,v_order.table_id,v_order.table_session_id,v_attempt.customer_phone,v_attempt.coupon_code_snapshot,v_attempt.discount_type_snapshot,v_attempt.discount_value_snapshot,v_attempt.discount);
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
    values(v_order.id,v_order.branch_id,'COUPON_APPLIED',null,jsonb_build_object('coupon_id',v_attempt.coupon_id,'coupon_code',v_attempt.coupon_code_snapshot,'discount',v_attempt.discount,'source','BUILD18_PAYMENT_FIRST'));
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

-- ---------------------------------------------------------------------------
-- 9) Helpful indexes for customer/checkout/owner queries
-- ---------------------------------------------------------------------------
create index if not exists coupon_usage_order_idx on public.coupon_usages(order_id);

commit;
notify pgrst, 'reload schema';
