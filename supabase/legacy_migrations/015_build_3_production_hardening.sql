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
