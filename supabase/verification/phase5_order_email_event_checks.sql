-- TABLELY PHASE 5 — EVENT/DISPATCH INSPECTION
--
-- Read-only diagnostic queries. Do not expose decrypted Vault values.

-- 1) Latest notification events.
select
  e.id,
  e.order_id,
  e.event_type,
  e.status,
  e.attempts,
  e.dispatch_requested_at,
  e.pg_net_request_id,
  e.last_attempt_at,
  e.sent_at,
  e.error_message,
  e.created_at
from public.order_email_notification_events e
order by e.created_at desc
limit 100;

-- 2) Duplicate protection check.
select
  order_id,
  event_type,
  count(*) as row_count
from public.order_email_notification_events
group by order_id, event_type
having count(*) > 1
order by row_count desc;

-- Expected result: zero rows.

-- 3) Active Phase 4 cron job.
select
  jobid,
  jobname,
  schedule,
  active,
  command
from cron.job
where jobname = 'tablely-order-email-dispatch';

-- 4) Recent pg_net HTTP responses.
-- Do not paste request/response payloads into public issue trackers or chat.
select
  id,
  status_code,
  timed_out,
  error_msg,
  created,
  updated
from net._http_response
order by created desc
limit 100;
