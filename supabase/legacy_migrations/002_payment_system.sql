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
