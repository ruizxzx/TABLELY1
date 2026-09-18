-- TABLELY — separate customer identity from restaurant identity
--
-- Customer Google sign-in creates customer_profiles only.
-- Restaurant profiles are created when restaurant onboarding completes.

begin;

drop trigger if exists on_auth_user_created on auth.users;

-- Remove profile rows that were created only by the old global auth trigger.
-- Existing restaurant owners/staff are preserved.
delete from public.profiles p
where not exists (
  select 1
  from public.organizations o
  where o.owner_id = p.id
)
and not exists (
  select 1
  from public.staff s
  where s.user_id = p.id
);

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
  v_org_id uuid;
  v_branch_id uuid;
  v_base_slug text;
  v_final_slug text;
  v_user_id uuid := auth.uid();
  v_user auth.users%rowtype;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'Restaurant name must be at least 2 characters';
  end if;
  if char_length(trim(coalesce(p_address, ''))) < 2 then
    raise exception 'Restaurant address must be at least 2 characters';
  end if;
  if exists (select 1 from public.organizations where owner_id = v_user_id) then
    raise exception 'Restaurant workspace already exists for this account';
  end if;

  select *
  into v_user
  from auth.users
  where id = v_user_id;

  insert into public.profiles (id, full_name, phone)
  values (
    v_user_id,
    nullif(trim(coalesce(v_user.raw_user_meta_data ->> 'full_name', v_user.raw_user_meta_data ->> 'name', '')), ''),
    nullif(trim(coalesce(v_user.raw_user_meta_data ->> 'phone', p_phone, '')), '')
  )
  on conflict (id) do update
  set full_name = coalesce(excluded.full_name, public.profiles.full_name),
      phone = coalesce(excluded.phone, public.profiles.phone),
      updated_at = now();

  v_base_slug := lower(trim(regexp_replace(coalesce(p_name, 'restaurant'), '[^a-zA-Z0-9]+', '-', 'g')));
  v_base_slug := trim(both '-' from v_base_slug);
  if v_base_slug = '' then v_base_slug := 'restaurant'; end if;
  v_base_slug := left(v_base_slug, 60);
  v_final_slug := v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.organizations (owner_id, name, slug)
  values (v_user_id, trim(p_name), v_final_slug)
  returning id into v_org_id;

  insert into public.branches (organization_id, name, address, phone)
  values (v_org_id, 'Main Branch', trim(p_address), nullif(trim(coalesce(p_phone, '')), ''))
  returning id into v_branch_id;

  insert into public.staff (user_id, organization_id, branch_id, role)
  values (v_user_id, v_org_id, v_branch_id, 'OWNER');

  perform public.claim_subscription_invite_for_current_user(v_org_id);
  return v_org_id;
exception
  when unique_violation then
    raise exception 'A restaurant workspace already exists for this account or a unique value conflicted';
end;
$$;

grant execute on function public.create_restaurant_for_current_user(text, text, text) to authenticated;
revoke execute on function public.create_restaurant_for_current_user(text, text, text) from anon, public;

notify pgrst, 'reload schema';

commit;
