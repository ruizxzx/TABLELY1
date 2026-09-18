-- TABLELY BUILD 13.4 — owner notification preferences table grant fix
--
-- The table's RLS policies correctly restrict authenticated owners, but the
-- original 13.4 migration revoked table privileges from anon/public and did
-- not grant SELECT to authenticated. PostgreSQL therefore rejects the
-- owner's direct preference read before RLS can be evaluated.
--
-- This additive migration restores only the privilege required by the
-- existing frontend reads. Mutations continue through the security-definer
-- set_owner_notification_preference() RPC.

begin;

grant select on table public.owner_notification_preferences to authenticated;

notify pgrst, 'reload schema';

commit;
