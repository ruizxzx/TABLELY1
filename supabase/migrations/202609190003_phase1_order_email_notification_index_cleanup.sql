-- TABLELY PHASE 1 — remove the redundant subscription order_id index.
-- The UNIQUE(order_id) constraint already provides the required index.

begin;

drop index if exists public.order_email_notification_subscriptions_order_idx;

commit;

notify pgrst, 'reload schema';
