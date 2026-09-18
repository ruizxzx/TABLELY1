-- Security hardening: get_user_id_by_email was security definer and granted
-- to every authenticated user with no authorization check, so any logged-in
-- staff member (even a Waiter) could probe arbitrary email addresses and
-- learn whether they have a Tablely account plus their internal user id.
--
-- This restricts it to callers who are an active OWNER, or a Branch Manager
-- with STAFF_MANAGEMENT on their own branch -- i.e. only people who are
-- already allowed to look up/invite staff by email in the app.

create or replace function public.get_user_id_by_email(p_email text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.staff s
    where s.user_id = auth.uid()
      and s.active = true
      and (
        s.role = 'OWNER'
        or public.is_branch_manager_with_permission(s.branch_id, 'STAFF_MANAGEMENT')
      )
  ) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select id into v_uid
  from auth.users
  where lower(email) = lower(trim(coalesce(p_email, '')))
  limit 1;

  return v_uid;
end;
$$;

grant execute on function public.get_user_id_by_email(text) to authenticated;

select pg_notify('pgrst','reload schema');
