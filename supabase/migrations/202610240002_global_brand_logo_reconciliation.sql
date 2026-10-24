-- Global Tablely logo controls for platform administrators.

create table if not exists public.platform_brand_settings (
  id boolean primary key default true check (id),
  logo_url text,
  logo_path text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.platform_brand_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.platform_brand_settings enable row level security;
revoke all on public.platform_brand_settings from anon, authenticated, public;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('brand-assets', 'brand-assets', true, 5242880, array['image/jpeg','image/png','image/webp','image/svg+xml'])
on conflict (id) do update set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/svg+xml'];

drop policy if exists brand_assets_insert_owner on storage.objects;
create policy brand_assets_insert_owner on storage.objects
for insert to authenticated
with check (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] <> 'platform'
  and public.is_org_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists brand_assets_update_owner on storage.objects;
create policy brand_assets_update_owner on storage.objects
for update to authenticated
using (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] <> 'platform'
  and public.is_org_owner(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] <> 'platform'
  and public.is_org_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists brand_assets_delete_owner on storage.objects;
create policy brand_assets_delete_owner on storage.objects
for delete to authenticated
using (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] <> 'platform'
  and public.is_org_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists platform_brand_assets_insert_admin on storage.objects;
create policy platform_brand_assets_insert_admin on storage.objects
for insert to authenticated
with check (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] = 'platform'
  and public.is_platform_admin()
);

drop policy if exists platform_brand_assets_update_admin on storage.objects;
create policy platform_brand_assets_update_admin on storage.objects
for update to authenticated
using (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] = 'platform'
  and public.is_platform_admin()
)
with check (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] = 'platform'
  and public.is_platform_admin()
);

drop policy if exists platform_brand_assets_delete_admin on storage.objects;
create policy platform_brand_assets_delete_admin on storage.objects
for delete to authenticated
using (
  bucket_id = 'brand-assets'
  and (storage.foldername(name))[1] = 'platform'
  and public.is_platform_admin()
);

create or replace function public.get_public_platform_brand()
returns table(logo_url text)
language sql stable security definer set search_path=public
as $$
  select logo_url from public.platform_brand_settings where id = true;
$$;

create or replace function public.admin_get_platform_brand()
returns public.platform_brand_settings
language plpgsql security definer set search_path=public
as $$
declare
  v_row public.platform_brand_settings;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
  select * into v_row from public.platform_brand_settings where id = true;
  return v_row;
end;
$$;

create or replace function public.admin_update_platform_brand(
  p_logo_url text,
  p_logo_path text
)
returns public.platform_brand_settings
language plpgsql security definer set search_path=public
as $$
declare
  v_row public.platform_brand_settings;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
  update public.platform_brand_settings
  set logo_url = nullif(left(trim(coalesce(p_logo_url, '')), 1000), ''),
      logo_path = nullif(left(trim(coalesce(p_logo_path, '')), 500), ''),
      updated_at = now(),
      updated_by = auth.uid()
  where id = true
  returning * into v_row;
  insert into public.admin_audit_logs(actor_user_id, action, entity_type, metadata)
  values (auth.uid(), 'PLATFORM_BRAND_UPDATED', 'PLATFORM_BRAND', '{}'::jsonb);
  return v_row;
end;
$$;

grant execute on function public.get_public_platform_brand() to anon, authenticated;
grant execute on function public.admin_get_platform_brand() to authenticated;
grant execute on function public.admin_update_platform_brand(text, text) to authenticated;
