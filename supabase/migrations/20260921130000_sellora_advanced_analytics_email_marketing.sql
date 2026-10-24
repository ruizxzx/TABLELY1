-- Additive analytics attribution and email marketing foundation.
-- No existing orders, payments, Bento data, or subscribers are deleted.

alter table public.store_analytics_events
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists referrer text,
  add column if not exists visitor_id text,
  add column if not exists device_type text,
  add column if not exists country_code text,
  add column if not exists checkout_id uuid references public.orders(id) on delete set null;

create index if not exists store_analytics_events_store_created_type_idx
  on public.store_analytics_events(store_id, event_type, created_at desc);
create index if not exists store_analytics_events_store_utm_idx
  on public.store_analytics_events(store_id, utm_source, utm_campaign, created_at desc);

alter table public.email_subscribers
  add column if not exists status text not null default 'active' check (status in ('active','unsubscribed','bounced','suppressed')),
  add column if not exists unsubscribed_at timestamptz,
  add column if not exists last_seen_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.email_subscriber_tags (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique(store_id, name)
);

create table if not exists public.email_subscriber_tag_members (
  subscriber_id uuid not null references public.email_subscribers(id) on delete cascade,
  tag_id uuid not null references public.email_subscriber_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(subscriber_id, tag_id)
);

create table if not exists public.email_segments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, name)
);

create table if not exists public.email_campaigns (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  subject text not null,
  preview_text text,
  content_html text not null,
  audience jsonb not null default '{"type":"all"}'::jsonb,
  status text not null default 'draft' check (status in ('draft','scheduled','sending','sent','failed')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  subscriber_id uuid not null references public.email_subscribers(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','sent','failed','bounced','unsubscribed')),
  provider_message_id text,
  sent_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  error_message text,
  unique(campaign_id, subscriber_id)
);

create table if not exists public.email_automations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  trigger_type text not null check (trigger_type in ('new_subscriber','customer_purchase','day_after_signup','segment_match')),
  campaign_id uuid not null references public.email_campaigns(id) on delete cascade,
  segment_id uuid references public.email_segments(id) on delete set null,
  enabled boolean not null default true,
  delay_seconds integer not null default 0,
  next_run_at timestamptz,
  last_triggered_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, trigger_type)
);

create table if not exists public.analytics_integrations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  provider text not null check (provider in ('google_analytics','meta_pixel','tiktok_pixel')),
  measurement_id text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(store_id, provider)
);

alter table public.email_subscriber_tags enable row level security;
alter table public.email_subscriber_tag_members enable row level security;
alter table public.email_segments enable row level security;
alter table public.email_campaigns enable row level security;
alter table public.email_campaign_recipients enable row level security;
alter table public.email_automations enable row level security;
alter table public.analytics_integrations enable row level security;

drop policy if exists "owners manage subscriber tags" on public.email_subscriber_tags;
create policy "owners manage subscriber tags" on public.email_subscriber_tags for all to authenticated using (exists (select 1 from public.stores s where s.id = email_subscriber_tags.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = email_subscriber_tags.store_id and s.owner_id = auth.uid()));
drop policy if exists "owners manage subscriber tag members" on public.email_subscriber_tag_members;
create policy "owners manage subscriber tag members" on public.email_subscriber_tag_members for all to authenticated using (exists (select 1 from public.email_subscribers e join public.stores s on s.id = e.store_id where e.id = email_subscriber_tag_members.subscriber_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.email_subscribers e join public.stores s on s.id = e.store_id where e.id = email_subscriber_tag_members.subscriber_id and s.owner_id = auth.uid()));
drop policy if exists "owners manage email segments" on public.email_segments;
create policy "owners manage email segments" on public.email_segments for all to authenticated using (exists (select 1 from public.stores s where s.id = email_segments.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = email_segments.store_id and s.owner_id = auth.uid()));
drop policy if exists "owners manage email campaigns" on public.email_campaigns;
create policy "owners manage email campaigns" on public.email_campaigns for all to authenticated using (exists (select 1 from public.stores s where s.id = email_campaigns.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = email_campaigns.store_id and s.owner_id = auth.uid()));
drop policy if exists "owners read campaign recipients" on public.email_campaign_recipients;
create policy "owners read campaign recipients" on public.email_campaign_recipients for select to authenticated using (exists (select 1 from public.email_campaigns c join public.stores s on s.id = c.store_id where c.id = email_campaign_recipients.campaign_id and s.owner_id = auth.uid()));
drop policy if exists "owners manage email automations" on public.email_automations;
create policy "owners manage email automations" on public.email_automations for all to authenticated using (exists (select 1 from public.stores s where s.id = email_automations.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = email_automations.store_id and s.owner_id = auth.uid()));
drop policy if exists "owners manage analytics integrations" on public.analytics_integrations;
create policy "owners manage analytics integrations" on public.analytics_integrations for all to authenticated using (exists (select 1 from public.stores s where s.id = analytics_integrations.store_id and s.owner_id = auth.uid())) with check (exists (select 1 from public.stores s where s.id = analytics_integrations.store_id and s.owner_id = auth.uid()));

grant all on public.email_subscriber_tags, public.email_subscriber_tag_members, public.email_segments, public.email_campaigns, public.email_campaign_recipients, public.email_automations, public.analytics_integrations to service_role;

update public.sellora_plans
set features = coalesce(features, '{}'::jsonb) || case plan_key
  when 'free' then '{"email_marketing": false, "analytics_integrations": false}'::jsonb
  when 'creator' then '{"email_marketing": true, "analytics_integrations": false}'::jsonb
  when 'pro' then '{"email_marketing": true, "analytics_integrations": false}'::jsonb
  when 'max' then '{"email_marketing": true, "analytics_integrations": true}'::jsonb
  else '{}'::jsonb
end, updated_at = now()
where plan_key in ('free','creator','pro','max');