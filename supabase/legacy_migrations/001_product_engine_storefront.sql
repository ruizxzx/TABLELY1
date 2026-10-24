-- V1 product-engine/storefront upgrade. Safe to run after the original schema.
alter table public.stores add column if not exists status text not null default 'active' check (status in ('active','draft','suspended'));
alter table public.stores add column if not exists featured_product_id uuid null references public.products(id) on delete set null;
alter table public.stores add column if not exists social_links jsonb not null default '{}'::jsonb;

alter table public.products add column if not exists short_description text;
alter table public.products add column if not exists compare_at_price integer;
alter table public.products add column if not exists gallery jsonb not null default '[]'::jsonb;
alter table public.products add column if not exists preview_file_path text;
alter table public.products add column if not exists product_type text;
alter table public.products add column if not exists license text;
alter table public.products add column if not exists refund_policy text;
alter table public.products add column if not exists visibility text not null default 'public' check (visibility in ('public','private'));
alter table public.products add column if not exists published_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_compare_price_check') then
    alter table public.products add constraint products_compare_price_check check (compare_at_price is null or compare_at_price >= 0);
  end if;
end $$;

create index if not exists products_store_status_visibility_idx on public.products(store_id, status, visibility);
create index if not exists products_store_created_idx on public.products(store_id, created_at desc);

-- Public storefronts should only expose active stores.
drop policy if exists "public can read stores" on public.stores;
create policy "public can read active stores" on public.stores
for select to anon, authenticated using (status = 'active');

-- Public products are live + public; owners can manage their own products.
drop policy if exists "public can read live products" on public.products;
create policy "public can read live public products" on public.products
for select to anon, authenticated using (status = 'live' and visibility = 'public');

-- Storage policies required for replacement/deletion of public media.
drop policy if exists "owners update store media" on storage.objects;
drop policy if exists "owners delete store media" on storage.objects;
create policy "owners update store media" on storage.objects
for update to authenticated
using (bucket_id = 'store-media' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'store-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owners delete store media" on storage.objects
for delete to authenticated
using (bucket_id = 'store-media' and (storage.foldername(name))[1] = auth.uid()::text);

-- Read access to the private product-file objects remains authenticated-only.
drop policy if exists "owners read product files" on storage.objects;
create policy "owners read product files" on storage.objects
for select to authenticated
using (bucket_id = 'product-files' and (storage.foldername(name))[1] = auth.uid()::text);
