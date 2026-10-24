create extension if not exists pgcrypto;

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  username text not null unique,
  name text not null,
  bio text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  title text not null,
  slug text not null,
  description text,
  price integer not null check (price >= 0),
  currency text not null default 'INR',
  category text,
  cover_image_path text,
  file_path text,
  status text not null default 'draft' check (status in ('draft','live','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, slug)
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  product_id uuid not null references products(id),
  buyer_email text not null,
  customer_id uuid references profiles(id) on delete set null,
  gross_amount integer not null,
  payment_fee integer not null default 0,
  platform_fee integer not null default 0,
  seller_net integer not null default 0,
  gross_amount_minor bigint,
  payment_fee_minor bigint not null default 0,
  platform_fee_minor bigint not null default 0,
  seller_net_minor bigint not null default 0,
  currency text not null default 'INR',
  payment_provider text,
  payment_id text unique,
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded','disputed')),
  delivery_status text not null default 'locked' check (delivery_status in ('locked','available','expired')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists products_store_id_idx on products(store_id);
create index if not exists products_status_idx on products(status);
create index if not exists orders_store_id_idx on orders(store_id);
create index if not exists orders_product_id_idx on orders(product_id);

alter table profiles enable row level security;
alter table stores enable row level security;
alter table products enable row level security;
alter table orders enable row level security;

drop policy if exists "profiles self read" on profiles;
drop policy if exists "profiles self write" on profiles;
drop policy if exists "public can read stores" on stores;
drop policy if exists "owners manage stores" on stores;
drop policy if exists "public can read live products" on products;
drop policy if exists "owners manage products" on products;
drop policy if exists "owners read orders" on orders;

create policy "profiles self read" on profiles for select using (auth.uid() = id);
create policy "profiles self write" on profiles for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "public can read stores" on stores for select using (true);
create policy "owners manage stores" on stores for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "public can read live products" on products for select using (status = 'live');
create policy "owners manage products" on products for all using (exists (select 1 from stores s where s.id = products.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from stores s where s.id = products.store_id and s.owner_id = auth.uid()));
create policy "owners read orders" on orders for select using (exists (select 1 from stores s where s.id = orders.store_id and s.owner_id = auth.uid()));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

insert into storage.buckets (id, name, public)
values ('product-files', 'product-files', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('store-media', 'store-media', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('site-branding', 'site-branding', true)
on conflict (id) do nothing;

drop policy if exists "owners upload product files" on storage.objects;
drop policy if exists "owners update product files" on storage.objects;
drop policy if exists "owners delete product files" on storage.objects;
drop policy if exists "public read store media" on storage.objects;
drop policy if exists "owners upload store media" on storage.objects;

create policy "owners upload product files" on storage.objects
for insert to authenticated
with check (bucket_id = 'product-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "owners update product files" on storage.objects
for update to authenticated
using (bucket_id = 'product-files' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'product-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "owners delete product files" on storage.objects
for delete to authenticated
using (bucket_id = 'product-files' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "public read store media" on storage.objects
for select to public using (bucket_id = 'store-media');

create policy "owners upload store media" on storage.objects
for insert to authenticated
with check (bucket_id = 'store-media' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "public read site branding" on storage.objects
for select to public using (bucket_id = 'site-branding');

create policy "authenticated upload site branding" on storage.objects
for insert to authenticated
with check (bucket_id = 'site-branding' and (storage.foldername(name))[1] = 'site-branding');

create policy "authenticated update site branding" on storage.objects
for update to authenticated
using (bucket_id = 'site-branding' and (storage.foldername(name))[1] = 'site-branding')
with check (bucket_id = 'site-branding' and (storage.foldername(name))[1] = 'site-branding');

create policy "authenticated delete site branding" on storage.objects
for delete to authenticated
using (bucket_id = 'site-branding' and (storage.foldername(name))[1] = 'site-branding');


-- V1 product-engine/storefront upgrade. Safe to run after the original schema.
alter table public.stores add column if not exists status text not null default 'active' check (status in ('active','draft','suspended'));
alter table public.stores add column if not exists featured_product_id uuid null references public.products(id) on delete set null;
alter table public.stores add column if not exists social_links jsonb not null default '{}'::jsonb;
alter table public.stores add column if not exists verified_badge boolean not null default false;
alter table public.stores add column if not exists link_hub_config jsonb not null default '{"enabled": true, "title": "", "bio": "", "background": "#f5f1ea", "accent": "#d7653f", "buttonStyle": "solid", "links": [], "blocks": [], "socialLinks": {}}'::jsonb;

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

-- Sellora Build 3-5: payment abstraction, checkout transactions, verification events, and trustworthy order states.
-- Safe to re-run after 001_product_engine_storefront.sql.

alter table public.orders
  add column if not exists creator_id uuid references public.profiles(id) on delete set null,
  add column if not exists payment_provider_order_id text,
  add column if not exists payment_model text,
  add column if not exists payment_status text not null default 'initializing',
  add column if not exists provider_metadata jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_status_check_v2') then
    alter table public.orders drop constraint if exists orders_status_check;
    alter table public.orders add constraint orders_status_check_v2 check (status in ('created','pending','paid','failed','cancelled','refunded','partially_refunded','disputed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_payment_status_check') then
    alter table public.orders add constraint orders_payment_status_check check (payment_status in ('initializing','pending','processing','succeeded','failed','cancelled'));
  end if;
end $$;

create table if not exists public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references public.profiles(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,
  provider text not null,
  payment_model text not null check (payment_model in ('creator_connected','platform_merchant','marketplace')),
  provider_account_id text,
  status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  rendered_html text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  payment_account_id uuid references public.payment_accounts(id) on delete set null,
  provider text not null,
  provider_order_id text not null,
  provider_payment_id text unique,
  status text not null default 'initializing' check (status in ('initializing','pending','processing','succeeded','failed','cancelled')),
  amount integer not null check (amount >= 0),
  currency text not null,
  payment_fee integer not null default 0 check (payment_fee >= 0),
  metadata jsonb not null default '{}'::jsonb,
  failure_code text,
  failure_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  succeeded_at timestamptz
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  provider_order_id text,
  provider_payment_id text,
  signature_verified boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error_message text,
  unique(provider, provider_event_id)
);

create index if not exists payment_accounts_creator_idx on public.payment_accounts(creator_id);
create index if not exists payment_accounts_store_idx on public.payment_accounts(store_id);
create unique index if not exists payment_accounts_provider_store_unique on public.payment_accounts(provider, store_id) where store_id is not null;
create index if not exists payment_transactions_order_idx on public.payment_transactions(order_id);
create index if not exists payment_transactions_provider_order_idx on public.payment_transactions(provider, provider_order_id);
create unique index if not exists payment_transactions_order_unique on public.payment_transactions(order_id);
create index if not exists payment_events_provider_order_idx on public.payment_events(provider, provider_order_id);
create index if not exists orders_creator_idx on public.orders(creator_id);
create index if not exists orders_provider_order_idx on public.orders(payment_provider_order_id);

-- Prevent duplicate live checkout sessions for the same buyer/product. A stale pending session is cancelled by the server before a retry.
create unique index if not exists orders_active_checkout_unique
  on public.orders(product_id, buyer_email)
  where status in ('created','pending');

alter table public.payment_accounts enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_events enable row level security;

-- Backfill fields introduced in Build 3 for legacy rows. Historical amounts stay snapshots.
update public.orders o
set creator_id = s.owner_id
from public.stores s
where o.store_id = s.id and o.creator_id is null;

update public.orders
set payment_status = case
  when status in ('paid','refunded','partially_refunded','disputed') then 'succeeded'
  when status = 'failed' then 'failed'
  when status = 'cancelled' then 'cancelled'
  else 'pending'
end,
updated_at = coalesce(updated_at, created_at)
where payment_status = 'initializing';

update public.orders
set seller_net = greatest(0, gross_amount - payment_fee - platform_fee)
where seller_net = 0 and gross_amount > 0;

-- Creators can inspect their own account/transaction records in Studio. Only the server/service role writes payment records.
drop policy if exists "owners read payment accounts" on public.payment_accounts;
create policy "owners read payment accounts" on public.payment_accounts
for select to authenticated
using (creator_id = auth.uid());

drop policy if exists "owners read payment transactions" on public.payment_transactions;
create policy "owners read payment transactions" on public.payment_transactions
for select to authenticated
using (exists (
  select 1 from public.orders o
  where o.id = payment_transactions.order_id and o.creator_id = auth.uid()
));

drop policy if exists "owners read payment events" on public.payment_events;
create policy "owners read payment events" on public.payment_events
for select to authenticated
using (exists (
  select 1 from public.orders o
  where o.payment_provider_order_id = payment_events.provider_order_id and o.creator_id = auth.uid()
));

-- Orders remain creator-readable; all inserts/updates are server-side through the service role.
drop policy if exists "owners read orders" on public.orders;
create policy "owners read orders" on public.orders
for select to authenticated
using (exists (select 1 from public.stores s where s.id = orders.store_id and s.owner_id = auth.uid()));

-- Minimal browser-safe grants for creator Studio queries.
grant usage on schema public to authenticated;
grant select on public.payment_accounts to authenticated;
grant select on public.payment_transactions to authenticated;
grant select on public.payment_events to authenticated;
grant select on public.orders to authenticated;

-- Sellora Build 5 precision hardening.
-- Product/order display amounts remain in major units for backwards compatibility.
-- These columns preserve exact provider minor-unit financial snapshots (e.g. INR paise).

alter table public.orders
  add column if not exists gross_amount_minor bigint,
  add column if not exists payment_fee_minor bigint not null default 0,
  add column if not exists platform_fee_minor bigint not null default 0,
  add column if not exists seller_net_minor bigint not null default 0;

update public.orders
set gross_amount_minor = gross_amount * 100
where gross_amount_minor is null;

update public.orders
set payment_fee_minor = coalesce(payment_fee, 0) * 100
where payment_fee_minor = 0 and coalesce(payment_fee, 0) > 0;

update public.orders
set platform_fee_minor = coalesce(platform_fee, 0) * 100
where platform_fee_minor = 0 and coalesce(platform_fee, 0) > 0;

update public.orders
set seller_net_minor = greatest(0, coalesce(gross_amount_minor, gross_amount * 100) - payment_fee_minor - platform_fee_minor)
where seller_net_minor = 0 and gross_amount > 0;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_money_minor_nonnegative') then
    alter table public.orders
      add constraint orders_money_minor_nonnegative
      check (
        coalesce(gross_amount_minor, 0) >= 0
        and payment_fee_minor >= 0
        and platform_fee_minor >= 0
        and seller_net_minor >= 0
      );
  end if;
end $$;

-- Sellora Build 6-8: customer delivery, email, studio analytics and marketing.
-- Run after 001_product_engine_storefront.sql, 002_payment_system.sql and 003_money_precision.sql.

alter table public.stores
  add column if not exists theme_config jsonb not null default '{}'::jsonb,
  add column if not exists email_collection_enabled boolean not null default true;

alter table public.orders
  add column if not exists subtotal_amount integer not null default 0,
  add column if not exists discount_amount integer not null default 0,
  add column if not exists coupon_id uuid,
  add column if not exists coupon_code text,
  add column if not exists bundle_id uuid,
  add column if not exists invoice_number text,
  add column if not exists download_token_expires_at timestamptz,
  add column if not exists download_revoked_at timestamptz,
  add column if not exists buyer_email_sent_at timestamptz,
  add column if not exists creator_email_sent_at timestamptz,
  add column if not exists receipt_sent_at timestamptz,
  add column if not exists failed_email_sent_at timestamptz,
  add column if not exists download_count integer not null default 0,
  add column if not exists last_download_at timestamptz;

update public.orders set subtotal_amount = gross_amount where subtotal_amount = 0 and gross_amount > 0;

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  title text not null,
  quantity integer not null default 1 check (quantity > 0),
  unit_amount integer not null default 0 check (unit_amount >= 0),
  line_amount integer not null default 0 check (line_amount >= 0),
  file_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.store_analytics_events (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  event_type text not null check (event_type in ('visit','product_view','checkout_start','purchase','email_subscribe')),
  source text not null default 'direct',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  session_id text,
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists store_analytics_events_store_created_idx on public.store_analytics_events(store_id, created_at desc);
create index if not exists store_analytics_events_store_type_idx on public.store_analytics_events(store_id, event_type, created_at desc);
create index if not exists store_analytics_events_store_source_idx on public.store_analytics_events(store_id, source, created_at desc);

create table if not exists public.email_subscribers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  email text not null,
  source text not null default 'storefront',
  created_at timestamptz not null default now(),
  unique(store_id, email)
);
create index if not exists email_subscribers_store_idx on public.email_subscribers(store_id, created_at desc);

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  code text not null,
  discount_type text not null check (discount_type in ('percent','fixed')),
  discount_value integer not null check (discount_value > 0),
  max_redemptions integer,
  redeemed_count integer not null default 0,
  min_order_amount integer not null default 0,
  expires_at timestamptz,
  status text not null default 'draft' check (status in ('draft','active','paused','expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, code)
);
create index if not exists coupons_store_status_idx on public.coupons(store_id, status);

create table if not exists public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  buyer_email text not null,
  discount_amount integer not null default 0,
  created_at timestamptz not null default now(),
  unique(coupon_id, order_id)
);

create table if not exists public.bundles (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  title text not null,
  slug text not null,
  description text,
  price integer not null check (price >= 0),
  currency text not null default 'INR',
  status text not null default 'draft' check (status in ('draft','live','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, slug)
);

create table if not exists public.bundle_items (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.bundles(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(bundle_id, product_id)
);

create table if not exists public.upsells (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  upsell_product_id uuid not null references public.products(id) on delete cascade,
  headline text,
  discount_percent integer check (discount_percent between 0 and 100),
  status text not null default 'active' check (status in ('draft','active','paused')),
  created_at timestamptz not null default now(),
  unique(product_id, upsell_product_id)
);

create index if not exists orders_buyer_created_idx on public.orders(buyer_email, created_at desc);
create unique index if not exists orders_invoice_unique on public.orders(invoice_number) where invoice_number is not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_coupon_fk') then
    alter table public.orders add constraint orders_coupon_fk foreign key (coupon_id) references public.coupons(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_bundle_fk') then
    alter table public.orders add constraint orders_bundle_fk foreign key (bundle_id) references public.bundles(id) on delete set null;
  end if;
end $$;

alter table public.order_items enable row level security;
alter table public.store_analytics_events enable row level security;
alter table public.email_subscribers enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.bundles enable row level security;
alter table public.bundle_items enable row level security;
alter table public.upsells enable row level security;

drop policy if exists "owners read order items" on public.order_items;
create policy "owners read order items" on public.order_items for select to authenticated using (exists (select 1 from public.orders o where o.id = order_items.order_id and o.creator_id = auth.uid()));
drop policy if exists "owners read analytics" on public.store_analytics_events;
create policy "owners read analytics" on public.store_analytics_events for select to authenticated using (exists (select 1 from public.stores s where s.id = store_analytics_events.store_id and s.owner_id = auth.uid()));
drop policy if exists "public create analytics" on public.store_analytics_events;
create policy "public create analytics" on public.store_analytics_events for insert to anon, authenticated with check (exists (select 1 from public.stores s where s.id = store_analytics_events.store_id and s.status = 'active'));
drop policy if exists "owners read subscribers" on public.email_subscribers;
create policy "owners read subscribers" on public.email_subscribers for select to authenticated using (exists (select 1 from public.stores s where s.id = email_subscribers.store_id and s.owner_id = auth.uid()));
drop policy if exists "public create subscribers" on public.email_subscribers;
create policy "public create subscribers" on public.email_subscribers for insert to anon, authenticated with check (exists (select 1 from public.stores s where s.id = email_subscribers.store_id and s.status = 'active'));
drop policy if exists "owners manage coupons" on public.coupons;
create policy "entitled owners manage coupons" on public.coupons
for all to authenticated
using (exists (select 1 from public.stores s where s.id = coupons.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'coupons')))
with check (exists (select 1 from public.stores s where s.id = coupons.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'coupons')));
drop policy if exists "owners read redemptions" on public.coupon_redemptions;
create policy "owners read redemptions" on public.coupon_redemptions for select to authenticated using (exists (select 1 from public.coupons c join public.stores s on s.id = c.store_id where c.id = coupon_redemptions.coupon_id and s.owner_id = auth.uid()));
drop policy if exists "owners manage bundles" on public.bundles;
create policy "entitled owners manage bundles" on public.bundles
for all to authenticated
using (exists (select 1 from public.stores s where s.id = bundles.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'bundles')))
with check (exists (select 1 from public.stores s where s.id = bundles.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'bundles')));
drop policy if exists "public read live bundles" on public.bundles;
create policy "public read live bundles" on public.bundles for select to anon, authenticated using (status = 'live' and exists (select 1 from public.stores s where s.id = bundles.store_id and s.status = 'active'));
drop policy if exists "owners manage bundle items" on public.bundle_items;
create policy "entitled owners manage bundle items" on public.bundle_items
for all to authenticated
using (exists (select 1 from public.bundles b join public.stores s on s.id = b.store_id where b.id = bundle_items.bundle_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'bundles')))
with check (exists (select 1 from public.bundles b join public.stores s on s.id = b.store_id where b.id = bundle_items.bundle_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'bundles')));
drop policy if exists "public read live bundle items" on public.bundle_items;
create policy "public read live bundle items" on public.bundle_items for select to anon, authenticated using (exists (select 1 from public.bundles b join public.stores s on s.id = b.store_id where b.id = bundle_items.bundle_id and b.status = 'live' and s.status = 'active'));
drop policy if exists "owners manage upsells" on public.upsells;
create policy "entitled owners manage upsells" on public.upsells
for all to authenticated
using (exists (select 1 from public.stores s where s.id = upsells.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'upsells')))
with check (exists (select 1 from public.stores s where s.id = upsells.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'upsells')));
drop policy if exists "public read live upsells" on public.upsells;
create policy "public read live upsells" on public.upsells for select to anon, authenticated using (status = 'active' and exists (select 1 from public.stores s where s.id = upsells.store_id and s.status = 'active'));

-- Server-side writes run as service_role. Browser only needs the creator read/insert policies above.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert on public.store_analytics_events to anon, authenticated;
grant select, insert on public.email_subscribers to anon, authenticated;
grant select, insert, update, delete on public.coupons, public.bundles, public.bundle_items, public.upsells to authenticated;
grant select on public.coupon_redemptions to authenticated;
grant select on public.order_items to authenticated;
grant select, insert, update, delete on public.order_items, public.store_analytics_events, public.email_subscribers, public.coupons, public.coupon_redemptions, public.bundles, public.bundle_items, public.upsells to service_role;
grant select, insert, update, delete on public.orders, public.products, public.stores, public.profiles, public.payment_transactions, public.payment_events, public.payment_accounts to service_role;

create or replace function public.increment_coupon_redemption(coupon_uuid uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.coupons
  set redeemed_count = redeemed_count + 1, updated_at = now()
  where id = coupon_uuid;
$$;
revoke all on function public.increment_coupon_redemption(uuid) from public;
grant execute on function public.increment_coupon_redemption(uuid) to service_role;

-- Sellora Build 9 + 10: financial ledger, payouts, admin, moderation, refunds, disputes, audit, domains, security.
-- Additive/idempotent migration. Run after 004_build_6_7_8.sql.

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  store_id uuid references public.stores(id) on delete set null,
  creator_id uuid references public.profiles(id) on delete set null,
  entry_type text not null check (entry_type in ('sale','payment_fee','platform_fee','adjustment','refund','payout','seller_net','tax','chargeback')),
  direction text not null check (direction in ('credit','debit')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null default 'INR',
  description text,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_fees (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  provider text not null,
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  currency text not null default 'INR',
  provider_reference text,
  created_at timestamptz not null default now(),
  unique(order_id, provider)
);

create table if not exists public.platform_fees (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  creator_id uuid references public.profiles(id) on delete set null,
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'INR',
  rate_bps integer not null default 0 check (rate_bps >= 0),
  created_at timestamptz not null default now(),
  unique(order_id)
);

create table if not exists public.adjustments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  creator_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('tax','manual_credit','manual_debit','rounding','chargeback')),
  amount_minor bigint not null check (amount_minor >= 0),
  direction text not null check (direction in ('credit','debit')),
  reason text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  creator_id uuid references public.profiles(id) on delete set null,
  requested_amount_minor bigint not null check (requested_amount_minor > 0),
  approved_amount_minor bigint not null default 0 check (approved_amount_minor >= 0),
  currency text not null default 'INR',
  status text not null default 'requested' check (status in ('requested','approved','rejected','processing','succeeded','failed')),
  reason text,
  provider_refund_id text,
  requested_by_email text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'INR',
  status text not null default 'pending' check (status in ('pending','processing','paid','held','failed','cancelled')),
  method text not null default 'unsupported_pending_setup',
  provider text,
  provider_payout_id text,
  provider_account_id text,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  unique(provider, provider_payout_id)
);

create table if not exists public.creator_verifications (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null unique references public.profiles(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started','pending','verified','action_required','restricted','rejected')),
  provider text,
  provider_account_id text,
  requirements_due jsonb not null default '[]'::jsonb,
  last_provider_sync_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.creator_verifications add column if not exists verification_details jsonb not null default '{}'::jsonb;
alter table public.creator_verifications add column if not exists submitted_at timestamptz;

create table if not exists public.product_verification_requests (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','verified','rejected','action_required')),
  product_snapshot jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, status)
);
create index if not exists product_verification_requests_status_idx on public.product_verification_requests(status, submitted_at desc);
create index if not exists product_verification_requests_creator_idx on public.product_verification_requests(creator_id, submitted_at desc);
alter table public.product_verification_requests enable row level security;
drop policy if exists "creators read own product verification requests" on public.product_verification_requests;
create policy "creators read own product verification requests" on public.product_verification_requests for select to authenticated using (creator_id = auth.uid());
grant select on public.product_verification_requests to authenticated;
grant select, insert, update, delete on public.product_verification_requests to service_role;

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create table if not exists public.product_reports (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  reporter_email text,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  moderation_action text check (moderation_action in ('none','flag','hide','remove')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.creator_reports (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  reporter_email text,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  moderation_action text check (moderation_action in ('none','flag','suspend','ban')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  creator_id uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open','investigating','evidence_submitted','won','lost','resolved')),
  provider text,
  provider_reference text,
  reason text,
  internal_notes text,
  evidence jsonb not null default '[]'::jsonb,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.custom_domains (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  domain text not null unique,
  status text not null default 'pending_dns' check (status in ('pending_dns','verified','active','failed','disabled')),
  verification_token text not null,
  verified_at timestamptz,
  ssl_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.security_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  path text,
  ip_address inet,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists account_status text not null default 'active' check (account_status in ('active','suspended','banned'));
alter table public.products add column if not exists moderation_status text not null default 'clear' check (moderation_status in ('clear','flagged','hidden','removed'));
alter table public.stores add column if not exists custom_domain_id uuid references public.custom_domains(id) on delete set null;
alter table public.orders add column if not exists refund_amount_minor bigint not null default 0;
alter table public.orders add column if not exists disputed_at timestamptz;
alter table public.orders add column if not exists last_refund_at timestamptz;

create index if not exists ledger_creator_created_idx on public.ledger_entries(creator_id, created_at desc);
create index if not exists ledger_order_idx on public.ledger_entries(order_id);
create index if not exists payouts_creator_status_idx on public.payouts(creator_id, status);
create index if not exists refunds_order_idx on public.refunds(order_id, created_at desc);
create index if not exists audit_created_idx on public.audit_logs(created_at desc);
create index if not exists product_reports_status_idx on public.product_reports(status);
create index if not exists creator_reports_status_idx on public.creator_reports(status);
create index if not exists disputes_status_idx on public.disputes(status);

alter table public.ledger_entries enable row level security;
alter table public.payment_fees enable row level security;
alter table public.platform_fees enable row level security;
alter table public.adjustments enable row level security;
alter table public.refunds enable row level security;
alter table public.payouts enable row level security;
alter table public.creator_verifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.product_reports enable row level security;
alter table public.creator_reports enable row level security;
alter table public.disputes enable row level security;
alter table public.custom_domains enable row level security;
alter table public.security_events enable row level security;

-- Creator read policies. Sensitive writes are server-only.
drop policy if exists "creator read ledger" on public.ledger_entries;
create policy "creator read ledger" on public.ledger_entries for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read fees" on public.payment_fees;
create policy "creator read fees" on public.payment_fees for select to authenticated using (exists (select 1 from public.orders o where o.id = payment_fees.order_id and o.creator_id = auth.uid()));
drop policy if exists "creator read platform fees" on public.platform_fees;
create policy "creator read platform fees" on public.platform_fees for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read payouts" on public.payouts;
create policy "creator read payouts" on public.payouts for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read verification" on public.creator_verifications;
create policy "creator read verification" on public.creator_verifications for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read refunds" on public.refunds;
create policy "creator read refunds" on public.refunds for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read disputes" on public.disputes;
create policy "creator read disputes" on public.disputes for select to authenticated using (creator_id = auth.uid());
drop policy if exists "owner manage domains" on public.custom_domains;
create policy "owner manage domains" on public.custom_domains for all to authenticated using (exists (select 1 from public.stores s where s.id=custom_domains.store_id and s.owner_id=auth.uid())) with check (exists (select 1 from public.stores s where s.id=custom_domains.store_id and s.owner_id=auth.uid()));

-- Reporting is public-facing submission; moderation reads are server-only.
drop policy if exists "public submit product report" on public.product_reports;
create policy "public submit product report" on public.product_reports for insert to anon, authenticated with check (true);
drop policy if exists "public submit creator report" on public.creator_reports;
create policy "public submit creator report" on public.creator_reports for insert to anon, authenticated with check (true);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.ledger_entries, public.payment_fees, public.platform_fees, public.adjustments, public.refunds, public.payouts, public.creator_verifications, public.audit_logs, public.product_reports, public.creator_reports, public.disputes, public.custom_domains, public.security_events to service_role;

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
  site_name text not null default 'Instaly' check (length(site_name) between 1 and 80),
  site_logo_url text,
  site_favicon_url text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.platform_settings (id) values (1) on conflict (id) do nothing;
alter table public.platform_settings enable row level security;
grant select, insert, update, delete on public.platform_settings to service_role;

alter table public.order_items add column if not exists download_count integer not null default 0;
create index if not exists order_items_product_idx on public.order_items(product_id, created_at desc);

-- Sellora Build 1 + 2: categories, canonical creator plan entitlements, and product/category integrity.
-- Safe/idempotent migration. Run after 006_build_11_12.sql.

create table if not exists public.creator_plans (
  creator_id uuid primary key references public.profiles(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','creator','pro','max')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.store_categories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  slug text not null,
  description text,
  image_path text,
  sort_order integer not null default 0,
  is_visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, slug)
);

alter table public.products add column if not exists category_id uuid references public.store_categories(id) on delete restrict;
alter table public.products add column if not exists sort_order integer not null default 0;

-- Give existing stores a deterministic category, then migrate the legacy category text.
insert into public.store_categories (store_id, name, slug, sort_order)
select s.id, 'Products', 'products', 0
from public.stores s
where not exists (select 1 from public.store_categories c where c.store_id = s.id);

with legacy as (
  select p.id, p.store_id, lower(regexp_replace(coalesce(nullif(trim(p.category), ''), 'Products'), '[^a-z0-9]+', '-', 'g')) as base_slug,
         coalesce(nullif(trim(p.category), ''), 'Products') as category_name
  from public.products p
  where p.category_id is null
),
needed as (
  select distinct store_id, category_name, nullif(trim(both '-' from base_slug), '') as base_slug
  from legacy
)
insert into public.store_categories (store_id, name, slug, sort_order)
select n.store_id, n.category_name,
       coalesce(n.base_slug, 'products'),
       coalesce((select max(c.sort_order)+1 from public.store_categories c where c.store_id=n.store_id), 0)
from needed n
where not exists (
  select 1 from public.store_categories c
  where c.store_id=n.store_id and lower(c.name)=lower(n.category_name)
);

update public.products p
set category_id = c.id,
    category = c.name
from public.store_categories c
where c.store_id=p.store_id
  and p.category_id is null
  and lower(c.name)=lower(coalesce(nullif(trim(p.category), ''), 'Products'));

create index if not exists store_categories_store_sort_idx
  on public.store_categories(store_id, sort_order, created_at);
create index if not exists products_store_category_sort_idx
  on public.products(store_id, category_id, sort_order, created_at desc);
create index if not exists products_category_idx on public.products(category_id);

alter table public.creator_plans enable row level security;
alter table public.store_categories enable row level security;

drop policy if exists "creator read own plan" on public.creator_plans;
create policy "creator read own plan" on public.creator_plans
for select to authenticated using (creator_id = auth.uid());

drop policy if exists "owners manage categories" on public.store_categories;
create policy "owners manage categories" on public.store_categories
for all to authenticated
using (exists (select 1 from public.stores s where s.id=store_categories.store_id and s.owner_id=auth.uid()))
with check (exists (select 1 from public.stores s where s.id=store_categories.store_id and s.owner_id=auth.uid()));

drop policy if exists "public can read visible categories" on public.store_categories;
create policy "public can read visible categories" on public.store_categories
for select to anon, authenticated
using (
  is_visible = true
  and exists (
    select 1 from public.stores s
    where s.id=store_categories.store_id and s.status='active'
  )
);

-- Ensure every creator has a canonical plan row. Existing creators default to Free until Build 4 billing changes it.
insert into public.creator_plans (creator_id, plan)
select p.id, 'free'
from public.profiles p
where not exists (select 1 from public.creator_plans cp where cp.creator_id=p.id);

create or replace function public.sellora_creator_has_feature(p_creator_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((sp.features ->> p_feature)::boolean, false)
  from public.creator_plans cp
  join public.sellora_plans sp on sp.plan_key = case
    when cp.access_starts_at is not null and cp.access_starts_at > now() then 'free'
    when cp.access_expires_at is not null and cp.access_expires_at <= now() then 'free'
    else cp.plan
  end and sp.active = true
  where cp.creator_id = p_creator_id;
$$;

revoke all on function public.sellora_creator_has_feature(uuid, text) from public, anon, authenticated;
grant execute on function public.sellora_creator_has_feature(uuid, text) to authenticated, service_role;

create or replace function public.sellora_plan_limits(p_plan text)
returns table(max_products bigint, max_categories bigint)
language sql immutable as $$
  select
    case p_plan
      when 'free' then 1
      when 'creator' then 10
      when 'pro' then 9223372036854775807
      when 'max' then 9223372036854775807
      else 1
    end,
    case p_plan
      when 'free' then 1
      when 'creator' then 2
      when 'pro' then 10
      when 'max' then 9223372036854775807
      else 1
    end;
$$;

create or replace function public.sellora_check_store_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_product_count bigint;
  v_category_count bigint;
  v_store_id uuid;
begin
  if tg_table_name = 'products' then
    v_store_id := coalesce(new.store_id, old.store_id);
  else
    v_store_id := coalesce(new.store_id, old.store_id);
  end if;

  select owner_id into v_owner from public.stores where id=v_store_id;
  if v_owner is null then
    raise exception using errcode='23503', message='STORE_NOT_FOUND';
  end if;

  select plan into v_plan from public.creator_plans where creator_id=v_owner;
  v_plan := coalesce(v_plan, 'free');
  select max_products, max_categories into v_max_products, v_max_categories from public.sellora_plan_limits(v_plan);

  if tg_table_name = 'products' then
    if tg_op='INSERT' then
      if new.category_id is null then
        raise exception using errcode='23514', message='CATEGORY_REQUIRED';
      end if;
      if not exists (select 1 from public.store_categories c where c.id=new.category_id and c.store_id=v_store_id) then
        raise exception using errcode='23514', message='INVALID_CATEGORY';
      end if;
      select count(*) into v_product_count from public.products where store_id=v_store_id;
      if v_product_count >= v_max_products then
        raise exception using errcode='42501', message='PRODUCT_LIMIT_REACHED';
      end if;
    elsif tg_op='UPDATE' then
      if new.category_id is null then
        raise exception using errcode='23514', message='CATEGORY_REQUIRED';
      end if;
      if not exists (select 1 from public.store_categories c where c.id=new.category_id and c.store_id=new.store_id) then
        raise exception using errcode='23514', message='INVALID_CATEGORY';
      end if;
      if new.store_id <> old.store_id then
        raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED';
      end if;
    end if;
  else
    if tg_op='INSERT' then
      select count(*) into v_category_count from public.store_categories where store_id=v_store_id;
      if v_category_count >= v_max_categories then
        raise exception using errcode='42501', message='CATEGORY_LIMIT_REACHED';
      end if;
    elsif tg_op='UPDATE' then
      if new.store_id <> old.store_id then
        raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED';
      end if;
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_products_entitlements on public.products;
create trigger trg_products_entitlements
before insert or update of store_id, category_id on public.products
for each row execute function public.sellora_check_store_entitlements();

drop trigger if exists trg_categories_entitlements on public.store_categories;
create trigger trg_categories_entitlements
before insert or update of store_id on public.store_categories
for each row execute function public.sellora_check_store_entitlements();

-- Recreate product policies so owners can continue managing category-linked products while public access stays restricted.
drop policy if exists "public can read live public products" on public.products;
create policy "public can read live public products" on public.products
for select to anon, authenticated
using (
  status='live'
  and visibility='public'
  and exists (
    select 1 from public.stores s
    where s.id=products.store_id and s.status='active'
  )
);

-- Product owner policy remains canonical from the base schema. Explicit grants for the new tables.
grant select on public.creator_plans to authenticated;
grant select, insert, update, delete on public.store_categories to authenticated;

-- Sellora Build 4-compatible admin creator access grants.
-- This does not implement payment-provider subscription billing. It provides secure admin-controlled
-- invitations and temporary/permanent plan entitlements that can later be superseded by real billing.

create table if not exists public.creator_access_grants (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  creator_id uuid references public.profiles(id) on delete set null,
  plan text not null default 'free' check (plan in ('free','creator','pro','max')),
  access_type text not null default 'trial' check (access_type in ('trial','complimentary','permanent')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'pending' check (status in ('pending','active','expired','revoked')),
  note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_access_grants_email_lower check (email = lower(trim(email))),
  constraint creator_access_grants_dates check (expires_at is null or expires_at > starts_at)
);

create unique index if not exists creator_access_grants_email_active_idx
  on public.creator_access_grants(lower(email))
  where status in ('pending','active');
create index if not exists creator_access_grants_creator_idx on public.creator_access_grants(creator_id, created_at desc);
create index if not exists creator_access_grants_expires_idx on public.creator_access_grants(status, expires_at);

alter table public.creator_plans add column if not exists access_source text not null default 'subscription';
alter table public.creator_plans add column if not exists access_starts_at timestamptz not null default now();
alter table public.creator_plans add column if not exists access_expires_at timestamptz;
alter table public.creator_plans add column if not exists access_grant_id uuid references public.creator_access_grants(id) on delete set null;
alter table public.creator_plans add column if not exists updated_by uuid;

create or replace function public.sellora_effective_plan(p_creator_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when cp.access_starts_at is not null and cp.access_starts_at > now() then 'free'
    when cp.access_expires_at is not null and cp.access_expires_at <= now() then 'free'
    else coalesce(cp.plan, 'free')
  end
  from public.creator_plans cp
  where cp.creator_id = p_creator_id;
$$;

-- Make entitlement trigger use the effective plan so expired admin trials automatically fall back to Free.
create or replace function public.sellora_check_store_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_product_count bigint;
  v_category_count bigint;
  v_store_id uuid;
begin
  v_store_id := coalesce(new.store_id, old.store_id);
  select owner_id into v_owner from public.stores where id=v_store_id;
  if v_owner is null then
    raise exception using errcode='23503', message='STORE_NOT_FOUND';
  end if;

  v_plan := public.sellora_effective_plan(v_owner);
  v_plan := coalesce(v_plan, 'free');
  select max_products, max_categories into v_max_products, v_max_categories from public.sellora_plan_limits(v_plan);

  if tg_table_name = 'products' then
    if tg_op='INSERT' then
      if new.category_id is null then raise exception using errcode='23514', message='CATEGORY_REQUIRED'; end if;
      if not exists (select 1 from public.store_categories c where c.id=new.category_id and c.store_id=v_store_id) then raise exception using errcode='23514', message='INVALID_CATEGORY'; end if;
      select count(*) into v_product_count from public.products where store_id=v_store_id;
      if v_product_count >= v_max_products then raise exception using errcode='42501', message='PRODUCT_LIMIT_REACHED'; end if;
    elsif tg_op='UPDATE' then
      if new.category_id is null then raise exception using errcode='23514', message='CATEGORY_REQUIRED'; end if;
      if not exists (select 1 from public.store_categories c where c.id=new.category_id and c.store_id=new.store_id) then raise exception using errcode='23514', message='INVALID_CATEGORY'; end if;
      if new.store_id <> old.store_id then raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED'; end if;
    end if;
  else
    if tg_op='INSERT' then
      select count(*) into v_category_count from public.store_categories where store_id=v_store_id;
      if v_category_count >= v_max_categories then raise exception using errcode='42501', message='CATEGORY_LIMIT_REACHED'; end if;
    elsif tg_op='UPDATE' then
      if new.store_id <> old.store_id then raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED'; end if;
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

-- Apply pending grants automatically when an invited user is actually created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_grant public.creator_access_grants%rowtype;
  v_email text := lower(trim(coalesce(new.email, '')));
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(coalesce(new.email,''), '@', 1)))
  on conflict (id) do nothing;

  select * into v_grant
  from public.creator_access_grants g
  where lower(g.email)=v_email
    and g.status='pending'
  order by g.created_at desc
  limit 1;

  if found then
    update public.creator_access_grants
    set creator_id=new.id, status='active', updated_at=now()
    where id=v_grant.id;

    insert into public.creator_plans (creator_id, plan, access_source, access_starts_at, access_expires_at, access_grant_id, updated_at)
    values (new.id, v_grant.plan, v_grant.access_type, v_grant.starts_at, v_grant.expires_at, v_grant.id, now())
    on conflict (creator_id) do update
      set plan=excluded.plan,
          access_source=excluded.access_source,
          access_starts_at=excluded.access_starts_at,
          access_expires_at=excluded.access_expires_at,
          access_grant_id=excluded.access_grant_id,
          updated_at=now();
  else
    insert into public.creator_plans (creator_id, plan, access_source, access_starts_at)
    values (new.id, 'free', 'subscription', now())
    on conflict (creator_id) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.creator_access_grants enable row level security;
revoke all on public.creator_access_grants from anon, authenticated;
grant all on public.creator_access_grants to service_role;

-- Keep historical/expiring grant status accurate when an admin opens the list.
update public.creator_access_grants
set status='expired', updated_at=now()
where status in ('pending','active') and expires_at is not null and expires_at <= now();

-- Sellora Build 1+2 hardening: plan downgrade archival, plan recovery, category status, external-link delivery,
-- and public preview delivery.
-- Safe/idempotent. Run after 008_admin_creator_access_trials.sql.

alter table public.store_categories
  add column if not exists status text not null default 'live',
  add column if not exists plan_archived boolean not null default false,
  add column if not exists plan_archived_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'store_categories_status_check') then
    alter table public.store_categories add constraint store_categories_status_check check (status in ('live','archived'));
  end if;
end $$;

alter table public.products
  add column if not exists digital_delivery_type text not null default 'upload',
  add column if not exists file_access_url text,
  add column if not exists plan_archived boolean not null default false,
  add column if not exists plan_archived_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_digital_delivery_type_check') then
    alter table public.products add constraint products_digital_delivery_type_check check (digital_delivery_type in ('upload','link'));
  end if;
end $$;

alter table public.order_items
  add column if not exists file_access_url text;

-- Existing file-backed products keep upload delivery.
update public.products
set digital_delivery_type='upload'
where digital_delivery_type is null;

create index if not exists store_categories_store_status_idx
  on public.store_categories(store_id, status, is_visible, sort_order, created_at desc);
create index if not exists products_store_status_created_idx
  on public.products(store_id, status, created_at desc);

create or replace function public.sellora_plan_rank(p_plan text)
returns integer
language sql immutable as $$
  select case p_plan when 'free' then 0 when 'creator' then 1 when 'pro' then 2 when 'max' then 3 else 0 end;
$$;

create or replace function public.sellora_validate_delivery(p_type text, p_file_path text, p_file_access_url text)
returns void
language plpgsql immutable as $$
begin
  if p_type not in ('upload','link') then
    raise exception using errcode='23514', message='INVALID_DELIVERY_TYPE';
  end if;
  if p_type='upload' and nullif(trim(coalesce(p_file_path,'')),'') is null then
    raise exception using errcode='23514', message='DIGITAL_FILE_REQUIRED';
  end if;
  if p_type='link' then
    if nullif(trim(coalesce(p_file_access_url,'')),'') is null then
      raise exception using errcode='23514', message='DIGITAL_LINK_REQUIRED';
    end if;
    if p_file_access_url !~* '^https?://' then
      raise exception using errcode='23514', message='INVALID_DIGITAL_LINK';
    end if;
  end if;
end;
$$;

create or replace function public.sellora_apply_plan_limits(p_creator_id uuid, p_old_plan text default 'free', p_new_plan text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_old_rank integer := public.sellora_plan_rank(coalesce(p_old_plan,'free'));
  v_new_rank integer;
  v_now timestamptz := now();
begin
  select id into v_store_id from public.stores where owner_id=p_creator_id limit 1;
  if v_store_id is null then return; end if;

  v_plan := coalesce(p_new_plan, public.sellora_effective_plan(p_creator_id));
  v_new_rank := public.sellora_plan_rank(v_plan);
  select max_products,max_categories into v_max_products,v_max_categories
  from public.sellora_plan_limits(v_plan);

  -- Upgrade: restore content previously taken offline by a plan downgrade, newest first.
  if v_new_rank > v_old_rank then
    if v_max_categories = 9223372036854775807 then
      update public.store_categories
      set status='live', is_visible=true, plan_archived=false, plan_archived_at=null, updated_at=v_now
      where store_id=v_store_id and status='archived' and plan_archived=true;
    else
      with ranked as (
        select id, row_number() over(order by plan_archived_at desc nulls last, created_at desc, id desc) rn
        from public.store_categories
        where store_id=v_store_id and status='archived' and plan_archived=true
      )
      update public.store_categories c
      set status='live', is_visible=true, plan_archived=false, plan_archived_at=null, updated_at=v_now
      from ranked r
      where c.id=r.id and r.rn <= v_max_categories;
    end if;

    if v_max_products = 9223372036854775807 then
      update public.products p
      set status='live', plan_archived=false, plan_archived_at=null, updated_at=v_now
      where p.store_id=v_store_id and p.status='archived' and p.plan_archived=true
        and exists (
          select 1 from public.store_categories c
          where c.id=p.category_id and c.status='live' and c.is_visible=true
        );
    else
      with ranked as (
        select p.id, row_number() over(order by p.plan_archived_at desc nulls last, coalesce(p.published_at,p.created_at) desc, p.id desc) rn
        from public.products p
        where p.store_id=v_store_id and p.status='archived' and p.plan_archived=true
          and exists (
            select 1 from public.store_categories c
            where c.id=p.category_id and c.status='live' and c.is_visible=true
          )
      )
      update public.products p
      set status='live', plan_archived=false, plan_archived_at=null,
          published_at=coalesce(p.published_at,v_now), updated_at=v_now
      from ranked r
      where p.id=r.id and r.rn <= v_max_products;
    end if;
  end if;

  -- Categories: only currently-live/visible sections consume the active category allowance.
  if v_max_categories <> 9223372036854775807 then
    with ranked as (
      select c.id,
             row_number() over(order by c.created_at desc, c.id desc) rn
      from public.store_categories c
      where c.store_id=v_store_id and c.status='live' and c.is_visible=true
    )
    update public.store_categories c
    set status='archived', is_visible=false, plan_archived=true, plan_archived_at=v_now, updated_at=v_now
    from ranked r
    where c.id=r.id and r.rn > v_max_categories;
  end if;

  -- Products in plan-archived categories are also taken offline.
  update public.products p
  set status='archived', plan_archived=true, plan_archived_at=v_now, updated_at=v_now
  where p.store_id=v_store_id and p.status='live'
    and exists (
      select 1 from public.store_categories c
      where c.id=p.category_id and (c.status<>'live' or c.is_visible=false) and c.plan_archived=true
    );

  -- Product allowance applies to live products. When over a limit, the newest live products are archived first.
  if v_max_products <> 9223372036854775807 then
    with ranked as (
      select p.id,
             row_number() over(order by p.created_at desc, p.id desc) rn
      from public.products p
      where p.store_id=v_store_id and p.status='live'
    )
    update public.products p
    set status='archived', plan_archived=true, plan_archived_at=v_now, updated_at=v_now
    from ranked r
    where p.id=r.id and r.rn > v_max_products;
  end if;
end;
$$;

-- Replace the entitlement trigger so publishing itself consumes the active limit, and use live counts rather than total historical rows.
create or replace function public.sellora_check_store_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_product_count bigint;
  v_category_count bigint;
  v_store_id uuid;
begin
  v_store_id := coalesce(new.store_id, old.store_id);
  select owner_id into v_owner from public.stores where id=v_store_id;
  if v_owner is null then raise exception using errcode='23503', message='STORE_NOT_FOUND'; end if;

  v_plan := coalesce(public.sellora_effective_plan(v_owner),'free');
  select max_products,max_categories into v_max_products,v_max_categories from public.sellora_plan_limits(v_plan);

  if tg_table_name='products' then
    if tg_op in ('INSERT','UPDATE') and new.status='live' then
      if new.category_id is null then raise exception using errcode='23514', message='CATEGORY_REQUIRED'; end if;
      if not exists (
        select 1 from public.store_categories c
        where c.id=new.category_id and c.store_id=v_store_id and c.status='live' and c.is_visible=true
      ) then
        raise exception using errcode='23514', message='INVALID_CATEGORY';
      end if;
      perform public.sellora_validate_delivery(new.digital_delivery_type, new.file_path, new.file_access_url);
      if v_max_products <> 9223372036854775807 then
        select count(*) into v_product_count from public.products
        where store_id=v_store_id and status='live' and id<>coalesce(new.id,'00000000-0000-0000-0000-000000000000'::uuid);
        if v_product_count >= v_max_products then raise exception using errcode='42501', message='PRODUCT_LIMIT_REACHED'; end if;
      end if;
    end if;
    if tg_op='UPDATE' and new.store_id<>old.store_id then
      raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED';
    end if;
  else
    if tg_op in ('INSERT','UPDATE') and new.status='live' and new.is_visible=true then
      if v_max_categories <> 9223372036854775807 then
        select count(*) into v_category_count from public.store_categories
        where store_id=v_store_id and status='live' and is_visible=true and id<>coalesce(new.id,'00000000-0000-0000-0000-000000000000'::uuid);
        if v_category_count >= v_max_categories then raise exception using errcode='42501', message='CATEGORY_LIMIT_REACHED'; end if;
      end if;
    end if;
    if tg_op='UPDATE' and new.store_id<>old.store_id then
      raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_products_entitlements on public.products;
create trigger trg_products_entitlements
before insert or update of store_id, category_id, status, visibility, digital_delivery_type, file_path, file_access_url
on public.products
for each row execute function public.sellora_check_store_entitlements();

drop trigger if exists trg_categories_entitlements on public.store_categories;
create trigger trg_categories_entitlements
before insert or update of store_id, status, is_visible
on public.store_categories
for each row execute function public.sellora_check_store_entitlements();

-- Any admin/billing plan change immediately reconciles active/live content.
create or replace function public.sellora_reconcile_plan_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_effective text;
  v_new_effective text;
begin
  v_old_effective := case
    when old.access_starts_at is not null and old.access_starts_at > now() then 'free'
    when old.access_expires_at is not null and old.access_expires_at <= now() then 'free'
    else coalesce(old.plan,'free')
  end;
  v_new_effective := case
    when new.access_starts_at is not null and new.access_starts_at > now() then 'free'
    when new.access_expires_at is not null and new.access_expires_at <= now() then 'free'
    else coalesce(new.plan,'free')
  end;
  perform public.sellora_apply_plan_limits(new.creator_id, v_old_effective, v_new_effective);
  return new;
end;
$$;

drop trigger if exists trg_creator_plans_reconcile on public.creator_plans;
create trigger trg_creator_plans_reconcile
after update of plan, access_starts_at, access_expires_at on public.creator_plans
for each row execute function public.sellora_reconcile_plan_change();

-- Safe recovery when a category is explicitly restored by the creator: it is subject to the current category cap.
comment on column public.store_categories.plan_archived is 'True only when Sellora automatically archived this category because of a plan entitlement change.';
comment on column public.products.plan_archived is 'True only when Sellora automatically archived this product because of a plan entitlement change.';
comment on column public.products.file_access_url is 'External HTTPS delivery URL used when digital_delivery_type=link.';
comment on column public.products.preview_file_path is 'Optional private preview file that can be opened or downloaded publicly through the signed preview endpoint for live products.';


create or replace function public.sellora_reconcile_my_plan()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception using errcode='42501', message='UNAUTHORIZED';
  end if;
  perform public.sellora_apply_plan_limits(auth.uid(), 'free', public.sellora_effective_plan(auth.uid()));
end;
$$;

grant execute on function public.sellora_reconcile_my_plan() to authenticated;

-- Reconcile existing creators once so a pre-existing account also respects the new active/live limits.
do $$
declare r record;
begin
  for r in select creator_id from public.creator_plans loop
    perform public.sellora_apply_plan_limits(r.creator_id, 'max', public.sellora_effective_plan(r.creator_id));
  end loop;
end $$;

-- These SECURITY DEFINER routines are internal implementation details; client sessions must not invoke them directly.
revoke all on function public.sellora_apply_plan_limits(uuid,text,text) from public, anon, authenticated;
revoke all on function public.sellora_reconcile_plan_change() from public, anon, authenticated;
revoke all on function public.sellora_check_store_entitlements() from public, anon, authenticated;

-- Sellora Build 1+2 hardening: entitlement-safe restoration, public category policy,
-- and purchased-delivery snapshots for products archived after purchase.
-- Run after 009_plan_downgrade_archival_and_link_delivery.sql.

-- Public categories must be both live and visible.
drop policy if exists "public can read visible categories" on public.store_categories;
create policy "public can read visible live categories" on public.store_categories
for select to anon, authenticated
using (
  status = 'live'
  and is_visible = true
  and exists (
    select 1 from public.stores s
    where s.id = store_categories.store_id
      and s.status = 'active'
  )
);


-- Public product reads must also require a live, visible category. This closes direct-query
-- access to products whose storefront category was hidden/plan-archived.
drop policy if exists "public can read live public products" on public.products;
create policy "public can read live public categorized products" on public.products
for select to anon, authenticated
using (
  status = 'live'
  and visibility = 'public'
  and exists (
    select 1 from public.store_categories c
    join public.stores s on s.id = c.store_id
    where c.id = products.category_id
      and c.store_id = products.store_id
      and c.status = 'live'
      and c.is_visible = true
      and s.status = 'active'
  )
);

-- Backfill delivery snapshots into order_items for existing purchases.
update public.order_items oi
set file_path = case when p.digital_delivery_type = 'link' then null else coalesce(oi.file_path, p.file_path) end,
    file_access_url = case when p.digital_delivery_type = 'link' then coalesce(oi.file_access_url, p.file_access_url) else null end
from public.products p
where oi.product_id = p.id
  and (oi.file_path is null and oi.file_access_url is null);

insert into public.order_items
  (order_id, product_id, title, quantity, unit_amount, line_amount, file_path, file_access_url)
select
  o.id,
  o.product_id,
  coalesce(p.title, 'Purchased product'),
  1,
  coalesce(p.price, o.gross_amount),
  o.gross_amount,
  case when p.digital_delivery_type = 'link' then null else p.file_path end,
  case when p.digital_delivery_type = 'link' then p.file_access_url else null end
from public.orders o
left join public.products p on p.id = o.product_id
where o.product_id is not null
  and o.status in ('paid','partially_refunded','refunded','disputed')
  and not exists (
    select 1 from public.order_items oi where oi.order_id = o.id
  );

-- Replace plan reconciliation with capacity-aware, deterministic restoration.
create or replace function public.sellora_apply_plan_limits(
  p_creator_id uuid,
  p_old_plan text default 'free',
  p_new_plan text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_old_rank integer := public.sellora_plan_rank(coalesce(p_old_plan,'free'));
  v_new_rank integer;
  v_now timestamptz := now();
  v_live_categories bigint := 0;
  v_live_products bigint := 0;
  v_capacity bigint := 0;
  v_id uuid;
begin
  select id into v_store_id from public.stores where owner_id=p_creator_id limit 1;
  if v_store_id is null then return; end if;

  v_plan := coalesce(p_new_plan, public.sellora_effective_plan(p_creator_id), 'free');
  v_new_rank := public.sellora_plan_rank(v_plan);
  select max_products,max_categories into v_max_products,v_max_categories
  from public.sellora_plan_limits(v_plan);

  -- First bring live content within the new category limit. Newest live categories are archived first.
  if v_max_categories <> 9223372036854775807 then
    select count(*) into v_live_categories
    from public.store_categories
    where store_id=v_store_id and status='live' and is_visible=true;

    if v_live_categories > v_max_categories then
      for v_id in
        select id
        from public.store_categories
        where store_id=v_store_id and status='live' and is_visible=true
        order by created_at desc, id desc
        limit (v_live_categories - v_max_categories)
      loop
        update public.store_categories
        set status='archived', is_visible=false, plan_archived=true, plan_archived_at=v_now, updated_at=v_now
        where id=v_id;
      end loop;
    end if;
  end if;

  -- Any products inside categories archived by the plan change are taken offline.
  update public.products p
  set status='archived',
      plan_archived=true,
      plan_archived_at=v_now,
      published_at=null,
      updated_at=v_now
  where p.store_id=v_store_id
    and p.status='live'
    and exists (
      select 1
      from public.store_categories c
      where c.id=p.category_id
        and c.status<>'live'
        and c.plan_archived=true
    );

  -- Then bring live products within the new product limit. Newest live products are archived first.
  if v_max_products <> 9223372036854775807 then
    select count(*) into v_live_products
    from public.products
    where store_id=v_store_id and status='live';

    if v_live_products > v_max_products then
      for v_id in
        select id
        from public.products
        where store_id=v_store_id and status='live'
        order by coalesce(created_at, now()) desc, id desc
        limit (v_live_products - v_max_products)
      loop
        update public.products
        set status='archived', plan_archived=true, plan_archived_at=v_now, published_at=null, updated_at=v_now
        where id=v_id;
      end loop;
    end if;
  end if;

  -- On an actual upgrade/reconciliation, restore only as much plan-archived content as fits
  -- in the currently available capacity. Manual archives are untouched.
  if v_new_rank >= v_old_rank then
    if v_max_categories = 9223372036854775807 then
      loop
        select c.id into v_id
        from public.store_categories c
        where c.store_id=v_store_id
          and c.status='archived'
          and c.plan_archived=true
        order by c.plan_archived_at desc nulls last, c.created_at desc, c.id desc
        limit 1;
        exit when v_id is null;
        update public.store_categories
        set status='live', is_visible=true, plan_archived=false, plan_archived_at=null, updated_at=v_now
        where id=v_id;
        v_id := null;
      end loop;
    else
      select count(*) into v_live_categories
      from public.store_categories
      where store_id=v_store_id and status='live' and is_visible=true;
      v_capacity := greatest(0, v_max_categories - v_live_categories);
      while v_capacity > 0 loop
        select c.id into v_id
        from public.store_categories c
        where c.store_id=v_store_id
          and c.status='archived'
          and c.plan_archived=true
        order by c.plan_archived_at desc nulls last, c.created_at desc, c.id desc
        limit 1;
        exit when v_id is null;
        update public.store_categories
        set status='live', is_visible=true, plan_archived=false, plan_archived_at=null, updated_at=v_now
        where id=v_id;
        v_capacity := v_capacity - 1;
        v_id := null;
      end loop;
    end if;

    if v_max_products = 9223372036854775807 then
      loop
        select p.id into v_id
        from public.products p
        where p.store_id=v_store_id
          and p.status='archived'
          and p.plan_archived=true
          and exists (
            select 1 from public.store_categories c
            where c.id=p.category_id and c.status='live' and c.is_visible=true
          )
        order by p.plan_archived_at desc nulls last, coalesce(p.published_at,p.created_at) desc, p.id desc
        limit 1;
        exit when v_id is null;
        update public.products
        set status='live', plan_archived=false, plan_archived_at=null,
            published_at=coalesce(published_at,v_now), updated_at=v_now
        where id=v_id;
        v_id := null;
      end loop;
    else
      select count(*) into v_live_products
      from public.products
      where store_id=v_store_id and status='live';
      v_capacity := greatest(0, v_max_products - v_live_products);
      while v_capacity > 0 loop
        select p.id into v_id
        from public.products p
        where p.store_id=v_store_id
          and p.status='archived'
          and p.plan_archived=true
          and exists (
            select 1 from public.store_categories c
            where c.id=p.category_id and c.status='live' and c.is_visible=true
          )
        order by p.plan_archived_at desc nulls last, coalesce(p.published_at,p.created_at) desc, p.id desc
        limit 1;
        exit when v_id is null;
        update public.products
        set status='live', plan_archived=false, plan_archived_at=null,
            published_at=coalesce(published_at,v_now), updated_at=v_now
        where id=v_id;
        v_capacity := v_capacity - 1;
        v_id := null;
      end loop;
    end if;
  end if;
end;
$$;

-- Ensure the client-facing reconciliation remains callable only through the safe wrapper.
revoke all on function public.sellora_apply_plan_limits(uuid,text,text) from public, anon, authenticated;
revoke all on function public.sellora_reconcile_plan_change() from public, anon, authenticated;
grant execute on function public.sellora_reconcile_my_plan() to authenticated;

-- Sellora Build 3: live creator-connected commerce foundation.
-- Run after 010_build_1_2_hardening.sql.

alter table public.orders
  add column if not exists payment_account_id uuid references public.payment_accounts(id) on delete set null;

create index if not exists orders_payment_account_idx on public.orders(payment_account_id);

alter table public.payment_transactions
  add column if not exists payment_account_id uuid references public.payment_accounts(id) on delete set null;

create table if not exists public.payment_account_secrets (
  payment_account_id uuid primary key references public.payment_accounts(id) on delete cascade,
  access_token text not null,
  public_token text not null,
  refresh_token text not null,
  access_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_oauth_states (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  state_hash text not null unique,
  redirect_uri text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists payment_oauth_states_creator_idx on public.payment_oauth_states(creator_id, created_at desc);
create index if not exists payment_oauth_states_expiry_idx on public.payment_oauth_states(expires_at);

alter table public.payment_account_secrets enable row level security;
alter table public.payment_oauth_states enable row level security;
revoke all on public.payment_account_secrets from anon, authenticated;
revoke all on public.payment_oauth_states from anon, authenticated;
grant all on public.payment_account_secrets to service_role;
grant all on public.payment_oauth_states to service_role;

-- Creator-visible payment account metadata only; no credentials.
drop policy if exists "owners read payment accounts" on public.payment_accounts;
create policy "owners read payment accounts" on public.payment_accounts
for select to authenticated using (creator_id = auth.uid());

-- Safe public product representation. Never expose paid delivery paths/URLs.
drop view if exists public.public_products;
create view public.public_products with (security_invoker = true) as
select
  p.id,
  p.store_id,
  p.title,
  p.slug,
  p.short_description,
  p.description,
  p.price,
  p.compare_at_price,
  p.currency,
  p.category_id,
  c.name as category_name,
  p.cover_image_path,
  p.gallery,
  p.product_type,
  p.license,
  p.refund_policy,
  p.digital_delivery_type,
  (p.preview_file_path is not null) as has_preview,
  ((p.digital_delivery_type = 'link' and nullif(trim(p.file_access_url),'') is not null)
    or (p.digital_delivery_type <> 'link' and nullif(trim(p.file_path),'') is not null)) as delivery_configured,
  p.status,
  p.visibility,
  p.created_at,
  p.updated_at,
  p.published_at
from public.products p
join public.store_categories c on c.id = p.category_id and c.store_id = p.store_id
join public.stores s on s.id = p.store_id
where p.status = 'live'
  and p.visibility = 'public'
  and c.status = 'live'
  and c.is_visible = true
  and s.status = 'active';

grant select on public.public_products to anon, authenticated;
revoke select on public.products from anon;

-- Explicitly keep provider transaction/event internals server-written.
revoke insert, update, delete on public.payment_transactions from anon, authenticated;
revoke insert, update, delete on public.payment_events from anon, authenticated;

alter table public.orders
  add column if not exists checkout_cancel_token_hash text;
create unique index if not exists orders_checkout_cancel_token_idx on public.orders(checkout_cancel_token_hash) where checkout_cancel_token_hash is not null;

-- Build 3 follow-up hardening.

alter table public.payment_accounts
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists country text,
  add column if not exists default_currency text default 'INR',
  add column if not exists last_synced_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='payment_accounts_status_check_v2') then
    alter table public.payment_accounts add constraint payment_accounts_status_check_v2 check (status in ('pending','connected','needs_action','disconnected','suspended'));
  end if;
end $$;
-- Public product data is exposed only through a safe view, while authenticated creators keep owner access to base products.

drop view if exists public.public_products;
create view public.public_products as
select
  p.id,
  p.store_id,
  p.title,
  p.slug,
  p.short_description,
  p.description,
  p.price,
  p.compare_at_price,
  p.currency,
  p.category_id,
  c.name as category_name,
  p.cover_image_path,
  p.gallery,
  p.product_type,
  p.license,
  p.refund_policy,
  p.digital_delivery_type,
  (p.preview_file_path is not null) as has_preview,
  ((p.digital_delivery_type = 'link' and nullif(trim(p.file_access_url),'') is not null)
    or (p.digital_delivery_type <> 'link' and nullif(trim(p.file_path),'') is not null)) as delivery_configured,
  p.status,
  p.visibility,
  p.created_at,
  p.updated_at,
  p.published_at
from public.products p
join public.store_categories c on c.id = p.category_id and c.store_id = p.store_id
join public.stores s on s.id = p.store_id
where p.status='live'
  and p.visibility='public'
  and c.status='live'
  and c.is_visible=true
  and s.status='active';

grant select on public.public_products to anon, authenticated;
revoke select on public.products from anon;

-- Do not let anonymous clients cancel arbitrary checkout orders.
-- The API now requires a one-time checkout cancellation token held only by the active checkout.

-- A purchase remains deliverable from an order snapshot even when the current product is archived.
comment on column public.orders.payment_account_id is 'Creator-owned payment account used for this checkout.';
comment on column public.orders.checkout_cancel_token_hash is 'Hash of short-lived checkout cancellation token; plaintext token is never stored.';

-- Sellora Build 3: creator-owned Razorpay API credentials (BYOK).
-- Stores only encrypted server-side secrets. Never grant the credential table to anon/authenticated.

create table if not exists public.payment_account_credentials (
  payment_account_id uuid primary key references public.payment_accounts(id) on delete cascade,
  key_id text not null,
  encrypted_key_secret text not null,
  encrypted_webhook_secret text,
  mode text not null default 'test' check (mode in ('test','live')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_account_credentials enable row level security;
revoke all on public.payment_account_credentials from anon, authenticated;
grant all on public.payment_account_credentials to service_role;

create index if not exists payment_account_credentials_key_id_idx on public.payment_account_credentials(key_id);

comment on table public.payment_account_credentials is 'Encrypted creator-provided payment provider credentials. Service role only.';
comment on column public.payment_account_credentials.encrypted_key_secret is 'AES-256-GCM encrypted Razorpay Key Secret; plaintext is never returned to clients.';
comment on column public.payment_account_credentials.encrypted_webhook_secret is 'AES-256-GCM encrypted Razorpay webhook signing secret; nullable for local/legacy setups.';

-- Mark existing creator-connected accounts according to the new connection method when known.
update public.payment_accounts
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('connection_method', 'api_credentials')
where payment_model = 'creator_connected'
  and provider = 'razorpay'
  and exists (select 1 from public.payment_account_credentials c where c.payment_account_id = payment_accounts.id);

-- Sellora refund/finance reconciliation.
-- Creator-side refund reversals are based on seller net, not gross refund amount.
-- Safe to re-run. Customer refund amounts remain stored in approved_amount_minor.

alter table public.refunds
  add column if not exists creator_reversal_minor bigint not null default 0;

create index if not exists refunds_order_status_created_idx
  on public.refunds(order_id, status, created_at);

with succeeded as (
  select
    r.id,
    r.order_id,
    r.approved_amount_minor,
    coalesce(r.completed_at, r.created_at) as effective_at,
    coalesce(o.gross_amount_minor, greatest(0, o.gross_amount * 100)) as gross_minor,
    coalesce(o.seller_net_minor, greatest(0, o.seller_net * 100)) as seller_net_minor,
    sum(r.approved_amount_minor) over (
      partition by r.order_id
      order by coalesce(r.completed_at, r.created_at), r.id
      rows between unbounded preceding and current row
    ) as cumulative_refund_minor
  from public.refunds r
  join public.orders o on o.id = r.order_id
  where r.status = 'succeeded'
), calc_base as (
  select
    *,
    least(gross_minor, cumulative_refund_minor) as capped_cumulative_refund
  from succeeded
  where gross_minor > 0
), calc as (
  select
    *,
    least(
      seller_net_minor,
      round((seller_net_minor * capped_cumulative_refund)::numeric / gross_minor)
    )::bigint as target_cumulative_reversal
  from calc_base
), calc_with_prior as (
  select
    *,
    coalesce(
      lag(target_cumulative_reversal) over (partition by order_id order by effective_at, id),
      0
    ) as prior_cumulative_reversal
  from calc
)
update public.refunds r
set creator_reversal_minor = greatest(0, c.target_cumulative_reversal - c.prior_cumulative_reversal)::bigint
from calc_with_prior c
where r.id = c.id;

update public.ledger_entries l
set
  amount_minor = r.creator_reversal_minor,
  description = 'Creator net reversal for customer refund',
  metadata = jsonb_build_object(
    'refund_id', r.id,
    'gross_refund_minor', r.approved_amount_minor,
    'creator_reversal_minor', r.creator_reversal_minor,
    'basis', 'seller_net_proportional'
  )
from public.refunds r
where l.idempotency_key = 'refund:' || r.id
  and r.status = 'succeeded';

-- Sellora Build 3 production hardening.
-- Run after all existing Build 3 migrations (001-013) and 014_refund_finance_reconciliation.sql.
-- This migration is intentionally additive/idempotent and closes the payment, delivery,
-- checkout, bundle, webhook and plan-reconciliation gaps found in the Build 3 audit.

-- -----------------------------------------------------------------------------
-- 1. Payment account versioning: historical orders keep their original account.
-- -----------------------------------------------------------------------------
alter table public.payment_accounts
  add column if not exists is_current boolean not null default true;

-- The legacy index allowed only one account row per provider/store. Historical
-- account versioning needs multiple rows, but only one CURRENT row.
drop index if exists public.payment_accounts_provider_store_unique;
create unique index if not exists payment_accounts_current_provider_store_unique
  on public.payment_accounts(provider, store_id)
  where store_id is not null and is_current = true;

create index if not exists payment_accounts_creator_current_idx
  on public.payment_accounts(creator_id, provider, is_current, created_at desc);

-- -----------------------------------------------------------------------------
-- 2. Purchased delivery snapshots live on order_items, not current products.
-- -----------------------------------------------------------------------------
alter table public.order_items
  add column if not exists max_downloads integer,
  add column if not exists download_expiry_days integer not null default 30,
  add column if not exists delivery_expires_at timestamptz,
  add column if not exists delivery_manifest jsonb not null default '[]'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='order_items_max_downloads_check_v2') then
    alter table public.order_items
      add constraint order_items_max_downloads_check_v2
      check (max_downloads is null or max_downloads > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='order_items_download_expiry_check_v2') then
    alter table public.order_items
      add constraint order_items_download_expiry_check_v2
      check (download_expiry_days between 1 and 3650);
  end if;
end $$;

-- Deduplicate any accidental historical repeated item before enforcing one item per product/order.
with ranked as (
  select id,
         row_number() over (partition by order_id, product_id order by created_at asc, id asc) as rn
  from public.order_items
  where product_id is not null
)
delete from public.order_items oi
using ranked r
where oi.id = r.id and r.rn > 1;

create unique index if not exists order_items_order_product_unique
  on public.order_items(order_id, product_id)
  where product_id is not null;

-- Backfill missing snapshot controls and expiration for existing purchased items.
update public.order_items oi
set max_downloads = p.max_downloads,
    download_expiry_days = coalesce(p.download_expiry_days, 30),
    delivery_expires_at = case
      when oi.delivery_expires_at is not null then oi.delivery_expires_at
      when o.paid_at is not null then o.paid_at + make_interval(days => coalesce(p.download_expiry_days,30))
      else null
    end,
    delivery_manifest = case
      when oi.delivery_manifest = '[]'::jsonb then coalesce((
        select jsonb_agg(jsonb_build_object('id',pf.id,'filename',pf.filename,'file_path',pf.file_path) order by pf.sort_order asc, pf.created_at asc, pf.id asc)
        from public.product_files pf where pf.product_id = p.id
      ), '[]'::jsonb)
      else oi.delivery_manifest
    end
from public.products p
left join public.orders o on o.id = oi.order_id
where oi.product_id = p.id;

-- -----------------------------------------------------------------------------
-- 3. Active checkout uniqueness must distinguish product checkout from bundle checkout.
-- -----------------------------------------------------------------------------
drop index if exists public.orders_active_checkout_unique;
create unique index if not exists orders_active_checkout_unique
  on public.orders((coalesce(bundle_id, product_id)), buyer_email)
  where status in ('created','pending');

-- -----------------------------------------------------------------------------
-- 4. Current public product projection: one authoritative RLS-aware view.
-- -----------------------------------------------------------------------------
drop view if exists public.public_products;
create view public.public_products with (security_barrier = true) as
select
  p.id,
  p.store_id,
  p.title,
  p.slug,
  p.short_description,
  p.description,
  p.price,
  p.compare_at_price,
  p.currency,
  p.category_id,
  c.name as category_name,
  p.cover_image_path,
  p.gallery,
  p.product_type,
  p.license,
  p.refund_policy,
  p.digital_delivery_type,
  (p.preview_file_path is not null) as has_preview,
  ((p.digital_delivery_type = 'link' and nullif(trim(p.file_access_url),'') is not null)
    or (p.digital_delivery_type <> 'link' and nullif(trim(p.file_path),'') is not null)) as delivery_configured,
  p.status,
  p.visibility,
  p.created_at,
  p.updated_at,
  p.published_at
from public.products p
join public.store_categories c on c.id = p.category_id and c.store_id = p.store_id
join public.stores s on s.id = p.store_id
where p.status='live'
  and p.visibility='public'
  and c.status='live'
  and c.is_visible=true
  and s.status='active';

grant select on public.public_products to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Atomic download-limit enforcement.
-- -----------------------------------------------------------------------------
create or replace function public.sellora_claim_download(p_order_id uuid, p_order_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_download_count integer;
  v_max_downloads integer;
  v_delivery_expires_at timestamptz;
  v_order_status text;
  v_delivery_status text;
  v_download_revoked_at timestamptz;
  v_order_id uuid;
begin
  select o.status, o.delivery_status, o.download_revoked_at, oi.download_count, oi.max_downloads, oi.delivery_expires_at, oi.order_id
    into v_order_status, v_delivery_status, v_download_revoked_at, v_download_count, v_max_downloads, v_delivery_expires_at, v_order_id
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  where oi.id = p_order_item_id
    and oi.order_id = p_order_id
  for update of oi;

  if not found or v_order_status not in ('paid','partially_refunded') or v_delivery_status <> 'available' or v_download_revoked_at is not null then
    return false;
  end if;

  if v_delivery_expires_at is not null and v_delivery_expires_at < now() then
    return false;
  end if;

  if v_max_downloads is not null and v_download_count >= v_max_downloads then
    return false;
  end if;

  update public.order_items
  set download_count = download_count + 1
  where id = p_order_item_id;

  return true;
end;
$$;

revoke all on function public.sellora_claim_download(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sellora_claim_download(uuid,uuid) to service_role;

create or replace function public.sellora_increment_order_download(p_order_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.orders
  set download_count = coalesce(download_count,0) + 1, last_download_at = now()
  where id = p_order_id;
$$;
revoke all on function public.sellora_increment_order_download(uuid) from public, anon, authenticated;
grant execute on function public.sellora_increment_order_download(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 6. Plan restoration: restore only on a TRUE upgrade, never on no-op/same-plan sync.
-- -----------------------------------------------------------------------------
create or replace function public.sellora_apply_plan_limits(
  p_creator_id uuid,
  p_old_plan text default 'free',
  p_new_plan text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_old_rank integer := public.sellora_plan_rank(coalesce(p_old_plan,'free'));
  v_new_rank integer;
  v_now timestamptz := now();
  v_live_categories bigint := 0;
  v_live_products bigint := 0;
  v_capacity bigint := 0;
  v_id uuid;
begin
  select id into v_store_id from public.stores where owner_id=p_creator_id limit 1;
  if v_store_id is null then return; end if;

  v_plan := coalesce(p_new_plan, public.sellora_effective_plan(p_creator_id), 'free');
  v_new_rank := public.sellora_plan_rank(v_plan);
  select max_products,max_categories into v_max_products,v_max_categories
  from public.sellora_plan_limits(v_plan);

  -- First bring live content within the new category limit. Newest live categories are archived first.
  if v_max_categories <> 9223372036854775807 then
    select count(*) into v_live_categories
    from public.store_categories
    where store_id=v_store_id and status='live' and is_visible=true;

    if v_live_categories > v_max_categories then
      for v_id in
        select id
        from public.store_categories
        where store_id=v_store_id and status='live' and is_visible=true
        order by created_at desc, id desc
        limit (v_live_categories - v_max_categories)
      loop
        update public.store_categories
        set status='archived', is_visible=false, plan_archived=true, plan_archived_at=v_now, updated_at=v_now
        where id=v_id;
      end loop;
    end if;
  end if;

  -- Any products inside categories archived by the plan change are taken offline.
  update public.products p
  set status='archived',
      plan_archived=true,
      plan_archived_at=v_now,
      published_at=null,
      updated_at=v_now
  where p.store_id=v_store_id
    and p.status='live'
    and exists (
      select 1
      from public.store_categories c
      where c.id=p.category_id
        and c.status<>'live'
        and c.plan_archived=true
    );

  -- Then bring live products within the new product limit. Newest live products are archived first.
  if v_max_products <> 9223372036854775807 then
    select count(*) into v_live_products
    from public.products
    where store_id=v_store_id and status='live';

    if v_live_products > v_max_products then
      for v_id in
        select id
        from public.products
        where store_id=v_store_id and status='live'
        order by coalesce(created_at, now()) desc, id desc
        limit (v_live_products - v_max_products)
      loop
        update public.products
        set status='archived', plan_archived=true, plan_archived_at=v_now, published_at=null, updated_at=v_now
        where id=v_id;
      end loop;
    end if;
  end if;

  -- On an actual upgrade/reconciliation, restore only as much plan-archived content as fits
  -- in the currently available capacity. Manual archives are untouched.
  if v_new_rank > v_old_rank then
    if v_max_categories = 9223372036854775807 then
      loop
        select c.id into v_id
        from public.store_categories c
        where c.store_id=v_store_id
          and c.status='archived'
          and c.plan_archived=true
        order by c.plan_archived_at desc nulls last, c.created_at desc, c.id desc
        limit 1;
        exit when v_id is null;
        update public.store_categories
        set status='live', is_visible=true, plan_archived=false, plan_archived_at=null, updated_at=v_now
        where id=v_id;
        v_id := null;
      end loop;
    else
      select count(*) into v_live_categories
      from public.store_categories
      where store_id=v_store_id and status='live' and is_visible=true;
      v_capacity := greatest(0, v_max_categories - v_live_categories);
      while v_capacity > 0 loop
        select c.id into v_id
        from public.store_categories c
        where c.store_id=v_store_id
          and c.status='archived'
          and c.plan_archived=true
        order by c.plan_archived_at desc nulls last, c.created_at desc, c.id desc
        limit 1;
        exit when v_id is null;
        update public.store_categories
        set status='live', is_visible=true, plan_archived=false, plan_archived_at=null, updated_at=v_now
        where id=v_id;
        v_capacity := v_capacity - 1;
        v_id := null;
      end loop;
    end if;

    if v_max_products = 9223372036854775807 then
      loop
        select p.id into v_id
        from public.products p
        where p.store_id=v_store_id
          and p.status='archived'
          and p.plan_archived=true
          and exists (
            select 1 from public.store_categories c
            where c.id=p.category_id and c.status='live' and c.is_visible=true
          )
        order by p.plan_archived_at desc nulls last, coalesce(p.published_at,p.created_at) desc, p.id desc
        limit 1;
        exit when v_id is null;
        update public.products
        set status='live', plan_archived=false, plan_archived_at=null,
            published_at=coalesce(published_at,v_now), updated_at=v_now
        where id=v_id;
        v_id := null;
      end loop;
    else
      select count(*) into v_live_products
      from public.products
      where store_id=v_store_id and status='live';
      v_capacity := greatest(0, v_max_products - v_live_products);
      while v_capacity > 0 loop
        select p.id into v_id
        from public.products p
        where p.store_id=v_store_id
          and p.status='archived'
          and p.plan_archived=true
          and exists (
            select 1 from public.store_categories c
            where c.id=p.category_id and c.status='live' and c.is_visible=true
          )
        order by p.plan_archived_at desc nulls last, coalesce(p.published_at,p.created_at) desc, p.id desc
        limit 1;
        exit when v_id is null;
        update public.products
        set status='live', plan_archived=false, plan_archived_at=null,
            published_at=coalesce(published_at,v_now), updated_at=v_now
        where id=v_id;
        v_capacity := v_capacity - 1;
        v_id := null;
      end loop;
    end if;
  end if;
end;
$$;


revoke all on function public.sellora_apply_plan_limits(uuid,text,text) from public, anon, authenticated;
revoke all on function public.sellora_reconcile_plan_change() from public, anon, authenticated;
grant execute on function public.sellora_reconcile_my_plan() to authenticated;

-- Documentation for the historical-account invariant.
comment on column public.payment_accounts.is_current is 'Exactly one current creator/provider account per store; historical disconnected accounts remain for audit and refunds.';
comment on column public.order_items.delivery_manifest is 'Immutable purchased-file manifest. Delivery uses this snapshot rather than current product files.';
comment on column public.order_items.delivery_expires_at is 'Snapshot of this item delivery expiration, calculated from the paid timestamp.';
-- Sellora Build 4 + Build 5
-- Creator subscriptions, versioned provider plans, admin reprovisioning support,
-- subscription lifecycle persistence, entitlement reconciliation, and production hardening.

create table if not exists public.sellora_plans (
  plan_key text primary key check (plan_key in ('free','creator','pro','max')),
  name text not null,
  description text,
  price_minor bigint not null default 0 check (price_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  billing_period text not null default 'monthly' check (billing_period in ('monthly','yearly')),
  max_products bigint not null,
  max_categories bigint not null,
  features jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  grace_period_days integer not null default 3 check (grace_period_days between 0 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sellora_plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references public.sellora_plans(plan_key) on delete cascade,
  version_no integer not null check (version_no > 0),
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  billing_period text not null default 'monthly' check (billing_period in ('monthly','yearly')),
  environment text not null check (environment in ('test','live')),
  provider text not null default 'razorpay',
  provider_plan_id text,
  status text not null default 'unprovisioned' check (status in ('current','retired','unprovisioned','failed')),
  is_current boolean not null default false,
  provisioning_error text,
  provisioned_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  unique(plan_key, version_no, environment)
);
create unique index if not exists sellora_plan_versions_current_idx
  on public.sellora_plan_versions(plan_key, environment) where is_current = true;
create unique index if not exists sellora_plan_versions_provider_id_idx
  on public.sellora_plan_versions(environment, provider_plan_id)
  where provider_plan_id is not null;
create index if not exists sellora_plan_versions_plan_idx
  on public.sellora_plan_versions(plan_key, environment, created_at desc);

create table if not exists public.sellora_subscriptions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  plan_key text not null references public.sellora_plans(plan_key),
  plan_version_id uuid references public.sellora_plan_versions(id) on delete set null,
  environment text not null default 'test' check (environment in ('test','live')),
  provider text not null default 'razorpay',
  provider_subscription_id text not null unique,
  provider_plan_id text,
  provider_customer_id text,
  customer_email text,
  customer_contact text,
  status text not null default 'created' check (status in ('created','authenticated','active','pending','halted','paused','cancelled','completed','expired','failed')),
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  quantity integer not null default 1 check (quantity > 0),
  total_count integer,
  paid_count integer not null default 0,
  remaining_count integer,
  current_start timestamptz,
  current_end timestamptz,
  charge_at timestamptz,
  start_at timestamptz,
  end_at timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  pending_plan_key text references public.sellora_plans(plan_key),
  pending_plan_version_id uuid references public.sellora_plan_versions(id) on delete set null,
  pending_change_at text check (pending_change_at is null or pending_change_at in ('now','cycle_end')),
  last_provider_event_at timestamptz,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  confirmation_email_sent_at timestamptz,
  failure_email_sent_at timestamptz,
  cancellation_email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sellora_one_open_subscription_per_creator
  on public.sellora_subscriptions(creator_id)
  where status in ('created','authenticated','active','pending','paused','halted');
create index if not exists sellora_subscriptions_creator_idx
  on public.sellora_subscriptions(creator_id, created_at desc);
create index if not exists sellora_subscriptions_status_idx
  on public.sellora_subscriptions(status, current_end);
create index if not exists sellora_subscriptions_plan_idx
  on public.sellora_subscriptions(environment, plan_key, status);

create table if not exists public.sellora_subscription_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'razorpay',
  provider_event_id text not null,
  event_type text not null,
  provider_subscription_id text,
  provider_payment_id text,
  signature_verified boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error_message text,
  unique(provider, provider_event_id)
);
create index if not exists sellora_subscription_events_sub_idx
  on public.sellora_subscription_events(provider_subscription_id, received_at desc);

create table if not exists public.sellora_subscription_payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.sellora_subscriptions(id) on delete cascade,
  provider_payment_id text not null unique,
  provider_invoice_id text,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('authorized','captured','failed','refunded','partially_refunded','pending')),
  payment_method text,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  renewal_email_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists sellora_subscription_payments_sub_idx
  on public.sellora_subscription_payments(subscription_id, created_at desc);

create table if not exists public.sellora_billing_audits (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  plan_key text,
  subscription_id uuid references public.sellora_subscriptions(id) on delete set null,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sellora_billing_audits_created_idx
  on public.sellora_billing_audits(created_at desc);

alter table public.creator_access_grants add column if not exists expiration_notice_sent_at timestamptz;

insert into public.sellora_plans(plan_key,name,description,price_minor,currency,billing_period,max_products,max_categories,features)
values
 ('free','Free','A simple starting plan.',0,'INR','monthly',1,1,'{"link_hub":true,"store":true,"checkout":true,"email_capture":true,"coupons":false,"bundles":false,"upsells":false,"branding":true,"analytics":"basic","custom_domain":false}'::jsonb),
 ('creator','Creator','For growing independent creators.',19900,'INR','monthly',10,2,'{"link_hub":true,"store":true,"checkout":true,"email_capture":true,"coupons":true,"bundles":true,"upsells":true,"branding":false,"analytics":"standard","custom_domain":false}'::jsonb),
 ('pro','Pro','For established creators with larger catalogs.',49900,'INR','monthly',9223372036854775807,10,'{"link_hub":true,"store":true,"checkout":true,"email_capture":true,"coupons":true,"bundles":true,"upsells":true,"branding":false,"analytics":"advanced","custom_domain":true}'::jsonb),
 ('max','Max','Maximum Sellora storefront capacity.',99900,'INR','monthly',9223372036854775807,9223372036854775807,'{"link_hub":true,"store":true,"checkout":true,"email_capture":true,"coupons":true,"bundles":true,"upsells":true,"branding":false,"analytics":"advanced","custom_domain":true}'::jsonb)
on conflict (plan_key) do nothing;

insert into public.sellora_plan_versions(plan_key,version_no,amount_minor,currency,billing_period,environment,status,is_current)
select p.plan_key, 1, p.price_minor, p.currency, p.billing_period,
       env.environment,
       case when p.plan_key='free' then 'current' else 'unprovisioned' end,
       case when p.plan_key='free' then true else false end
from public.sellora_plans p
cross join (values ('test'),('live')) env(environment)
where not exists (
  select 1 from public.sellora_plan_versions v
  where v.plan_key=p.plan_key and v.version_no=1 and v.environment=env.environment
);

alter table public.sellora_plans enable row level security;
alter table public.sellora_plan_versions enable row level security;
alter table public.sellora_subscriptions enable row level security;
alter table public.sellora_subscription_events enable row level security;
alter table public.sellora_subscription_payments enable row level security;
alter table public.sellora_billing_audits enable row level security;

drop policy if exists "public read active sellora plans" on public.sellora_plans;
create policy "public read active sellora plans" on public.sellora_plans
for select to anon, authenticated using (active = true);

drop policy if exists "sellora plan versions service only" on public.sellora_plan_versions;
create policy "sellora plan versions service only" on public.sellora_plan_versions
for all to anon, authenticated using (false) with check (false);

drop policy if exists "creators read own subscriptions" on public.sellora_subscriptions;
create policy "creators read own subscriptions" on public.sellora_subscriptions
for select to authenticated using ((select auth.uid()) = creator_id);

drop policy if exists "sellora subscription events service only" on public.sellora_subscription_events;
create policy "sellora subscription events service only" on public.sellora_subscription_events
for all to anon, authenticated using (false) with check (false);

drop policy if exists "creators read own subscription payments" on public.sellora_subscription_payments;
create policy "creators read own subscription payments" on public.sellora_subscription_payments
for select to authenticated using (
  exists (
    select 1 from public.sellora_subscriptions s
    where s.id = sellora_subscription_payments.subscription_id
      and s.creator_id = (select auth.uid())
  )
);

drop policy if exists "sellora billing audits service only" on public.sellora_billing_audits;
create policy "sellora billing audits service only" on public.sellora_billing_audits
for all to anon, authenticated using (false) with check (false);

-- Explicit deny policies for service-only tables suppress accidental exposure while
-- preserving service-role access (service role bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['adjustments','audit_logs','creator_access_grants','payment_account_credentials','payment_account_secrets','payment_oauth_states','security_events','platform_settings'] loop
    execute format('drop policy if exists %I on public.%I', 'service-only deny public roles', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', 'service-only deny public roles', t);
  end loop;
end$$;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to postgres, service_role;

-- Preserve admin grants as the highest-priority entitlement source. A subscription
-- must not silently overwrite a complimentary/permanent/trial grant.
create or replace function private.sellora_reconcile_creator_plan(p_creator_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_grant public.creator_access_grants%rowtype;
  v_sub public.sellora_subscriptions%rowtype;
  v_plan text := 'free';
  v_expiry timestamptz := null;
  v_source text := 'subscription';
  v_grant_id uuid := null;
begin
  update public.creator_access_grants
  set status='expired', updated_at=now()
  where creator_id=p_creator_id and status in ('pending','active')
    and expires_at is not null and expires_at <= now();

  select * into v_grant
  from public.creator_access_grants g
  where g.creator_id=p_creator_id
    and g.status='active'
    and g.starts_at <= now()
    and (g.expires_at is null or g.expires_at > now())
  order by case when g.access_type='permanent' then 0 else 1 end, g.created_at desc
  limit 1;

  if found then
    v_plan := v_grant.plan;
    v_expiry := v_grant.expires_at;
    v_source := v_grant.access_type;
    v_grant_id := v_grant.id;
  else
    select * into v_sub
    from public.sellora_subscriptions s
    where s.creator_id=p_creator_id
    order by case when s.status in ('active','authenticated','pending','paused','halted') then 0 else 1 end,
             s.updated_at desc
    limit 1;

    if found then
      if v_sub.status in ('active','authenticated','pending','paused') then
        v_plan := v_sub.plan_key;
        v_expiry := coalesce(v_sub.current_end, v_sub.end_at);
      elsif v_sub.status='halted' then
        v_plan := v_sub.plan_key;
        select (coalesce(v_sub.current_end, v_sub.end_at) + make_interval(days => coalesce(p.grace_period_days,0)))
          into v_expiry
        from public.sellora_plans p where p.plan_key=v_sub.plan_key;
      else
        v_plan := 'free';
        v_expiry := null;
      end if;
    end if;
  end if;

  insert into public.creator_plans(creator_id,plan,access_source,access_starts_at,access_expires_at,access_grant_id,updated_at)
  values (p_creator_id,v_plan,v_source,now(),v_expiry,v_grant_id,now())
  on conflict (creator_id) do update set
    plan=excluded.plan,
    access_source=excluded.access_source,
    access_starts_at=now(),
    access_expires_at=excluded.access_expires_at,
    access_grant_id=excluded.access_grant_id,
    updated_at=now();
end;
$$;
revoke all on function private.sellora_reconcile_creator_plan(uuid) from public, anon, authenticated;
grant execute on function private.sellora_reconcile_creator_plan(uuid) to postgres, service_role;

create or replace function public.sellora_sync_subscription_entitlement(p_creator_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if not exists (select 1 from public.profiles where id=p_creator_id) then raise exception 'Creator not found'; end if;
  perform private.sellora_reconcile_creator_plan(p_creator_id);
end;
$$;
revoke all on function public.sellora_sync_subscription_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.sellora_sync_subscription_entitlement(uuid) to service_role;

create or replace function public.sellora_subscription_entitlement_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  perform private.sellora_reconcile_creator_plan(coalesce(new.creator_id,old.creator_id));
  return new;
end;
$$;
revoke all on function public.sellora_subscription_entitlement_trigger() from public, anon, authenticated;
drop trigger if exists trg_sellora_subscription_entitlement on public.sellora_subscriptions;
create trigger trg_sellora_subscription_entitlement
after update of plan_key, status, current_end, end_at
on public.sellora_subscriptions
for each row execute function public.sellora_subscription_entitlement_trigger();

create or replace function public.sellora_reconcile_my_plan()
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode='42501', message='UNAUTHORIZED';
  end if;
  -- Backwards-compatible RPC surface. Privileged reconciliation is handled
  -- by the trusted subscription/grant synchronization path.
  perform public.sellora_effective_plan((select auth.uid()));
end;
$$;
revoke all on function public.sellora_reconcile_my_plan() from public, anon;
grant execute on function public.sellora_reconcile_my_plan() to authenticated;

create or replace function public.sellora_plan_limits(p_plan text)
returns table(max_products bigint, max_categories bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select p.max_products, p.max_categories
  from public.sellora_plans p
  where p.plan_key=coalesce(p_plan,'free') and p.active=true
  union all
  select 1::bigint,1::bigint
  where not exists (
    select 1 from public.sellora_plans p
    where p.plan_key=coalesce(p_plan,'free') and p.active=true
  )
  limit 1;
$$;
revoke all on function public.sellora_plan_limits(text) from public, anon;
grant execute on function public.sellora_plan_limits(text) to authenticated, service_role;

-- Updated timestamps for mutable catalog rows.
create or replace function public.sellora_touch_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;
drop trigger if exists trg_sellora_plans_updated_at on public.sellora_plans;
create trigger trg_sellora_plans_updated_at before update on public.sellora_plans for each row execute function public.sellora_touch_updated_at();

comment on table public.sellora_plans is 'Sellora subscription catalog. Admin-editable customer-facing SaaS prices and limits.';
comment on table public.sellora_plan_versions is 'Versioned provider plan records. Every pricing reprovision creates a new provider plan version.';
comment on table public.sellora_subscriptions is 'Canonical Sellora creator subscriptions synchronized with the billing provider.';
comment on table public.sellora_subscription_events is 'Idempotent, verified provider subscription webhooks.';
comment on table public.sellora_billing_audits is 'Admin/operator audit history for pricing, reprovisioning and subscription actions.';

-- Build 5 security final: keep trigger search_path deterministic.
create or replace function public.sellora_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- SELLORA customer identity + Resend email audit additions (production build)
alter table public.orders
  add column if not exists customer_id uuid references public.profiles(id) on delete set null;
create index if not exists orders_customer_id_created_idx on public.orders(customer_id, created_at desc);

create table if not exists public.sellora_email_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  event_type text not null,
  recipient text not null,
  subject text not null,
  template_key text not null,
  entity_type text,
  entity_id uuid,
  provider text not null default 'resend',
  provider_message_id text,
  status text not null default 'queued' check (status in ('queued','processing','sent','retrying','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sellora_email_events_status_created_idx on public.sellora_email_events(status, created_at desc);
create index if not exists sellora_email_events_recipient_created_idx on public.sellora_email_events(recipient, created_at desc);
alter table public.sellora_email_events enable row level security;
drop policy if exists "sellora email events service only" on public.sellora_email_events;
create policy "sellora email events service only" on public.sellora_email_events for all to anon, authenticated using (false) with check (false);
drop policy if exists "customers read own orders" on public.orders;
create policy "customers read own orders" on public.orders for select to authenticated using (auth.uid() = customer_id);

create or replace function public.sellora_link_guest_orders_to_user(p_user_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare user_email text; linked_count integer;
begin
  select lower(email) into user_email from auth.users where id = p_user_id;
  if user_email is null then return 0; end if;
  update public.orders set customer_id = p_user_id, updated_at = now() where customer_id is null and lower(buyer_email) = user_email;
  get diagnostics linked_count = row_count; return linked_count;
end; $$;
revoke all on function public.sellora_link_guest_orders_to_user(uuid) from public, anon, authenticated;
grant execute on function public.sellora_link_guest_orders_to_user(uuid) to service_role;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1))) on conflict (id) do nothing;
  update public.orders set customer_id = new.id, updated_at = now() where customer_id is null and lower(buyer_email) = lower(new.email);
  return new;
end; $$;
update public.orders o set customer_id = u.id, updated_at = now() from auth.users u where o.customer_id is null and lower(o.buyer_email) = lower(u.email);
