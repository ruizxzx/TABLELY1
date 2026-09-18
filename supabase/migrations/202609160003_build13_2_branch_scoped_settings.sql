-- TABLELY BUILD 13.2 — Branch-scoped charges and payment configuration
-- Additive/data-preserving migration.
-- Existing organization-level charges/payment settings remain valid defaults.
-- A branch-specific charge set overrides organization defaults for that branch.
-- A branch-specific payment configuration overrides the organization default.

begin;

-- ---------------------------------------------------------------------------
-- 1) Branch-scoped checkout charges
-- ---------------------------------------------------------------------------
alter table public.restaurant_charge_settings
  add column if not exists branch_id uuid references public.branches(id) on delete cascade;

alter table public.restaurant_charge_settings
  add column if not exists source_charge_id uuid references public.restaurant_charge_settings(id) on delete set null;

create index if not exists restaurant_charge_settings_branch_idx
  on public.restaurant_charge_settings(organization_id, branch_id, sort_order, created_at);

create unique index if not exists restaurant_charge_settings_branch_source_uq
  on public.restaurant_charge_settings(branch_id, source_charge_id)
  where branch_id is not null and source_charge_id is not null;

-- Existing org-wide charges remain readable only to owners or authorized branch
-- managers. Customer checkout uses the SECURITY DEFINER public RPC below.
drop policy if exists restaurant_charge_settings_owner_select on public.restaurant_charge_settings;
drop policy if exists restaurant_charge_settings_select on public.restaurant_charge_settings;
drop policy if exists restaurant_charge_settings_insert on public.restaurant_charge_settings;
drop policy if exists restaurant_charge_settings_update on public.restaurant_charge_settings;
drop policy if exists restaurant_charge_settings_delete on public.restaurant_charge_settings;

create policy restaurant_charge_settings_select on public.restaurant_charge_settings
for select to authenticated
using (
  public.is_org_owner(organization_id)
  or (branch_id is not null and public.current_user_has_permission_for_branch(branch_id, 'CHARGES'))
);

create policy restaurant_charge_settings_insert on public.restaurant_charge_settings
for insert to authenticated
with check (
  (branch_id is null and public.is_org_owner(organization_id))
  or (branch_id is not null and public.current_user_has_permission_for_branch(branch_id, 'CHARGES')
      and exists (select 1 from public.branches b where b.id = branch_id and b.organization_id = restaurant_charge_settings.organization_id))
);

create policy restaurant_charge_settings_update on public.restaurant_charge_settings
for update to authenticated
using (
  (branch_id is null and public.is_org_owner(organization_id))
  or (branch_id is not null and public.current_user_has_permission_for_branch(branch_id, 'CHARGES'))
)
with check (
  (branch_id is null and public.is_org_owner(organization_id))
  or (branch_id is not null and public.current_user_has_permission_for_branch(branch_id, 'CHARGES')
      and exists (select 1 from public.branches b where b.id = branch_id and b.organization_id = restaurant_charge_settings.organization_id))
);

create policy restaurant_charge_settings_delete on public.restaurant_charge_settings
for delete to authenticated
using (
  (branch_id is null and public.is_org_owner(organization_id))
  or (branch_id is not null and public.current_user_has_permission_for_branch(branch_id, 'CHARGES'))
);

-- Replace legacy charge RPCs with branch-aware, permission-aware variants.
drop function if exists public.list_restaurant_charge_settings();
create function public.list_restaurant_charge_settings(p_branch_id uuid default null)
returns table(id uuid,name text,charge_type text,calculation_type text,value numeric,enabled boolean,sort_order integer,updated_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_branch uuid;
begin
  select s.organization_id into v_org
  from public.staff s
  where s.user_id=auth.uid() and s.active=true
  order by case when s.role='OWNER'::public.staff_role then 0 when s.role='MANAGER'::public.staff_role then 1 else 2 end, s.created_at
  limit 1;
  if v_org is null then raise exception 'Restaurant access required' using errcode='42501'; end if;
  if p_branch_id is null then
    if not public.is_org_owner(v_org) then raise exception 'Owner access required' using errcode='42501'; end if;
    return query
      select c.id,c.name,c.charge_type,c.calculation_type,c.value,c.enabled,c.sort_order,c.updated_at
      from public.restaurant_charge_settings c
      where c.organization_id=v_org and c.branch_id is null
      order by c.sort_order,c.created_at;
  else
    v_branch:=p_branch_id;
    if not public.current_user_has_permission_for_branch(v_branch,'CHARGES') then raise exception 'Charge management permission required' using errcode='42501'; end if;
    return query
      select c.id,c.name,c.charge_type,c.calculation_type,c.value,c.enabled,c.sort_order,c.updated_at
      from public.restaurant_charge_settings c
      where c.organization_id=v_org
        and (
          c.branch_id=v_branch
          or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=v_org and cb.branch_id=v_branch))
        )
      order by c.sort_order,c.created_at;
  end if;
