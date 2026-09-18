begin;

-- This resolver is write-capable in older Build 22 definitions. It must never
-- remain STABLE, because PostgreSQL executes STABLE functions in a read-only
-- transaction and rejects their INSERT path.
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

  select id
  into v_id
  from public.customer_profiles
  where auth_user_id = auth.uid()
    and customer_account_enabled = true;

  return v_id;
end;
$$;

revoke execute on function public.build22_current_customer_profile() from anon, public;
grant execute on function public.build22_current_customer_profile() to authenticated;
alter function public.build22_current_customer_profile() set search_path = public;

commit;

notify pgrst, 'reload schema';
