-- Additive Bento foundation: block configs remain in stores.link_hub_config.
-- This migration only extends analytics storage and the canonical plan feature catalog.

alter table public.store_analytics_events add column if not exists link_id text;
alter table public.store_analytics_events drop constraint if exists store_analytics_events_event_type_check;
alter table public.store_analytics_events add constraint store_analytics_events_event_type_check
  check (event_type in ('visit','link_click','product_view','checkout_start','purchase','email_subscribe'));
create index if not exists store_analytics_events_store_link_idx
  on public.store_analytics_events(store_id, link_id, created_at desc);

update public.sellora_plans
set features = coalesce(features, '{}'::jsonb) || case plan_key
  when 'free' then '{"advanced_layouts": false, "link_scheduling": false, "link_thumbnails": false}'::jsonb
  when 'creator' then '{"advanced_layouts": true, "link_scheduling": true, "link_thumbnails": true}'::jsonb
  when 'pro' then '{"advanced_layouts": true, "link_scheduling": true, "link_thumbnails": true}'::jsonb
  when 'max' then '{"advanced_layouts": true, "link_scheduling": true, "link_thumbnails": true}'::jsonb
  else '{}'::jsonb
end,
updated_at = now()
where plan_key in ('free', 'creator', 'pro', 'max');

revoke all on public.store_analytics_events from anon, authenticated;
grant insert on public.store_analytics_events to anon, authenticated;
grant select on public.store_analytics_events to authenticated;
grant all on public.store_analytics_events to service_role;
