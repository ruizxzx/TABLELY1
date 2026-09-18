-- Tablely Build 2: authentication, organization/branch tenancy, staff roles and RLS.
-- Run this entire migration in the Supabase SQL Editor on the target project.

create extension if not exists pgcrypto;

do $$ begin
  create type public.staff_role as enum ('OWNER', 'MANAGER', 'WAITER', 'KITCHEN');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.account_status as enum ('ACTIVE', 'SUSPENDED');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  status public.account_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null default 'Main Branch',
  address text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  role public.staff_role not null default 'WAITER',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, organization_id, branch_id)
);

create index if not exists branches_organization_id_idx on public.branches(organization_id);
create index if not exists staff_user_id_idx on public.staff(user_id);
create index if not exists staff_organization_id_idx on public.staff(organization_id);
create index if not exists staff_branch_id_idx on public.staff(branch_id);

-- Generic updated_at helper.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
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

-- New auth users receive a matching profile row using safe, non-sensitive metadata fields.
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

-- SECURITY DEFINER helpers avoid recursive RLS policy checks.
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
where staff.organization_id = org_id
      and staff.user_id = auth.uid()
      and staff.role in ('OWNER', 'MANAGER', 'WAITER', 'KITCHEN')
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
    select 1 from public.organizations
    where organizations.id = target_org
      and organizations.owner_id = auth.uid()
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
    select 1
    from public.staff
    where staff.branch_id = target_branch
      and staff.user_id = auth.uid()
  );
$$;

-- Atomic onboarding operation. One authenticated owner creates organization, branch and owner staff membership.
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
  new_org_id uuid;
  new_branch_id uuid;
  base_slug text;
  final_slug text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if char_length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'Restaurant name must be at least 2 characters';
  end if;

  if exists (select 1 from public.organizations where owner_id = auth.uid()) then
    raise exception 'Restaurant workspace already exists for this account';
  end if;

  base_slug := lower(trim(regexp_replace(coalesce(p_name, 'restaurant'), '[^a-zA-Z0-9]+', '-', 'g')));
  base_slug := trim(both '-' from base_slug);
  if base_slug = '' then base_slug := 'restaurant'; end if;
  final_slug := left(base_slug, 65) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  insert into public.organizations (owner_id, name, slug)
  values (auth.uid(), trim(p_name), final_slug)
  returning id into new_org_id;

  insert into public.branches (organization_id, name, address, phone)
  values (new_org_id, 'Main Branch', nullif(trim(p_address), ''), nullif(trim(coalesce(p_phone, '')), ''))
  returning id into new_branch_id;

  insert into public.staff (user_id, organization_id, branch_id, role)
  values (auth.uid(), new_org_id, new_branch_id, 'OWNER');

  return new_org_id;
exception
  when unique_violation then
    raise exception 'A restaurant workspace already exists for this account or slug conflict occurred';
end;
$$;

grant execute on function public.create_restaurant_for_current_user(text, text, text) to authenticated;
revoke execute on function public.create_restaurant_for_current_user(text, text, text) from anon;
revoke execute on function public.create_restaurant_for_current_user(text, text, text) from public;
revoke execute on function public.is_org_member(uuid) from anon, public;
revoke execute on function public.is_org_owner(uuid) from anon, public;
revoke execute on function public.is_branch_member(uuid) from anon, public;
revoke execute on function public.set_updated_at() from anon, public;
revoke execute on function public.handle_new_user() from anon, public;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.branches enable row level security;
alter table public.staff enable row level security;

-- profiles
 drop policy if exists profiles_select_own on public.profiles;
 create policy profiles_select_own on public.profiles for select using (id = auth.uid());
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- organizations
 drop policy if exists organizations_select_member on public.organizations;
 create policy organizations_select_member on public.organizations for select using (owner_id = auth.uid() or public.is_org_member(id));
drop policy if exists organizations_insert_owner on public.organizations;
create policy organizations_insert_owner on public.organizations for insert with check (owner_id = auth.uid());
drop policy if exists organizations_update_owner on public.organizations;
create policy organizations_update_owner on public.organizations for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists organizations_delete_owner on public.organizations;
create policy organizations_delete_owner on public.organizations for delete using (owner_id = auth.uid());

-- branches
 drop policy if exists branches_select_member on public.branches;
 create policy branches_select_member on public.branches for select using (public.is_org_member(organization_id) or public.is_org_owner(organization_id));
drop policy if exists branches_insert_owner on public.branches;
create policy branches_insert_owner on public.branches for insert with check (public.is_org_owner(organization_id));
drop policy if exists branches_update_owner on public.branches;
create policy branches_update_owner on public.branches for update using (public.is_org_owner(organization_id)) with check (public.is_org_owner(organization_id));
drop policy if exists branches_delete_owner on public.branches;
create policy branches_delete_owner on public.branches for delete using (public.is_org_owner(organization_id));

-- staff
 drop policy if exists staff_select_member on public.staff;
 create policy staff_select_member on public.staff for select using (user_id = auth.uid() or public.is_org_member(organization_id) or public.is_org_owner(organization_id));
drop policy if exists staff_insert_owner on public.staff;
create policy staff_insert_owner on public.staff for insert with check (public.is_org_owner(organization_id));
drop policy if exists staff_update_owner on public.staff;
create policy staff_update_owner on public.staff for update using (public.is_org_owner(organization_id)) with check (public.is_org_owner(organization_id));
drop policy if exists staff_delete_owner on public.staff;
create policy staff_delete_owner on public.staff for delete using (public.is_org_owner(organization_id));

-- Prevent direct anonymous reads/writes from these tables.
revoke all on public.profiles, public.organizations, public.branches, public.staff from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.organizations, public.branches, public.staff to authenticated;

comment on table public.organizations is 'Top-level tenant for a restaurant owner.';
comment on table public.branches is 'Restaurant locations; V1 starts with Main Branch but schema supports multiple branches.';
comment on table public.staff is 'Organization/branch membership and role assignments.';
