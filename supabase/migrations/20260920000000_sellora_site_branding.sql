-- Site branding and favicon controls for public pages and browser tabs.

insert into storage.buckets (id, name, public)
values ('site-branding', 'site-branding', true)
on conflict (id) do nothing;

create policy "public read site branding"
on storage.objects for select to public
using (bucket_id = 'site-branding');

create policy "authenticated upload site branding"
on storage.objects for insert to authenticated
with check (bucket_id = 'site-branding' and (storage.foldername(name))[1] = 'site-branding');

create policy "authenticated update site branding"
on storage.objects for update to authenticated
using (bucket_id = 'site-branding' and (storage.foldername(name))[1] = 'site-branding')
with check (bucket_id = 'site-branding' and (storage.foldername(name))[1] = 'site-branding');

create policy "authenticated delete site branding"
on storage.objects for delete to authenticated
using (bucket_id = 'site-branding' and (storage.foldername(name))[1] = 'site-branding');

alter table public.platform_settings
  add column if not exists site_name text not null default 'Instaly' check (length(site_name) between 1 and 80),
  add column if not exists site_logo_url text,
  add column if not exists site_favicon_url text;

update public.platform_settings
set site_name = coalesce(site_name, 'Instaly')
where id = 1;
