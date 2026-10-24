-- Build 8.1: normalize the existing persisted plan feature catalog.
-- Prices, plan rows, subscriptions, and historical plan versions are unchanged.

update public.sellora_plans
set features = case plan_key
  when 'free' then jsonb_build_object(
    'link_hub', true, 'store', true, 'checkout', true, 'email_capture', true,
    'coupons', false, 'bundles', false, 'upsells', false,
    'branding', true, 'analytics', 'basic', 'custom_domain', false
  )
  when 'creator' then jsonb_build_object(
    'link_hub', true, 'store', true, 'checkout', true, 'email_capture', true,
    'coupons', true, 'bundles', true, 'upsells', true,
    'branding', false, 'analytics', 'standard', 'custom_domain', false
  )
  when 'pro' then jsonb_build_object(
    'link_hub', true, 'store', true, 'checkout', true, 'email_capture', true,
    'coupons', true, 'bundles', true, 'upsells', true,
    'branding', false, 'analytics', 'advanced', 'custom_domain', true
  )
  when 'max' then jsonb_build_object(
    'link_hub', true, 'store', true, 'checkout', true, 'email_capture', true,
    'coupons', true, 'bundles', true, 'upsells', true,
    'branding', false, 'analytics', 'advanced', 'custom_domain', true
  )
  else coalesce(features, '{}'::jsonb)
end,
updated_at = now()
where plan_key in ('free', 'creator', 'pro', 'max');

create or replace function public.sellora_creator_has_feature(p_creator_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((sp.features ->> p_feature)::boolean, false)
  from public.creator_plans cp
  join public.sellora_plans sp on sp.plan_key = case
    when cp.access_starts_at is not null and cp.access_starts_at > now() then 'free'
    when cp.access_expires_at is not null and cp.access_expires_at <= now() then 'free'
    else cp.plan
  end and sp.active = true
  where cp.creator_id = p_creator_id;
$$;
revoke all on function public.sellora_creator_has_feature(uuid, text) from public, anon, authenticated;
grant execute on function public.sellora_creator_has_feature(uuid, text) to authenticated, service_role;

drop policy if exists "owners manage coupons" on public.coupons;
create policy "entitled owners manage coupons" on public.coupons
for all to authenticated
using (exists (select 1 from public.stores s where s.id = coupons.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'coupons')))
with check (exists (select 1 from public.stores s where s.id = coupons.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'coupons')));

drop policy if exists "owners manage bundles" on public.bundles;
create policy "entitled owners manage bundles" on public.bundles
for all to authenticated
using (exists (select 1 from public.stores s where s.id = bundles.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'bundles')))
with check (exists (select 1 from public.stores s where s.id = bundles.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'bundles')));

drop policy if exists "owners manage bundle items" on public.bundle_items;
create policy "entitled owners manage bundle items" on public.bundle_items
for all to authenticated
using (exists (select 1 from public.bundles b join public.stores s on s.id = b.store_id where b.id = bundle_items.bundle_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'bundles')))
with check (exists (select 1 from public.bundles b join public.stores s on s.id = b.store_id where b.id = bundle_items.bundle_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'bundles')));

drop policy if exists "owners manage upsells" on public.upsells;
create policy "entitled owners manage upsells" on public.upsells
for all to authenticated
using (exists (select 1 from public.stores s where s.id = upsells.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'upsells')))
with check (exists (select 1 from public.stores s where s.id = upsells.store_id and s.owner_id = auth.uid() and public.sellora_creator_has_feature(s.owner_id, 'upsells')));