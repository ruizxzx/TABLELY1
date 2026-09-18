-- TABLELY BUILD 13.4 — authorization hardening for the notification helper.
--
-- create_staff_notification(p_branch_id, ...) is SECURITY DEFINER, trusts
-- p_branch_id as given, and performs no check that the calling user
-- (auth.uid()) has any relationship to that branch/organization at all. It
-- is only ever meant to be called from inside the trigger functions
-- (notify_order_status_change, notify_service_request), which themselves
-- run SECURITY DEFINER and therefore need no EXECUTE grant on the callee to
-- invoke it.
--
-- 202609160009 granted EXECUTE to `authenticated` (narrowing an implicit
-- PUBLIC default from the function's original 202609141000 definition,
-- which had no explicit grant/revoke at all). Neither state is safe: with
-- EXECUTE available to any authenticated user, any staff account at any
-- restaurant could call
--   supabase.rpc('create_staff_notification', { p_branch_id: '<any other org's branch>', ... })
-- directly and insert arbitrary notifications for another organization's
-- staff. No frontend or API route calls this RPC directly (only the two
-- trigger functions do, internally), so there is no legitimate reason for
-- `authenticated` to hold this grant.

begin;

revoke execute on function public.create_staff_notification(uuid,public.staff_role[],text,text,text,text,uuid,jsonb,uuid) from authenticated, anon, public;
grant execute on function public.create_staff_notification(uuid,public.staff_role[],text,text,text,text,uuid,jsonb,uuid) to service_role;

notify pgrst, 'reload schema';

commit;
