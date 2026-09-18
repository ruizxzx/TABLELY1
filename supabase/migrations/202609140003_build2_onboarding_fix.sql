-- TABLELY BUILD 2 — COMPLETE, IDEMPOTENT SUPABASE SETUP
-- Run this entire file in Supabase SQL Editor.
-- It works for both a fresh project and a project that already has Build 1 tables.

create extension if not exists pgcrypto;

do $$ begin
  create type public.staff_role as enum ('OWNER', 'MANAGER', 'WAITER', 'KITCHEN');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.account_status as enum ('ACTIVE', 'SUSPENDED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.order_status as enum ('NEW','ACCEPTED','PREPARING','READY','SERVED','COMPLETED','CANCELLED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_status as enum ('PENDING','PAID','FAILED','REFUNDED');
exception when duplicate_object then null; end $$;

-- Build 1 baseline tables. IF NOT EXISTS makes this safe when they already exist.
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null default 'Main Branch',
  address text,
  created_at timestamptz not null default now()
);

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  role public.staff_role not null default 'WAITER',
  created_at timestamptz not null default now(),
  unique (user_id, organization_id, branch_id)
);

create table if not exists public.tables (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_number integer not null,
  table_code text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (branch_id, table_number)
);

create table if not exists public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (branch_id, name)
);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  category_id uuid references public.menu_categories(id) on delete set null,
  name text not null,
  description text,
  price numeric(12,2) not null default 0 check (price >= 0),
  image_url text,
  is_available boolean not null default true,
  is_veg boolean,
  preparation_minutes integer,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  table_id uuid not null references public.tables(id) on delete restrict,
  status public.order_status not null default 'NEW',
  payment_status public.payment_status not null default 'PENDING',
  payment_method text,
  total numeric(12,2) not null default 0 check (total >= 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (branch_id, idempotency_key)
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  menu_item_id uuid not null references public.menu_items(id) on delete restrict,
  item_name_snapshot text not null,
  unit_price numeric(12,2) not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0 and quantity <= 50),
  line_total numeric(12,2) generated always as (unit_price * quantity) stored
);

-- Build 2 additions for existing Build 1 tables.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organizations
  add column if not exists status public.account_status not null default 'ACTIVE';
alter table public.organizations
  add column if not exists updated_at timestamptz not null default now();
alter table public.branches
  add column if not exists phone text;
alter table public.branches
  add column if not exists updated_at timestamptz not null default now();
alter table public.staff
  add column if not exists updated_at timestamptz not null default now();

-- Ensure profile table's columns exist even when the table was present already.
alter table public.profiles
  add column if not exists full_name text;
alter table public.profiles
  add column if not exists phone text;
alter table public.profiles
  add column if not exists created_at timestamptz not null default now();
alter table public.profiles
  add column if not exists updated_at timestamptz not null default now();

create index if not exists branches_organization_id_idx on public.branches(organization_id);
create index if not exists staff_user_id_idx on public.staff(user_id);
create index if not exists staff_organization_id_idx on public.staff(organization_id);
create index if not exists staff_branch_id_idx on public.staff(branch_id);
create index if not exists tables_branch_id_idx on public.tables(branch_id);
create index if not exists menu_items_branch_id_idx on public.menu_items(branch_id);
create index if not exists orders_branch_created_at_idx on public.orders(branch_id, created_at desc);
create index if not exists order_items_order_id_idx on public.order_items(order_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at before update on public.organizations for each row execute function public.set_updated_at();
drop trigger if exists branches_set_updated_at on public.branches;
create trigger branches_set_updated_at before update on public.branches for each row execute function public.set_updated_at();
drop trigger if exists staff_set_updated_at on public.staff;
create trigger staff_set_updated_at before update on public.staff for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '')
  )
  on conflict (id) do update
  set full_name = excluded.full_name,
      phone = excluded.phone,
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff s
    where s.organization_id = org_id and s.user_id = auth.uid()
  )
  or exists (
    select 1 from public.organizations o
    where o.id = org_id and o.owner_id = auth.uid()
  );
$$;

create or replace function public.is_org_owner(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organizations o
    where o.id = target_org and o.owner_id = auth.uid()
  );
$$;

create or replace function public.is_branch_member(target_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff s
    where s.branch_id = target_branch and s.user_id = auth.uid()
  );
$$;

