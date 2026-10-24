-- Sellora Build 4-compatible admin creator access grants.
-- This does not implement payment-provider subscription billing. It provides secure admin-controlled
-- invitations and temporary/permanent plan entitlements that can later be superseded by real billing.

create table if not exists public.creator_access_grants (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  creator_id uuid references public.profiles(id) on delete set null,
  plan text not null default 'free' check (plan in ('free','creator','pro','max')),
  access_type text not null default 'trial' check (access_type in ('trial','complimentary','permanent')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending','active','expired','revoked')),
  note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_access_grants_email_lower check (email = lower(trim(email))),
  constraint creator_access_grants_dates check (expires_at is null or expires_at > starts_at)
);

create unique index if not exists creator_access_grants_email_active_idx
  on public.creator_access_grants(lower(email))
  where status in ('pending','active');
create index if not exists creator_access_grants_creator_idx on public.creator_access_grants(creator_id, created_at desc);
create index if not exists creator_access_grants_expires_idx on public.creator_access_grants(status, expires_at);

alter table public.creator_plans add column if not exists access_source text not null default 'subscription';
alter table public.creator_plans add column if not exists access_starts_at timestamptz not null default now();
alter table public.creator_plans add column if not exists access_expires_at timestamptz;
alter table public.creator_plans add column if not exists access_grant_id uuid references public.creator_access_grants(id) on delete set null;
alter table public.creator_plans add column if not exists updated_by uuid;

create or replace function public.sellora_effective_plan(p_creator_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when cp.access_starts_at is not null and cp.access_starts_at > now() then 'free'
    when cp.access_expires_at is not null and cp.access_expires_at <= now() then 'free'
    else coalesce(cp.plan, 'free')
  end
  from public.creator_plans cp
  where cp.creator_id = p_creator_id;
$$;

-- Make entitlement trigger use the effective plan so expired admin trials automatically fall back to Free.
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
  v_store_id := coalesce(new.store_id, old.store_id);
  select owner_id into v_owner from public.stores where id=v_store_id;
  if v_owner is null then
    raise exception using errcode='23503', message='STORE_NOT_FOUND';
  end if;

  v_plan := public.sellora_effective_plan(v_owner);
  v_plan := coalesce(v_plan, 'free');
  select max_products, max_categories into v_max_products, v_max_categories from public.sellora_plan_limits(v_plan);

  if tg_table_name = 'products' then
    if tg_op='INSERT' then
      if new.category_id is null then raise exception using errcode='23514', message='CATEGORY_REQUIRED'; end if;
      if not exists (select 1 from public.store_categories c where c.id=new.category_id and c.store_id=v_store_id) then raise exception using errcode='23514', message='INVALID_CATEGORY'; end if;
      select count(*) into v_product_count from public.products where store_id=v_store_id;
      if v_product_count >= v_max_products then raise exception using errcode='42501', message='PRODUCT_LIMIT_REACHED'; end if;
    elsif tg_op='UPDATE' then
      if new.category_id is null then raise exception using errcode='23514', message='CATEGORY_REQUIRED'; end if;
      if not exists (select 1 from public.store_categories c where c.id=new.category_id and c.store_id=new.store_id) then raise exception using errcode='23514', message='INVALID_CATEGORY'; end if;
      if new.store_id <> old.store_id then raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED'; end if;
    end if;
  else
    if tg_op='INSERT' then
      select count(*) into v_category_count from public.store_categories where store_id=v_store_id;
      if v_category_count >= v_max_categories then raise exception using errcode='42501', message='CATEGORY_LIMIT_REACHED'; end if;
    elsif tg_op='UPDATE' then
      if new.store_id <> old.store_id then raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED'; end if;
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

-- Apply pending grants automatically when an invited user is actually created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_grant public.creator_access_grants%rowtype;
  v_email text := lower(trim(coalesce(new.email, '')));
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''), '@', 1)))
  on conflict (id) do nothing;

  select * into v_grant
  from public.creator_access_grants g
  where lower(g.email)=v_email
    and g.status='pending'
  order by g.created_at desc
  limit 1;

  if found then
    update public.creator_access_grants
    set creator_id=new.id, status='active', updated_at=now()
    where id=v_grant.id;

    insert into public.creator_plans (creator_id, plan, access_source, access_starts_at, access_expires_at, access_grant_id, updated_at)
    values (new.id, v_grant.plan, v_grant.access_type, v_grant.starts_at, v_grant.expires_at, v_grant.id, now())
    on conflict (creator_id) do update
      set plan=excluded.plan,
          access_source=excluded.access_source,
          access_starts_at=excluded.access_starts_at,
          access_expires_at=excluded.access_expires_at,
          access_grant_id=excluded.access_grant_id,
          updated_at=now();
  else
    insert into public.creator_plans (creator_id, plan, access_source, access_starts_at)
    values (new.id, 'free', 'subscription', now())
    on conflict (creator_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.creator_access_grants enable row level security;
revoke all on public.creator_access_grants from anon, authenticated;
grant all on public.creator_access_grants to service_role;

-- Keep historical/expiring grant status accurate when an admin opens the list.
update public.creator_access_grants
set status='expired', updated_at=now()
where status in ('pending','active') and expires_at is not null and expires_at <= now();
