-- Sellora Build 1 + 2: categories, canonical creator plan entitlements, and product/category integrity.
-- Safe/idempotent migration. Run after 006_build_11_12.sql.

create table if not exists public.creator_plans (
  creator_id uuid primary key references public.profiles(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','creator','pro','max')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_categories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  image_path text,
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, slug)
);

alter table public.products add column if not exists category_id uuid references public.store_categories(id) on delete restrict;
alter table public.products add column if not exists sort_order integer not null default 0;

-- Give existing stores a deterministic category, then migrate the legacy category text.
insert into public.store_categories (store_id, name, slug, sort_order)
select s.id, 'Products', 'products', 0
from public.stores s
where not exists (select 1 from public.store_categories c where c.store_id = s.id);

with legacy as (
  select p.id, p.store_id, lower(regexp_replace(coalesce(nullif(trim(p.category), ''), 'Products'), '[^a-z0-9]+', '-', 'g')) as base_slug,
         coalesce(nullif(trim(p.category), ''), 'Products') as category_name
  from public.products p
  where p.category_id is null
),
needed as (
  select distinct store_id, category_name, nullif(trim(both '-' from base_slug), '') as base_slug
  from legacy
)
insert into public.store_categories (store_id, name, slug, sort_order)
select n.store_id, n.category_name,
       coalesce(n.base_slug, 'products'),
       coalesce((select max(c.sort_order)+1 from public.store_categories c where c.store_id=n.store_id), 0)
from needed n
where not exists (
  select 1 from public.store_categories c
  where c.store_id=n.store_id and lower(c.name)=lower(n.category_name)
);

update public.products p
set category_id = c.id,
    category = c.name
from public.store_categories c
where c.store_id=p.store_id
  and p.category_id is null
  and lower(c.name)=lower(coalesce(nullif(trim(p.category), ''), 'Products'));

create index if not exists store_categories_store_sort_idx
  on public.store_categories(store_id, sort_order, created_at);
create index if not exists products_store_category_sort_idx
  on public.products(store_id, category_id, sort_order, created_at desc);
create index if not exists products_category_idx on public.products(category_id);

alter table public.creator_plans enable row level security;
alter table public.store_categories enable row level security;

drop policy if exists "creator read own plan" on public.creator_plans;
create policy "creator read own plan" on public.creator_plans
for select to authenticated using (creator_id = auth.uid());

drop policy if exists "owners manage categories" on public.store_categories;
create policy "owners manage categories" on public.store_categories
for all to authenticated
using (exists (select 1 from public.stores s where s.id=store_categories.store_id and s.owner_id=auth.uid()))
with check (exists (select 1 from public.stores s where s.id=store_categories.store_id and s.owner_id=auth.uid()));

drop policy if exists "public can read visible categories" on public.store_categories;
create policy "public can read visible categories" on public.store_categories
for select to anon, authenticated
using (
  is_visible = true
  and exists (
    select 1 from public.stores s
    where s.id=store_categories.store_id and s.status='active'
  )
);

-- Ensure every creator has a canonical plan row. Existing creators default to Free until Build 4 billing changes it.
insert into public.creator_plans (creator_id, plan)
select p.id, 'free'
from public.profiles p
where not exists (select 1 from public.creator_plans cp where cp.creator_id=p.id);

create or replace function public.sellora_plan_limits(p_plan text)
returns table(max_products bigint, max_categories bigint)
language sql immutable as $$
  select
    case p_plan
      when 'free' then 1
      when 'creator' then 10
      when 'pro' then 9223372036854775807
      when 'max' then 9223372036854775807
      else 1
    end,
    case p_plan
      when 'free' then 1
      when 'creator' then 2
      when 'pro' then 10
      when 'max' then 9223372036854775807
      else 1
    end;
$$;

create or replace function public.sellora_check_store_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_product_count bigint;
  v_category_count bigint;
  v_store_id uuid;
begin
  if tg_table_name = 'products' then
    v_store_id := coalesce(new.store_id, old.store_id);
  else
    v_store_id := coalesce(new.store_id, old.store_id);
  end if;

  select owner_id into v_owner from public.stores where id=v_store_id;
  if v_owner is null then
    raise exception using errcode='23503', message='STORE_NOT_FOUND';
  end if;

  select plan into v_plan from public.creator_plans where creator_id=v_owner;
  v_plan := coalesce(v_plan, 'free');
  select max_products, max_categories into v_max_products, v_max_categories from public.sellora_plan_limits(v_plan);

  if tg_table_name = 'products' then
    if tg_op='INSERT' then
      if new.category_id is null then
        raise exception using errcode='23514', message='CATEGORY_REQUIRED';
      end if;
      if not exists (select 1 from public.store_categories c where c.id=new.category_id and c.store_id=v_store_id) then
        raise exception using errcode='23514', message='INVALID_CATEGORY';
      end if;
      select count(*) into v_product_count from public.products where store_id=v_store_id;
      if v_product_count >= v_max_products then
        raise exception using errcode='42501', message='PRODUCT_LIMIT_REACHED';
      end if;
    elsif tg_op='UPDATE' then
      if new.category_id is null then
        raise exception using errcode='23514', message='CATEGORY_REQUIRED';
      end if;
      if not exists (select 1 from public.store_categories c where c.id=new.category_id and c.store_id=new.store_id) then
        raise exception using errcode='23514', message='INVALID_CATEGORY';
      end if;
      if new.store_id <> old.store_id then
        raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED';
      end if;
    end if;
  else
    if tg_op='INSERT' then
      select count(*) into v_category_count from public.store_categories where store_id=v_store_id;
      if v_category_count >= v_max_categories then
        raise exception using errcode='42501', message='CATEGORY_LIMIT_REACHED';
      end if;
    elsif tg_op='UPDATE' then
      if new.store_id <> old.store_id then
        raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED';
      end if;
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_products_entitlements on public.products;
create trigger trg_products_entitlements
before insert or update of store_id, category_id on public.products
for each row execute function public.sellora_check_store_entitlements();

drop trigger if exists trg_categories_entitlements on public.store_categories;
create trigger trg_categories_entitlements
before insert or update of store_id on public.store_categories
for each row execute function public.sellora_check_store_entitlements();

-- Recreate product policies so owners can continue managing category-linked products while public access stays restricted.
drop policy if exists "public can read live public products" on public.products;
create policy "public can read live public products" on public.products
for select to anon, authenticated
using (
  status='live'
  and visibility='public'
  and exists (
    select 1 from public.stores s
    where s.id=products.store_id and s.status='active'
  )
);

-- Product owner policy remains canonical from the base schema. Explicit grants for the new tables.
grant select on public.creator_plans to authenticated;
grant select, insert, update, delete on public.store_categories to authenticated;