end;$$;
grant execute on function public.list_restaurant_charge_settings(uuid) to authenticated;
revoke execute on function public.list_restaurant_charge_settings(uuid) from anon,public;

drop function if exists public.upsert_restaurant_charge_setting(uuid,text,text,text,numeric,boolean,integer);
create function public.upsert_restaurant_charge_setting(
  p_id uuid default null, p_name text default null, p_charge_type text default 'FEE',
  p_calculation_type text default 'PERCENT', p_value numeric default 0,
  p_enabled boolean default true, p_sort_order integer default 0, p_branch_id uuid default null
)
returns public.restaurant_charge_settings
language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_row public.restaurant_charge_settings%rowtype; v_existing public.restaurant_charge_settings%rowtype;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true order by case when s.role='OWNER'::public.staff_role then 0 when s.role='MANAGER'::public.staff_role then 1 else 2 end,s.created_at limit 1;
  if v_org is null then raise exception 'Restaurant access required' using errcode='42501'; end if;
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'Charge name is required'; end if;
  if upper(trim(coalesce(p_charge_type,''))) not in ('TAX','FEE') then raise exception 'Invalid charge type'; end if;
  if upper(trim(coalesce(p_calculation_type,''))) not in ('PERCENT','FIXED') then raise exception 'Invalid calculation type'; end if;
  if p_value is null or p_value<0 or p_value>1000000 then raise exception 'Charge value is invalid'; end if;
  if p_sort_order<0 or p_sort_order>1000 then raise exception 'Sort order is invalid'; end if;
  if p_branch_id is null then
    if not public.is_org_owner(v_org) then raise exception 'Owner access required' using errcode='42501'; end if;
  else
    if not public.current_user_has_permission_for_branch(p_branch_id,'CHARGES') then raise exception 'Charge management permission required' using errcode='42501'; end if;
    if not exists(select 1 from public.branches b where b.id=p_branch_id and b.organization_id=v_org) then raise exception 'Branch does not belong to this organization' using errcode='42501'; end if;
  end if;
  if p_id is not null then
    select * into v_existing from public.restaurant_charge_settings c where c.id=p_id and c.organization_id=v_org;
    if v_existing.id is null then raise exception 'Charge not found' using errcode='P0002'; end if;
    if p_branch_id is null and v_existing.branch_id is not null then raise exception 'Charge belongs to a branch' using errcode='42501'; end if;
    if p_branch_id is not null and v_existing.branch_id is not null and v_existing.branch_id<>p_branch_id then raise exception 'Charge belongs to another branch' using errcode='42501'; end if;
    if p_branch_id is not null and v_existing.branch_id is null then
      -- Convert the organization default into a branch override by cloning the
      -- complete default set first, then update the clone corresponding to p_id.
      insert into public.restaurant_charge_settings(organization_id,branch_id,source_charge_id,name,charge_type,calculation_type,value,enabled,sort_order)
      select c.organization_id,p_branch_id,c.id,c.name,c.charge_type,c.calculation_type,c.value,c.enabled,c.sort_order
      from public.restaurant_charge_settings c
      where c.organization_id=v_org and c.branch_id is null
        and not exists(select 1 from public.restaurant_charge_settings x where x.branch_id=p_branch_id and x.source_charge_id=c.id);
      update public.restaurant_charge_settings set name=left(trim(p_name),80),charge_type=upper(trim(p_charge_type)),calculation_type=upper(trim(p_calculation_type)),value=round(p_value,2),enabled=coalesce(p_enabled,true),sort_order=p_sort_order,updated_at=now()
      where branch_id=p_branch_id and source_charge_id=p_id returning * into v_row;
      if v_row.id is null then raise exception 'Branch charge clone not found'; end if;
      return v_row;
    end if;
    update public.restaurant_charge_settings set name=left(trim(p_name),80),charge_type=upper(trim(p_charge_type)),calculation_type=upper(trim(p_calculation_type)),value=round(p_value,2),enabled=coalesce(p_enabled,true),sort_order=p_sort_order,updated_at=now()
    where id=p_id and organization_id=v_org and ((p_branch_id is null and branch_id is null) or branch_id=p_branch_id) returning * into v_row;
    if v_row.id is null then raise exception 'Charge not found' using errcode='P0002'; end if;
  else
    if p_branch_id is not null then
      insert into public.restaurant_charge_settings(organization_id,branch_id,source_charge_id,name,charge_type,calculation_type,value,enabled,sort_order)
      select c.organization_id,p_branch_id,c.id,c.name,c.charge_type,c.calculation_type,c.value,c.enabled,c.sort_order
      from public.restaurant_charge_settings c
      where c.organization_id=v_org and c.branch_id is null
        and not exists(select 1 from public.restaurant_charge_settings x where x.branch_id=p_branch_id and x.source_charge_id=c.id);
    end if;
    insert into public.restaurant_charge_settings(organization_id,branch_id,name,charge_type,calculation_type,value,enabled,sort_order)
    values(v_org,p_branch_id,left(trim(p_name),80),upper(trim(p_charge_type)),upper(trim(p_calculation_type)),round(p_value,2),coalesce(p_enabled,true),p_sort_order)
    returning * into v_row;
  end if;
  return v_row;
