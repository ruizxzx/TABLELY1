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
