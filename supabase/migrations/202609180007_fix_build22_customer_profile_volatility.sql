-- TABLELY — FIX CUSTOMER PROFILE RESOLUTION VOLATILITY
--
-- build22_current_customer_profile() creates the authenticated customer's
-- profile on first use. PostgreSQL write-capable functions must be VOLATILE;
-- the previous STABLE declaration caused Pay-Later checkout to fail with:
-- "INSERT is not allowed in a non-volatile function".

begin;

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

  insert into public.customer_profiles(auth_user_id, email)
  select auth.uid(), email
  from auth.users
  where id = auth.uid()
  on conflict (auth_user_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id
    into v_id
    from public.customer_profiles
    where auth_user_id = auth.uid();
  end if;

  return v_id;
end;
$$;

revoke execute on function public.build22_current_customer_profile() from anon, public;
grant execute on function public.build22_current_customer_profile() to authenticated;
alter function public.build22_current_customer_profile() set search_path = public;

commit;

notify pgrst, 'reload schema';
