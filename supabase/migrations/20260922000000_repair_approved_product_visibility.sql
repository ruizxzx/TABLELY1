-- Repair already-approved products so the public storefront can resolve their category.
insert into public.store_categories (store_id, name, slug, sort_order, status, is_visible)
select distinct p.store_id, 'Products', 'products', 0, 'live', true
from public.products p
where p.status = 'live'
  and p.visibility = 'public'
  and p.category_id is null
  and not exists (
    select 1 from public.store_categories c
    where c.store_id = p.store_id and c.slug = 'products'
  )
on conflict (store_id, slug) do update set status = 'live', is_visible = true, updated_at = now();

update public.products p
set category_id = c.id, updated_at = now()
from public.store_categories c
where p.status = 'live'
  and p.visibility = 'public'
  and p.category_id is null
  and c.store_id = p.store_id
  and c.slug = 'products';

update public.store_categories c
set status = 'live', is_visible = true, plan_archived = false, plan_archived_at = null, updated_at = now()
where exists (
  select 1 from public.products p
  where p.category_id = c.id and p.status = 'live' and p.visibility = 'public'
);
