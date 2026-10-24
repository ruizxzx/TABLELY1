-- Reconcile stale products so a live product is public and visible in the storefront.

update public.products
set visibility = 'public'
where status = 'live'
  and visibility is distinct from 'public';

alter table public.products
  alter column visibility set default 'public';

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
  coalesce(p.visibility, 'public') as visibility,
  p.created_at,
  p.updated_at,
  p.published_at,
  p.sort_order
from public.products p
join public.store_categories c on c.id = p.category_id and c.store_id = p.store_id
join public.stores s on s.id = p.store_id
where p.status = 'live'
  and coalesce(p.visibility, 'public') = 'public'
  and c.status = 'live'
  and c.is_visible = true
  and s.status = 'active';

grant select on public.public_products to anon, authenticated;