create or replace function public.create_restaurant_for_current_user(
  p_name text,
  p_address text,
  p_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_branch_id uuid;
  v_base_slug text;
  v_final_slug text;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'Restaurant name must be at least 2 characters';
  end if;
  if char_length(trim(coalesce(p_address, ''))) < 2 then
    raise exception 'Restaurant address must be at least 2 characters';
  end if;
  if exists (select 1 from public.organizations where owner_id = v_user_id) then
    raise exception 'Restaurant workspace already exists for this account';
  end if;

  v_base_slug := lower(trim(regexp_replace(coalesce(p_name, 'restaurant'), '[^a-zA-Z0-9]+', '-', 'g')));
  v_base_slug := trim(both '-' from v_base_slug);
  if v_base_slug = '' then v_base_slug := 'restaurant'; end if;
  v_base_slug := left(v_base_slug, 60);
  v_final_slug := v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.organizations (owner_id, name, slug)
  values (v_user_id, trim(p_name), v_final_slug)
  returning id into v_org_id;

  insert into public.branches (organization_id, name, address, phone)
  values (v_org_id, 'Main Branch', trim(p_address), nullif(trim(coalesce(p_phone, '')), ''))
  returning id into v_branch_id;

  insert into public.staff (user_id, organization_id, branch_id, role)
  values (v_user_id, v_org_id, v_branch_id, 'OWNER');

  return v_org_id;
exception
  when unique_violation then
    raise exception 'A restaurant workspace already exists for this account or a unique value conflicted';
end;
$$;

-- Explicit browser role permissions. RLS remains the tenant security boundary.
grant usage on schema public to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.branches to authenticated;
grant select, insert, update, delete on public.staff to authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_org_owner(uuid) to authenticated;
grant execute on function public.is_branch_member(uuid) to authenticated;
grant execute on function public.create_restaurant_for_current_user(text, text, text) to authenticated;

-- RLS.
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.branches enable row level security;
alter table public.staff enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using (id = auth.uid());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists organizations_select_member on public.organizations;
create policy organizations_select_member on public.organizations for select using (owner_id = auth.uid() or public.is_org_member(id));
drop policy if exists organizations_insert_owner on public.organizations;
create policy organizations_insert_owner on public.organizations for insert with check (owner_id = auth.uid());
drop policy if exists organizations_update_owner on public.organizations;
create policy organizations_update_owner on public.organizations for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists organizations_delete_owner on public.organizations;
create policy organizations_delete_owner on public.organizations for delete using (owner_id = auth.uid());

drop policy if exists branches_select_member on public.branches;
create policy branches_select_member on public.branches for select using (public.is_org_member(organization_id) or public.is_org_owner(organization_id));
drop policy if exists branches_insert_owner on public.branches;
create policy branches_insert_owner on public.branches for insert with check (public.is_org_owner(organization_id));
drop policy if exists branches_update_owner on public.branches;
create policy branches_update_owner on public.branches for update using (public.is_org_owner(organization_id)) with check (public.is_org_owner(organization_id));
drop policy if exists branches_delete_owner on public.branches;
create policy branches_delete_owner on public.branches for delete using (public.is_org_owner(organization_id));

drop policy if exists staff_select_member on public.staff;
create policy staff_select_member on public.staff for select using (user_id = auth.uid() or public.is_org_member(organization_id) or public.is_org_owner(organization_id));
drop policy if exists staff_insert_owner on public.staff;
create policy staff_insert_owner on public.staff for insert with check (public.is_org_owner(organization_id));
drop policy if exists staff_update_owner on public.staff;
create policy staff_update_owner on public.staff for update using (public.is_org_owner(organization_id)) with check (public.is_org_owner(organization_id));
drop policy if exists staff_delete_owner on public.staff;
create policy staff_delete_owner on public.staff for delete using (public.is_org_owner(organization_id));

revoke all on public.profiles, public.organizations, public.branches, public.staff from anon;
revoke execute on function public.create_restaurant_for_current_user(text, text, text) from anon;

-- Refresh PostgREST's schema cache so the new RPC is callable immediately.
select pg_notify('pgrst', 'reload schema');

-- Verification: should return the function signature and TRUE.
select to_regprocedure('public.create_restaurant_for_current_user(text,text,text)') as onboarding_function;
select has_function_privilege('authenticated', 'public.create_restaurant_for_current_user(text,text,text)', 'EXECUTE') as authenticated_can_execute;
