-- Build 21: make analytics events safely idempotent across React retries, duplicate mounts, and payment re-entry.
alter table public.store_analytics_events
  add column if not exists event_id text;

create unique index if not exists store_analytics_events_event_id_uidx
  on public.store_analytics_events(event_id);

create index if not exists store_analytics_events_store_visitor_idx
  on public.store_analytics_events(store_id, visitor_id, created_at desc);

create index if not exists store_analytics_events_store_session_idx
  on public.store_analytics_events(store_id, session_id, created_at desc);
