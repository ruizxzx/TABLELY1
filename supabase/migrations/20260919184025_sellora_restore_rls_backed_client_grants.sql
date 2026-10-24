-- Restore the PostgREST table privileges required by existing RLS-backed
-- browser/public storefront and creator workspace flows. RLS remains the
-- authorization boundary; service-only Sellora billing/content tables remain
-- service-only.
grant select on public.stores to anon, authenticated;
grant all on public.stores to authenticated;

grant select on public.store_categories to anon, authenticated;
grant all on public.store_categories to authenticated;

grant all on public.products to authenticated;

grant select on public.bundles to anon, authenticated;
grant all on public.bundles to authenticated;
grant select on public.bundle_items to anon, authenticated;
grant all on public.bundle_items to authenticated;
grant select on public.upsells to anon, authenticated;
grant all on public.upsells to authenticated;

grant all on public.profiles to authenticated;

grant all on public.custom_domains to authenticated;

grant select on public.order_items to authenticated;
grant select on public.orders to authenticated;
grant select on public.payment_accounts to authenticated;
grant select on public.payment_transactions to authenticated;
grant all on public.product_files to authenticated;
grant all on public.product_variants to authenticated;
grant all on public.product_versions to authenticated;
grant select on public.product_license_keys to authenticated;
grant select on public.creator_plans to authenticated;
