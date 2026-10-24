-- Public storefronts use this column-restricted view through the anon role.
-- Keep the underlying products table private while allowing the view to execute
-- with its owner privileges.

alter view public.public_products
  set (security_invoker = false, security_barrier = true);

grant select on public.public_products to anon, authenticated;
