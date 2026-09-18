-- Owner-only, irreversible restaurant deletion.
--
-- Confirmation-by-typed-name is enforced here as well as in the UI: the
-- caller must pass the organization's current name back verbatim as
-- p_confirm_name. This is defense-in-depth against any future caller that
-- doesn't reuse the settings UI (e.g. a script, or a future admin tool).
--
-- coupon_usages is the only table with ON DELETE RESTRICT anywhere in the
-- ownership chain (via coupon_id/order_id/branch_id/organization_id), so it
-- is cleared explicitly first. Every other table referencing organizations
-- or branches uses ON DELETE CASCADE and is removed automatically once the
-- organizations row is deleted.
create or replace function public.delete_restaurant_for_current_user(
  p_confirm_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_org public.organizations%rowtype;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select *
  into v_org
  from public.organizations
  where owner_id = v_user_id
  for update;

  if v_org.id is null then
    raise exception 'No restaurant workspace found for this account';
  end if;

  if p_confirm_name is null or trim(p_confirm_name) <> v_org.name then
    raise exception 'Confirmation text does not match the restaurant name' using errcode = '22023';
  end if;

  delete from public.coupon_usages where organization_id = v_org.id;

  delete from public.organizations where id = v_org.id;
end;
$$;

revoke all on function public.delete_restaurant_for_current_user(text) from public, anon;
grant execute on function public.delete_restaurant_for_current_user(text) to authenticated;
