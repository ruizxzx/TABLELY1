-- TABLELY BUILD 17 — order lifecycle enum extension
-- This migration intentionally contains only the enum addition so PostgreSQL
-- commits the new value before the main Build 17 migration creates RPCs that use it.
alter type public.order_status add value if not exists 'REJECTED';
