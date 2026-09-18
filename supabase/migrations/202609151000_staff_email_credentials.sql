-- Staff email visibility + credential-recovery support.
--
-- Why: Supabase's built-in auth emails (invite / confirm / reset) are capped
-- at a low hourly rate on the default project config, so relying on Supabase
-- to deliver those emails is unreliable for onboarding staff. Instead, the
-- owner creates/repairs staff logins directly (service-role admin API,
-- no email sent) and shares the credentials with the staff member
-- out-of-band (WhatsApp, in person, etc). This migration only adds a safe,
-- owner-scoped way to SEE the staff member's login email; it never stores
-- or exposes a password -- passwords are only ever set (write-only) via the
-- Supabase Auth admin API, never read back from anywhere.

-- Returns each staff row for the caller's organization together with the
-- login email pulled from auth.users. Restricted to the org OWNER, since
-- app/staff/page.tsx is already an owner-only page.
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
    join auth.users au on au.id = s.user_id
    where s.organization_id = v_actor.organization_id
    order by s.created_at;
end;
$$;
grant execute on function public.list_staff_with_email() to authenticated;

-- Looks up an existing auth user id by email. Used server-side (with the
-- caller's own session, not the service role) so the admin API route can
-- tell "brand-new staff email" apart from "this person already has a
-- Tablely login somewhere" before deciding whether to create a new auth
-- user or just reset the existing one's password. Returns nothing useful
-- beyond an id -- no email/password data -- so it's safe for any
-- authenticated user to call.
create or replace function public.get_user_id_by_email(p_email text)
returns uuid
language sql stable security definer set search_path = public as $$
  select id from auth.users where lower(email) = lower(trim(coalesce(p_email, ''))) limit 1;
$$;
grant execute on function public.get_user_id_by_email(text) to authenticated;
