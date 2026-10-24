-- TABLELY BUILD 13.4 — fix "column reference branch_id is ambiguous"
--
-- set_owner_notification_preference() declared RETURNS TABLE(branch_id uuid,
-- enabled boolean). PL/pgSQL turns those names into implicit variables for
-- the whole function body, which collide with the real columns of
-- owner_notification_preferences. The ON CONFLICT target list below can
-- only use bare column names (no table alias is allowed there), so
-- Postgres can no longer tell whether "branch_id" means the table column
-- or the OUT-parameter variable, and raises:
--   column reference "branch_id" is ambiguous
--
-- Fix: rename the OUT parameters so they no longer shadow the table's
-- columns. This changes the function's return type, so it must be dropped
-- before being recreated (CREATE OR REPLACE cannot do this).

begin;

drop function if exists public.set_owner_notification_preference(uuid, boolean);

create function public.set_owner_notification_preference(
  p_branch_id uuid,
  p_enabled boolean
)
returns table(out_branch_id uuid, out_enabled boolean)
language plpgsql
security definer
set search_path=public
as $$
declare
  v_org_id uuid;
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'Not authenticated' using errcode='42501';
  end if;

  select b.organization_id
    into v_org_id
  from public.branches b
  join public.organizations o on o.id=b.organization_id
  where b.id=p_branch_id
    and o.owner_id=v_owner;

  if v_org_id is null then
    raise exception 'You are not the owner of this branch' using errcode='42501';
  end if;

  insert into public.owner_notification_preferences(organization_id,owner_user_id,branch_id,enabled)
  values(v_org_id,v_owner,p_branch_id,coalesce(p_enabled,false))
  on conflict (organization_id,owner_user_id,branch_id)
  do update set enabled=excluded.enabled, updated_at=now();

  return query
  select p.branch_id,p.enabled
  from public.owner_notification_preferences p
  where p.organization_id=v_org_id
    and p.owner_user_id=v_owner
    and p.branch_id=p_branch_id;
end;
$$;

revoke all on function public.set_owner_notification_preference(uuid,boolean) from public, anon;
grant execute on function public.set_owner_notification_preference(uuid,boolean) to authenticated;
alter function public.set_owner_notification_preference(uuid,boolean) set search_path=public;

notify pgrst, 'reload schema';

commit;
