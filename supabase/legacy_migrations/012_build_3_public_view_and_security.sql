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
