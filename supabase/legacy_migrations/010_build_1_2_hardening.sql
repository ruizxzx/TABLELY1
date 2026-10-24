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
