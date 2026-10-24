-- Sellora Build 11 + 12: advanced admin operations, creator settlement readiness, advanced products.
-- Additive/idempotent. Run after 005_build_9_10.sql.

alter table public.products
  add column if not exists scheduled_publish_at timestamptz,
  add column if not exists max_purchases integer,
  add column if not exists max_downloads integer,
  add column if not exists download_expiry_days integer not null default 30,
  add column if not exists requires_license_key boolean not null default false,
  add column if not exists license_terms text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_max_purchases_check') then
    alter table public.products add constraint products_max_purchases_check check (max_purchases is null or max_purchases > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_max_downloads_check') then
    alter table public.products add constraint products_max_downloads_check check (max_downloads is null or max_downloads > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_download_expiry_check') then
    alter table public.products add constraint products_download_expiry_check check (download_expiry_days between 1 and 3650);
  end if;
end $$;

create table if not exists public.product_files (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_bucket text not null default 'product-files',
  file_path text not null,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique(product_id, file_path)
);

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  sku text,
  price integer not null check (price >= 0),
  currency text not null default 'INR',
  file_path text,
  status text not null default 'active' check (status in ('active','draft','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, name)
);

create table if not exists public.product_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  version_label text not null,
  changelog text,
  file_path text,
  preview_file_path text,
  created_at timestamptz not null default now(),
  unique(product_id, version_label)
);

create table if not exists public.product_license_keys (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  license_key text not null unique,
  status text not null default 'available' check (status in ('available','assigned','revoked')),
  assigned_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.product_files enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_versions enable row level security;
alter table public.product_license_keys enable row level security;

drop policy if exists "owners manage product files" on public.product_files;
create policy "owners manage product files" on public.product_files for all to authenticated
using (exists (select 1 from public.products p join public.stores s on s.id=p.store_id where p.id=product_files.product_id and s.owner_id=auth.uid()))
with check (exists (select 1 from public.products p join public.stores s on s.id=p.store_id where p.id=product_files.product_id and s.owner_id=auth.uid()));

drop policy if exists "owners manage product variants" on public.product_variants;
create policy "owners manage product variants" on public.product_variants for all to authenticated
using (exists (select 1 from public.products p join public.stores s on s.id=p.store_id where p.id=product_variants.product_id and s.owner_id=auth.uid()))
with check (exists (select 1 from public.products p join public.stores s on s.id=p.store_id where p.id=product_variants.product_id and s.owner_id=auth.uid()));

drop policy if exists "owners manage product versions" on public.product_versions;
create policy "owners manage product versions" on public.product_versions for all to authenticated
using (exists (select 1 from public.products p join public.stores s on s.id=p.store_id where p.id=product_versions.product_id and s.owner_id=auth.uid()))
with check (exists (select 1 from public.products p join public.stores s on s.id=p.store_id where p.id=product_versions.product_id and s.owner_id=auth.uid()));

drop policy if exists "owners read product license keys" on public.product_license_keys;
create policy "owners read product license keys" on public.product_license_keys for select to authenticated
using (exists (select 1 from public.products p join public.stores s on s.id=p.store_id where p.id=product_license_keys.product_id and s.owner_id=auth.uid()));

grant select, insert, update, delete on public.product_files, public.product_variants, public.product_versions, public.product_license_keys to authenticated;

create index if not exists product_files_product_idx on public.product_files(product_id, sort_order);
create index if not exists product_variants_product_idx on public.product_variants(product_id, created_at desc);
create index if not exists product_versions_product_idx on public.product_versions(product_id, created_at desc);
create index if not exists product_license_product_idx on public.product_license_keys(product_id, status);

-- Provider-neutral settlement capability metadata.
alter table public.payment_accounts
  add column if not exists onboarding_url text,
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists country text,
  add column if not exists default_currency text,
  add column if not exists last_synced_at timestamptz;

-- Admin operation metadata for reconciliation and controls.
alter table public.payouts
  add column if not exists hold_reason text,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz;

create index if not exists payout_provider_ref_idx on public.payouts(provider, provider_payout_id);

create table if not exists public.platform_settings (
  id integer primary key default 1 check (id = 1),
  platform_fee_bps integer not null default 0 check (platform_fee_bps between 0 and 10000),
  minimum_payout_minor bigint not null default 10000 check (minimum_payout_minor >= 0),
  payout_hold_days integer not null default 7 check (payout_hold_days between 0 and 365),
  default_currency text not null default 'INR',
  maintenance_mode boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.platform_settings (id) values (1) on conflict (id) do nothing;
alter table public.platform_settings enable row level security;
grant select, insert, update, delete on public.platform_settings to service_role;

alter table public.order_items add column if not exists download_count integer not null default 0;
create index if not exists order_items_product_idx on public.order_items(product_id, created_at desc);
