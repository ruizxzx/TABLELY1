-- public_products is a deliberately column-restricted, row-filtered public
-- projection. Keep base products protected while allowing anonymous storefront
-- pages to read the published projection.
alter view public.public_products set (security_barrier = true, security_invoker = false);
