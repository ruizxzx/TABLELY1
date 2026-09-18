-- TABLELY: staff invitation delivery fallback fix.
-- Safe to run on an existing Build 10 database.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  email text not null,
  role public.staff_role not null check (role in ('MANAGER','WAITER','KITCHEN')),
  token_hash text not null unique,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists staff_invitations_branch_idx on public.staff_invitations(branch_id, created_at desc);
create index if not exists staff_invitations_email_idx on public.staff_invitations(lower(email));

alter table public.staff_invitations enable row level security;
revoke all on public.staff_invitations from anon, authenticated;
grant select, insert on public.staff_invitations to authenticated;

drop policy if exists staff_invitations_owner_select on public.staff_invitations;
create policy staff_invitations_owner_select on public.staff_invitations
  for select to authenticated
  using (
    exists (
      select 1
      from public.staff as actor
      where actor.user_id = auth.uid()
        and actor.organization_id = staff_invitations.organization_id
        and actor.role = 'OWNER'
        and actor.active = true
    )
  );

drop policy if exists staff_invitations_owner_insert on public.staff_invitations;
create policy staff_invitations_owner_insert on public.staff_invitations
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.staff as actor
      where actor.user_id = auth.uid()
        and actor.organization_id = staff_invitations.organization_id
        and actor.role = 'OWNER'
        and actor.active = true
    )
  );

create or replace function public.create_staff_invitation(
  p_branch_id uuid,
  p_email text,
  p_role public.staff_role
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor public.staff%rowtype;
  v_branch public.branches%rowtype;
  v_token text;
  v_row public.staff_invitations%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select s.*
    into v_actor
  from public.staff as s
  where s.user_id = auth.uid()
    and s.active = true
    and s.role = 'OWNER'
  order by s.created_at
  limit 1;

  if v_actor.id is null then
    raise exception 'Only the owner can invite staff' using errcode = '42501';
  end if;

  select b.*
    into v_branch
  from public.branches as b
  where b.id = p_branch_id
    and b.organization_id = v_actor.organization_id;

  if v_branch.id is null then
    raise exception 'Invalid branch' using errcode = '42501';
  end if;

  if p_role not in ('MANAGER','WAITER','KITCHEN') then
    raise exception 'Invalid staff role';
  end if;

  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Invalid email address';
  end if;

  if exists (
    select 1
    from public.staff as existing_staff
    join auth.users as auth_user on auth_user.id = existing_staff.user_id
    where existing_staff.organization_id = v_actor.organization_id
      and existing_staff.active = true
      and lower(coalesce(auth_user.email, '')) = v_email
  ) then
    raise exception 'A staff member with this email is already active';
  end if;

  -- Reuse one pending invitation for the same branch/email instead of creating duplicates.
  update public.staff_invitations
     set role = p_role,
         expires_at = greatest(expires_at, now() + interval '7 days')
   where branch_id = v_branch.id
     and lower(email) = v_email
     and accepted_at is null
     and expires_at > now();

  select *
    into v_row
  from public.staff_invitations as pending
  where pending.branch_id = v_branch.id
    and lower(pending.email) = v_email
    and pending.accepted_at is null
    and pending.expires_at > now()
  order by pending.created_at desc
  limit 1;

  if v_row.id is not null then
    v_token := encode(extensions.gen_random_bytes(24), 'hex');
    update public.staff_invitations
       set token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex')
     where id = v_row.id
    returning * into v_row;
  else
    v_token := encode(extensions.gen_random_bytes(24), 'hex');
    insert into public.staff_invitations(
      organization_id, branch_id, email, role, token_hash, created_by
    )
    values(
      v_actor.organization_id,
      v_branch.id,
      v_email,
      p_role,
      encode(extensions.digest(v_token, 'sha256'), 'hex'),
      auth.uid()
    )
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'email', v_row.email,
    'role', v_row.role,
    'expires_at', v_row.expires_at,
    'token', v_token
  );
end;
$$;

grant execute on function public.create_staff_invitation(uuid, text, public.staff_role) to authenticated;

notify pgrst, 'reload schema';
