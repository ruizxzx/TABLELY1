-- Branch-specific logo override on top of the existing organization-wide
-- default logo set in the branding studio. Resolution order everywhere a
-- restaurant logo is displayed (admin sidebar, topbar, customer menu):
--   1) the active branch's own logo, if that branch has set one
--   2) otherwise the organization's default logo (set by the main/owner
--      account in the branding studio)
--   3) otherwise no logo (callers fall back to initials/text)
-- Additive/idempotent migration.

alter table public.branches add column if not exists brand_logo_url text;
alter table public.branches add column if not exists brand_logo_path text;

-- Resolved brand logo for a branch. Exposes both the raw org/branch values
-- (so the branding studio can show "using default" vs "custom for this
-- branch") and the already-resolved logo_url for display consumers.
create or replace function public.get_effective_branch_brand(p_branch_id uuid)
returns table(
  org_logo_url text,
  org_logo_path text,
  branch_logo_url text,
  branch_logo_path text,
  logo_url text
)
language sql stable security definer set search_path = public as $$
  select o.brand_logo_url, o.brand_logo_path, b.brand_logo_url, b.brand_logo_path,
         coalesce(b.brand_logo_url, o.brand_logo_url)
  from public.branches b
  join public.organizations o on o.id = b.organization_id
  where b.id = p_branch_id and public.is_branch_member(p_branch_id);
$$;
grant execute on function public.get_effective_branch_brand(uuid) to authenticated;

-- Owner-only: set or clear this branch's logo override. Passing null/blank
-- for both clears the override, so the branch falls back to the
-- organization default logo.
create or replace function public.update_branch_logo(p_branch_id uuid, p_logo_url text, p_logo_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_row public.branches;
begin
  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null or not public.is_org_owner(v_org) then
    raise exception 'Only the organization owner can update a branch logo' using errcode = '42501';
  end if;
  if not public.organization_has_feature(v_org, 'CUSTOM_BRANDING') then
    raise exception 'Custom branding is not available on the current Tablely plan' using errcode = '42501';
  end if;
  update public.branches
    set brand_logo_url = nullif(left(trim(coalesce(p_logo_url, '')), 500), ''),
        brand_logo_path = nullif(left(trim(coalesce(p_logo_path, '')), 500), '')
    where id = p_branch_id
    returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'brand_logo_url', v_row.brand_logo_url);
end; $$;
grant execute on function public.update_branch_logo(uuid, text, text) to authenticated;

-- Customer-facing header/menu now prefers the branch's own logo before
-- falling back to the organization default.
create or replace function public.get_public_brand_profile(p_table_code text)
returns table(logo_url text, primary_color text, secondary_color text, accent_color text, customer_theme text, menu_header text)
language sql stable security definer set search_path = public as $$
  select coalesce(b.brand_logo_url, o.brand_logo_url), o.brand_primary_color, o.brand_secondary_color, o.brand_accent_color, o.customer_theme, o.brand_menu_header
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code) and t.active and b.is_active and o.status = 'ACTIVE'::public.account_status
  limit 1;
$$;
grant execute on function public.get_public_brand_profile(text) to anon, authenticated;

select pg_notify('pgrst', 'reload schema');
