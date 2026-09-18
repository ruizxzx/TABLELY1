-- Run this once in Supabase SQL Editor to fix customer Google sign-in.

begin;

alter table public.customer_profiles
  add column if not exists customer_account_enabled boolean not null default false;

create or replace function public.activate_customer_account(p_name text, p_phone text)
returns public.customer_profiles
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_profile public.customer_profiles%rowtype;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Customer authentication is required' using errcode = '42501';
  end if;

  insert into public.customer_profiles (auth_user_id, name, email, phone, customer_account_enabled)
  select v_user_id,
         nullif(left(trim(coalesce(p_name, '')), 120), ''),
         u.email,
         nullif(left(trim(coalesce(p_phone, '')), 40), ''),
         true
  from auth.users u
  where u.id = v_user_id
  on conflict (auth_user_id) do update
  set name = coalesce(nullif(left(trim(coalesce(excluded.name, '')), 120), ''), public.customer_profiles.name),
      email = coalesce(excluded.email, public.customer_profiles.email),
      phone = coalesce(nullif(left(trim(coalesce(excluded.phone, '')), 40), ''), public.customer_profiles.phone),
      customer_account_enabled = true,
      updated_at = now();

  select * into v_profile
  from public.customer_profiles
  where auth_user_id = v_user_id;

  if v_profile.id is null then
    raise exception 'Could not create customer profile';
  end if;
  return v_profile;
end;
$$;

revoke execute on function public.activate_customer_account(text, text) from anon, public;
grant execute on function public.activate_customer_account(text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
