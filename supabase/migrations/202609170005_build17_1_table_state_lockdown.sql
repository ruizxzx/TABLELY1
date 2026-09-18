-- TABLELY BUILD 17.1 — close a direct-write gap on server-derived table state
--
-- Bug found in QA: 202609170004 added operational_state, occupancy_count and
-- operational_updated_at to public.tables and made
-- build17_sync_table_operational_state() the sole intended authority for
-- them. But the pre-existing grant/RLS on public.tables is table-level
-- ("grant ... update ... to authenticated" + a branch-role RLS policy with
-- no column restriction), so any Manager/Owner able to edit a table (which
-- is expected -- they can rename it, change seats, etc.) could also PATCH
-- operational_state/occupancy_count directly via the REST API, bypassing
-- the entire session/order state machine. The app's own UI never does this
-- (app/tables/page.tsx only ever writes table_number/table_code/label/
-- seats/active/seat_tracking_enabled), but RLS is the real boundary, not
-- the UI, and the boundary was left open.
--
-- Fix: replace the blanket UPDATE grant with a column-level grant limited
-- to the columns staff are actually meant to edit by hand. This does not
-- touch RLS or any Build 1-16 policy -- it only narrows which columns the
-- existing policy is allowed to apply to. Server-side state transitions are
-- unaffected because they run inside SECURITY DEFINER functions, which
-- execute with the function owner's privileges and are not subject to the
-- caller's column grants.

begin;

revoke update on public.tables from authenticated;
grant update (table_number, table_code, active, seats, label, seat_tracking_enabled) on public.tables to authenticated;

commit;

select pg_notify('pgrst','reload schema');
