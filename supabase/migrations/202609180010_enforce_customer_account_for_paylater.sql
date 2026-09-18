-- TABLELY — REQUIRE EXPLICIT CUSTOMER ACCOUNT FOR PAY-LATER

begin;

alter table public.customer_profiles
  add column if not exists customer_account_enabled boolean not null default false;

create or replace function public.build22_sync_customer_profile()
returns trigger
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  insert into public.customer_profiles(
    auth_user_id, name, email, phone, customer_account_enabled
  )
  values (
    new.id,
    nullif(left(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), 120), ''),
    new.email,
    nullif(left(trim(coalesce(new.raw_user_meta_data->>'phone', '')), 40), ''),
    coalesce((new.raw_user_meta_data->>'tablely_customer_account')::boolean, false)
  )
  on conflict (auth_user_id) do update
  set name = coalesce(excluded.name, customer_profiles.name),
      email = coalesce(excluded.email, customer_profiles.email),
      phone = coalesce(excluded.phone, customer_profiles.phone),
      customer_account_enabled =
        customer_profiles.customer_account_enabled or excluded.customer_account_enabled,
      updated_at = now();
  return new;
end;
$$;

create or replace function public.activate_customer_account(p_name text, p_phone text)
returns public.customer_profiles
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_profile public.customer_profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Customer authentication is required' using errcode = '42501';
  end if;

  insert into public.customer_profiles(
    auth_user_id, name, email, phone, customer_account_enabled
  )
  select auth.uid(), nullif(left(trim(coalesce(p_name, '')), 120), ''),
         email, nullif(left(trim(coalesce(p_phone, '')), 40), ''), true
  from auth.users
  where id = auth.uid()
  on conflict (auth_user_id) do update
  set name = coalesce(nullif(left(trim(coalesce(p_name, '')), 120), ''), customer_profiles.name),
      phone = coalesce(nullif(left(trim(coalesce(p_phone, '')), 40), ''), customer_profiles.phone),
      customer_account_enabled = true,
      updated_at = now();

  select * into v_profile
  from public.customer_profiles
  where auth_user_id = auth.uid();
  return v_profile;
end;
$$;

revoke execute on function public.activate_customer_account(text, text) from anon, public;
grant execute on function public.activate_customer_account(text, text) to authenticated;

create or replace function public.build22_current_customer_profile()
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    return null;
  end if;

  select id into v_id
  from public.customer_profiles
  where auth_user_id = auth.uid()
    and customer_account_enabled = true;
  return v_id;
end;
$$;

revoke execute on function public.build22_current_customer_profile() from anon, public;
grant execute on function public.build22_current_customer_profile() to authenticated;

create or replace function public.open_pay_later_session(
  p_table_code text,
  p_session_token text default null,
  p_device_token text default null
)
returns public.table_sessions
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_profile uuid := public.build22_current_customer_profile();
  v_session public.table_sessions%rowtype;
begin
  if v_profile is null then
    raise exception 'Customer account login/signup is required for Pay After Delivery' using errcode = '42501';
  end if;

  select t.* into v_table
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active
    and o.status = 'ACTIVE'::public.account_status;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if not public.build23_effective_pay_later_enabled(v_table.branch_id) then
    raise exception 'Pay After Delivery is not enabled for this branch' using errcode = '42501';
  end if;

  select * into v_session
  from public.table_sessions
  where table_id = v_table.id and owner_customer_id = v_profile
    and is_pay_later and status in ('ACTIVE','SETTLING')
  order by opened_at desc limit 1 for update;
  if v_session.id is not null then
    update public.table_sessions set last_seen_at=now(), updated_at=now()
    where id=v_session.id returning * into v_session;
    return v_session;
  end if;

  insert into public.table_sessions(
    branch_id, table_id, status, origin, owner_customer_id, is_pay_later, last_seen_at
  )
  values(v_table.branch_id, v_table.id, 'ACTIVE', 'CUSTOMER_SCAN', v_profile, true, now())
  returning * into v_session;
  return v_session;
end;
$$;

revoke execute on function public.open_pay_later_session(text, text, text) from anon, public;
grant execute on function public.open_pay_later_session(text, text, text) to authenticated;

commit;

notify pgrst, 'reload schema';