end;$$;
grant execute on function public.upsert_restaurant_charge_setting(uuid,text,text,text,numeric,boolean,integer,uuid) to authenticated;
revoke execute on function public.upsert_restaurant_charge_setting(uuid,text,text,text,numeric,boolean,integer,uuid) from anon,public;

drop function if exists public.delete_restaurant_charge_setting(uuid);
create function public.delete_restaurant_charge_setting(p_id uuid,p_branch_id uuid default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_existing public.restaurant_charge_settings%rowtype;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true order by case when s.role='OWNER'::public.staff_role then 0 when s.role='MANAGER'::public.staff_role then 1 else 2 end,s.created_at limit 1;
  if v_org is null then raise exception 'Restaurant access required' using errcode='42501'; end if;
  select * into v_existing from public.restaurant_charge_settings c where c.id=p_id and c.organization_id=v_org;
  if v_existing.id is null then raise exception 'Charge not found' using errcode='P0002'; end if;
  if p_branch_id is null then
    if not public.is_org_owner(v_org) or v_existing.branch_id is not null then raise exception 'Owner access required' using errcode='42501'; end if;
    delete from public.restaurant_charge_settings where id=p_id;
  else
    if not public.current_user_has_permission_for_branch(p_branch_id,'CHARGES') then raise exception 'Charge management permission required' using errcode='42501'; end if;
    if not exists(select 1 from public.branches b where b.id=p_branch_id and b.organization_id=v_org) then raise exception 'Branch does not belong to this organization' using errcode='42501'; end if;
    if v_existing.branch_id is null then
      insert into public.restaurant_charge_settings(organization_id,branch_id,source_charge_id,name,charge_type,calculation_type,value,enabled,sort_order)
      select c.organization_id,p_branch_id,c.id,c.name,c.charge_type,c.calculation_type,c.value,c.enabled,c.sort_order
      from public.restaurant_charge_settings c
      where c.organization_id=v_org and c.branch_id is null
        and not exists(select 1 from public.restaurant_charge_settings x where x.branch_id=p_branch_id and x.source_charge_id=c.id);
      delete from public.restaurant_charge_settings where organization_id=v_org and branch_id=p_branch_id and source_charge_id=p_id;
    elsif v_existing.branch_id=p_branch_id then
      delete from public.restaurant_charge_settings where id=p_id and branch_id=p_branch_id;
    else
      raise exception 'Charge belongs to another branch' using errcode='42501';
    end if;
  end if;
end;$$;
grant execute on function public.delete_restaurant_charge_setting(uuid,uuid) to authenticated;
revoke execute on function public.delete_restaurant_charge_setting(uuid,uuid) from anon,public;

-- Effective public charges: branch-specific configuration wins completely when
-- at least one branch row exists; otherwise existing org defaults are used.
create or replace function public.get_public_checkout_charges(p_table_code text)
returns table(name text,charge_type text,calculation_type text,value numeric)
language sql security definer stable set search_path=public as $$
  select c.name,c.charge_type,c.calculation_type,c.value
  from public.tables t
  join public.branches b on b.id=t.branch_id
  join public.organizations o on o.id=b.organization_id
  join public.restaurant_charge_settings c on c.organization_id=o.id and c.enabled=true
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
    and (
      c.branch_id=b.id
      or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=o.id and cb.branch_id=b.id))
    )
  order by c.sort_order,c.created_at;
$$;
revoke execute on function public.get_public_checkout_charges(text) from public;
grant execute on function public.get_public_checkout_charges(text) to anon,authenticated;

