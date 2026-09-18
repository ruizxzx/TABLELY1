-- Fixes list_staff_with_email() from 202609151000_staff_email_credentials.sql:
--
-- 1) "column reference user_id is ambiguous" -- a `returns table(...)`
--    function implicitly creates a variable for every output column
--    (id, user_id, role, ...). PL/pgSQL's default variable resolution can
--    treat a qualified reference like s.user_id as ambiguous against that
--    same-named output variable. `#variable_conflict use_column` tells it
--    to always prefer the table column, which is what we want here.
--
-- 2) Old/test staff rows were disappearing from the list. The previous
--    version used an INNER JOIN to auth.users, so any staff row whose
--    user_id doesn't currently resolve to an auth user (deleted/edited
--    test accounts, etc) was silently dropped instead of just showing up
--    without an email. Switched to LEFT JOIN so every staff row for the
--    organization is always returned.

drop function if exists public.list_staff_with_email();

create or replace function public.list_staff_with_email()
returns table(
  id uuid,
  user_id uuid,
  role public.staff_role,
  active boolean,
  display_name text,
  created_at timestamptz,
  can_kitchen boolean,
  can_waiter boolean,
  branch_id uuid,
  email text
)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_actor public.staff%rowtype; v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_actor from public.staff
    where user_id = v_user and active = true and role = 'OWNER'
    order by created_at limit 1;
  if v_actor.id is null then raise exception 'Only the owner can view staff logins' using errcode = '42501'; end if;

  return query
    select s.id, s.user_id, s.role, s.active, s.display_name, s.created_at,
           s.can_kitchen, s.can_waiter, s.branch_id, au.email::text
    from public.staff s
    left join auth.users au on au.id = s.user_id
    where s.organization_id = v_actor.organization_id
    order by s.created_at;
end;
$$;
grant execute on function public.list_staff_with_email() to authenticated;
