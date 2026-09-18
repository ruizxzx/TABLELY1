-- TABLELY Phases 5–8 order-email QA checks.
-- Read-only: this file does not modify production data.

-- 1. Queue configuration
select jobid, jobname, schedule, active
from cron.job
where jobname = 'tablely-order-email-dispatch';

-- 2. Supported event types in the live event model.
select event_type, count(*)
from public.order_email_notification_events
group by event_type
order by event_type;

-- 3. Duplicate logical notifications: expected result is zero rows.
select order_id, event_type, count(*) as duplicate_count
from public.order_email_notification_events
group by order_id, event_type
having count(*) > 1
order by duplicate_count desc;

-- 4. Non-final delivery states / errors.
select id, order_id, event_type, status, attempts,
       dispatch_requested_at, last_attempt_at, sent_at, error_message
from public.order_email_notification_events
where status <> 'SENT'
order by created_at desc
limit 100;

-- 5. Most recent pg_net responses for diagnostic review.
select id, status_code, error_msg, created
from net._http_response
order by created desc
limit 100;
