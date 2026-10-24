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
create policy "owners manage coupons" on public.coupons for all to authenticated using (exists (select 1 from public.stores s where s.id = coupons.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = coupons.store_id and s.owner_id = auth.uid()));
drop policy if exists "owners read redemptions" on public.coupon_redemptions;
create policy "owners read redemptions" on public.coupon_redemptions for select to authenticated using (exists (select 1 from public.coupons c join public.stores s on s.id = c.store_id where c.id = coupon_redemptions.coupon_id and s.owner_id = auth.uid()));
drop policy if exists "owners manage bundles" on public.bundles;
create policy "owners manage bundles" on public.bundles for all to authenticated using (exists (select 1 from public.stores s where s.id = bundles.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = bundles.store_id and s.owner_id = auth.uid()));
drop policy if exists "public read live bundles" on public.bundles;
create policy "public read live bundles" on public.bundles for select to anon, authenticated using (status = 'live' and exists (select 1 from public.stores s where s.id = bundles.store_id and s.status = 'active'));
drop policy if exists "owners manage bundle items" on public.bundle_items;
create policy "owners manage bundle items" on public.bundle_items for all to authenticated using (exists (select 1 from public.bundles b join public.stores s on s.id = b.store_id where b.id = bundle_items.bundle_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.bundles b join public.stores s on s.id = b.store_id where b.id = bundle_items.bundle_id and s.owner_id = auth.uid()));
drop policy if exists "public read live bundle items" on public.bundle_items;
create policy "public read live bundle items" on public.bundle_items for select to anon, authenticated using (exists (select 1 from public.bundles b join public.stores s on s.id = b.store_id where b.id = bundle_items.bundle_id and b.status = 'live' and s.status = 'active'));
drop policy if exists "owners manage upsells" on public.upsells;
create policy "owners manage upsells" on public.upsells for all to authenticated using (exists (select 1 from public.stores s where s.id = upsells.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = upsells.store_id and s.owner_id = auth.uid()));
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
