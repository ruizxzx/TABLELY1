-- Fix: "column \"limits\" does not exist" when creating a new branch.
--
-- Root cause: create_organization_branch() (Build 12) called
--   select coalesce(limits->>'max_branches','0')::int into v_limit
--   from public.get_current_entitlements();
-- but get_current_entitlements() returns a single jsonb value, not a row
-- with a `limits` column — so Postgres had nothing to resolve `limits`
-- against and failed on every branch-creation attempt, on every plan.
--
-- Also restores correct "unlimited" handling: get_current_entitlements()
-- returns limits.max_branches = null for plans with no cap (e.g. PRO).
-- The old line's coalesce(...,'0') would have turned that null into 0
-- once the syntax was fixed, incorrectly blocking branch creation on
-- unlimited plans too. This version maps null -> -1, matching the
-- existing "v_limit >= 0" unlimited-bypass check further down.
-- Additive/idempotent.

create or replace function public.create_organization_branch(p_name text, p_address text default null, p_phone text default null)
returns public.branches language plpgsql security definer set search_path=public as $$
declare
  v_org uuid;
  v_limit integer;
  v_count integer;
  v_branch public.branches;
  v_entitlements jsonb;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.role='OWNER' and s.active limit 1;
  if v_org is null then raise exception 'Only the organization owner can create branches' using errcode='42501'; end if;
  if not public.organization_has_feature(v_org,'MULTI_BRANCH') then raise exception 'Multi-branch management is not available on the current Tablely plan' using errcode='42501'; end if;

  select public.get_current_entitlements() into v_entitlements;
  -- null max_branches means "no cap" on this plan -> treat as unlimited (-1).
  v_limit := coalesce((v_entitlements -> 'limits' ->> 'max_branches')::int, -1);

  select count(*) into v_count from public.branches where organization_id=v_org;
  if v_limit >= 0 and v_count >= v_limit then raise exception 'Your current plan has reached its branch limit' using errcode='42501'; end if;

  insert into public.branches(organization_id,name,address,phone)
  values(v_org,left(trim(p_name),100),nullif(left(trim(coalesce(p_address,'')),300),''),nullif(left(trim(coalesce(p_phone,'')),30),''))
  returning * into v_branch;

  return v_branch;
end; $$;
grant execute on function public.create_organization_branch(text,text,text) to authenticated;

select pg_notify('pgrst','reload schema');
