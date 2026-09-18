-- TABLELY — Branding: device logo upload support
-- Adds a public storage bucket for brand assets (logo images), org-scoped
-- RLS policies mirroring the existing menu-images pattern, a column to track
-- the storage path of the current logo (so replacing it can clean up the old
-- file), and an updated branding RPC that accepts the path alongside the URL.
-- Additive/idempotent.

alter table public.organizations add column if not exists brand_logo_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-assets', 'brand-assets', true, 5242880, array['image/jpeg','image/png','image/webp','image/svg+xml'])
on conflict (id) do update set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/svg+xml'];

-- Objects are stored under `<organization_id>/logo-...`; the first path
-- segment is checked against is_org_owner, matching the menu-images
-- convention of keying storage policies off the leading folder.
drop policy if exists brand_assets_insert_owner on storage.objects;
create policy brand_assets_insert_owner on storage.objects
for insert to authenticated
with check (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] is not null
  and public.is_org_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists brand_assets_update_owner on storage.objects;
create policy brand_assets_update_owner on storage.objects
for update to authenticated
using (
  bucket_id = 'brand-assets'
  and public.is_org_owner(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'brand-assets'
  and public.is_org_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists brand_assets_delete_owner on storage.objects;
create policy brand_assets_delete_owner on storage.objects
for delete to authenticated
using (
  bucket_id = 'brand-assets'
  and public.is_org_owner(((storage.foldername(name))[1])::uuid)
);

-- Replace update_build12_branding to also persist the storage path of the
-- uploaded logo (nullable — a plain external URL has no path).
create or replace function public.update_build12_branding(
  p_org_id uuid, p_logo_url text, p_primary_color text, p_secondary_color text,
  p_accent_color text, p_customer_theme text, p_menu_header text,
  p_logo_path text default null
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_row public.organizations;
begin
  if not public.is_org_owner(p_org_id) then raise exception 'Only the organization owner can update branding' using errcode='42501'; end if;
  if not public.organization_has_feature(p_org_id,'CUSTOM_BRANDING') then raise exception 'Custom branding is not available on the current Tablely plan' using errcode='42501'; end if;
  if p_primary_color !~ '^#[0-9A-Fa-f]{6}$' or p_secondary_color !~ '^#[0-9A-Fa-f]{6}$' or p_accent_color !~ '^#[0-9A-Fa-f]{6}$' then raise exception 'Colors must be six-digit hex values'; end if;
  if p_customer_theme not in ('minimal','warm','bold') then raise exception 'Unsupported customer theme'; end if;
  update public.organizations set
    brand_logo_url = nullif(left(trim(coalesce(p_logo_url,'')),500),''),
    brand_logo_path = nullif(left(trim(coalesce(p_logo_path,'')),500),''),
    brand_primary_color = lower(p_primary_color),
    brand_secondary_color = lower(p_secondary_color),
    brand_accent_color = lower(p_accent_color),
    customer_theme = p_customer_theme,
    brand_menu_header = nullif(left(trim(coalesce(p_menu_header,'')),140),'')
  where id = p_org_id returning * into v_row;
  return jsonb_build_object('id',v_row.id,'updated_at',v_row.updated_at);
end; $$;
grant execute on function public.update_build12_branding(uuid,text,text,text,text,text,text,text) to authenticated;

-- get_brand_profile / get_public_brand_profile now also expose the path so
-- the studio can offer "remove logo" without guessing the storage key.
create or replace function public.get_brand_profile(p_org_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object(
   'name',o.name,'slug',o.slug,'logo_url',o.brand_logo_url,'logo_path',o.brand_logo_path,
   'primary_color',o.brand_primary_color,'secondary_color',o.brand_secondary_color,
   'accent_color',o.brand_accent_color,'customer_theme',o.customer_theme,'menu_header',o.brand_menu_header
 )
 from public.organizations o where o.id=p_org_id and public.is_org_member(o.id);
$$;
grant execute on function public.get_brand_profile(uuid) to authenticated;

select pg_notify('pgrst','reload schema');