-- ---------------------------------------------------------------------------
-- 2) Branch-specific payment overrides
-- ---------------------------------------------------------------------------
create table if not exists public.restaurant_branch_payment_settings (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  razorpay_key_id text,
  razorpay_key_secret_encrypted text,
  razorpay_webhook_secret_encrypted text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists restaurant_branch_payment_settings_org_idx
  on public.restaurant_branch_payment_settings(organization_id);

alter table public.restaurant_branch_payment_settings enable row level security;
revoke all on public.restaurant_branch_payment_settings from anon;
revoke all on public.restaurant_branch_payment_settings from authenticated;
drop policy if exists restaurant_branch_payment_settings_select on public.restaurant_branch_payment_settings;
drop policy if exists restaurant_branch_payment_settings_insert on public.restaurant_branch_payment_settings;
drop policy if exists restaurant_branch_payment_settings_update on public.restaurant_branch_payment_settings;
drop policy if exists restaurant_branch_payment_settings_delete on public.restaurant_branch_payment_settings;
create policy restaurant_branch_payment_settings_select on public.restaurant_branch_payment_settings
for select to authenticated
using (public.is_org_owner(organization_id) or public.current_user_has_permission_for_branch(branch_id,'PAYMENTS'));
create policy restaurant_branch_payment_settings_insert on public.restaurant_branch_payment_settings
for insert to authenticated
with check (
  (public.is_org_owner(organization_id) or public.current_user_has_permission_for_branch(branch_id,'PAYMENTS'))
  and exists(select 1 from public.branches b where b.id=branch_id and b.organization_id=restaurant_branch_payment_settings.organization_id)
);
create policy restaurant_branch_payment_settings_update on public.restaurant_branch_payment_settings
for update to authenticated
using (public.is_org_owner(organization_id) or public.current_user_has_permission_for_branch(branch_id,'PAYMENTS'))
with check (
  (public.is_org_owner(organization_id) or public.current_user_has_permission_for_branch(branch_id,'PAYMENTS'))
  and exists(select 1 from public.branches b where b.id=branch_id and b.organization_id=restaurant_branch_payment_settings.organization_id)
);
create policy restaurant_branch_payment_settings_delete on public.restaurant_branch_payment_settings
for delete to authenticated
using (public.is_org_owner(organization_id) or public.current_user_has_permission_for_branch(branch_id,'PAYMENTS'));

revoke all on public.restaurant_branch_payment_settings from anon,authenticated;
-- Branch payment rows contain encrypted provider secrets. Keep direct table access
-- closed; the server-side settings API performs authorization and never returns secrets.


drop trigger if exists restaurant_branch_payment_settings_touch_updated_at on public.restaurant_branch_payment_settings;
create trigger restaurant_branch_payment_settings_touch_updated_at
before update on public.restaurant_branch_payment_settings
for each row execute function public.touch_updated_at();

-- Public payment visibility resolves branch override first and organization
-- default second. No secrets are ever returned.
create or replace function public.get_public_payment_options(p_table_code text)
returns table(online_payment_enabled boolean, plan_id text)
language sql security definer stable set search_path=public as $$
  select
    (
      public.organization_has_feature(o.id,'ONLINE_PAYMENTS')
      and coalesce(rbps.enabled,rps.enabled,false)
    ) as online_payment_enabled,
    os.plan_id
  from public.tables t
  join public.branches b on b.id=t.branch_id
  join public.organizations o on o.id=b.organization_id
  left join public.organization_subscriptions os on os.organization_id=o.id
  left join public.restaurant_branch_payment_settings rbps on rbps.branch_id=b.id
  left join public.restaurant_payment_settings rps on rps.organization_id=o.id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
  limit 1;
$$;
revoke execute on function public.get_public_payment_options(text) from public;
grant execute on function public.get_public_payment_options(text) to anon,authenticated;

-- Enforce the branch-specific payment toggle as well as the plan entitlement
-- when an order attempts PAY_NOW.
create or replace function public.enforce_online_payment_choice()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_allowed boolean;
begin
  if NEW.payment_method='PAY_NOW' then
    select (
      public.organization_has_feature(o.id,'ONLINE_PAYMENTS')
      and coalesce(rbps.enabled,rps.enabled,false)
    ) into v_allowed
    from public.branches b
    join public.organizations o on o.id=b.organization_id
    left join public.restaurant_branch_payment_settings rbps on rbps.branch_id=b.id
    left join public.restaurant_payment_settings rps on rps.organization_id=o.id
    where b.id=NEW.branch_id;
    if not coalesce(v_allowed,false) then raise exception 'Online payment is not enabled for this branch and Tablely plan' using errcode='42501'; end if;
  end if;
  return NEW;
end;$$;

-- ---------------------------------------------------------------------------
-- 3) Reload modified checkout order function with branch-effective charges
-- ---------------------------------------------------------------------------
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

commit;
select pg_notify('pgrst','reload schema');
