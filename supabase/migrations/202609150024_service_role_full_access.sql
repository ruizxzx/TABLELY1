-- TABLELY: comprehensive service-role table privileges.
--
-- Root cause of "permission denied for table restaurant_charge_settings"
-- (and the earlier, narrower "permission denied" bugs on other tables):
-- the app's server-only Supabase admin client authenticates as
-- `service_role`, but `service_role` bypassing RLS is a *separate*
-- Postgres concept from having table GRANTs. New tables created by a
-- migration are NOT automatically readable/writable by service_role
-- unless a GRANT (or a default-privilege rule) says so. Every time a new
-- table was added (restaurant_charge_settings, restaurant_payment_settings,
-- and likely others going forward), it silently lacked this grant.
--
-- Fix it once, comprehensively, and make it self-maintaining:
--   1. Grant full privileges to service_role on every table that exists now.
--   2. Set a default-privilege rule so every table created by a FUTURE
--      migration (run as the same role) grants service_role access
--      automatically, with no follow-up migration required.

grant usage on schema public to service_role;

grant select, insert, update, delete
on all tables in schema public
to service_role;

grant usage, select
on all sequences in schema public
to service_role;

grant execute
on all functions in schema public
to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges in schema public
  grant usage, select on sequences to service_role;

alter default privileges in schema public
  grant execute on functions to service_role;

-- Force PostgREST to refresh its schema/privilege cache immediately.
notify pgrst, 'reload schema';
