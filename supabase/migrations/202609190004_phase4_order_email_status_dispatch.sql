-- TABLELY PHASE 4 — ORDER STATUS EMAIL EVENTS + AUTOMATIC DISPATCH
--
-- Continues Phase 1 + Phase 2 + Phase 3.
--
-- Phase 4 responsibilities:
--   1. Convert supported TABLELY order status changes into email events.
--   2. Create an initial/current-status email event when a customer opts in.
--   3. Dispatch newly-created events asynchronously to the Phase 3
--      send-order-email Edge Function through pg_net.
--   4. Retry queued/failed delivery work through pg_cron.
--   5. Recover stale SENDING events safely; Phase 3 uses a stable Resend
--      idempotency key based on event_id, so a retried event cannot create a
--      second logical email at Resend.
--
-- IMPORTANT:
--   - No changes are made to existing order lifecycle rules.
--   - Existing order notification triggers are left intact.
--   - Email delivery is asynchronous and must never make an order mutation
--     fail because the external mail service is unavailable.
--   - Customer email tables remain non-public; no anon/authenticated grants
--     are added.

begin;

-- ---------------------------------------------------------------------------
-- 1) Required asynchronous/scheduling extensions
-- ---------------------------------------------------------------------------

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- 2) Private helper schema
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Phase 4 delivery bookkeeping
-- ---------------------------------------------------------------------------

alter table public.order_email_notification_events
  add column if not exists dispatch_requested_at timestamptz null,
  add column if not exists pg_net_request_id bigint null;

create index if not exists order_email_notification_events_dispatch_idx
  on public.order_email_notification_events(status, dispatch_requested_at, created_at)
  where status in ('QUEUED', 'FAILED');

-- ---------------------------------------------------------------------------
-- 4) Status -> customer email event mapping
-- ---------------------------------------------------------------------------

create or replace function private.order_email_event_type_for_status(
  p_status text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case upper(trim(coalesce(p_status, '')))
    when 'NEW' then 'ORDER_RECEIVED'
    when 'ACCEPTED' then 'ORDER_ACCEPTED'
    when 'PREPARING' then 'ORDER_PREPARING'
    when 'READY' then 'ORDER_READY'
    when 'COMPLETED' then 'ORDER_COMPLETED'
    when 'CANCELLED' then 'ORDER_CANCELLED'
    when 'REJECTED' then 'ORDER_REJECTED'
    else null
  end;
$$;

revoke all on function private.order_email_event_type_for_status(text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5) Read the server-only dispatch credentials from Supabase Vault.
--
-- Store these secrets once during deployment:
--   tablely_order_email_project_url
--   tablely_order_email_service_role_key
--
-- The service-role key is intentionally NOT stored in source control or the
-- customer browser. Vault keeps secret values encrypted at rest.
-- ---------------------------------------------------------------------------

create or replace function private.order_email_dispatch_credentials()
returns table(
  project_url text,
  service_role_key text
)
language sql
security definer
set search_path = pg_catalog
as $$
  select
    (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'tablely_order_email_project_url'
      limit 1
    ) as project_url,
    (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'tablely_order_email_service_role_key'
      limit 1
    ) as service_role_key;
$$;

revoke all on function private.order_email_dispatch_credentials()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) Asynchronously invoke the Phase 3 Edge Function for one event.
--
-- This function deliberately swallows configuration/network errors so an
-- order INSERT/UPDATE is never rolled back merely because email infrastructure
-- is unavailable. The event remains QUEUED and the cron retry worker can pick
-- it up later.
-- ---------------------------------------------------------------------------

create or replace function private.dispatch_order_email_event(
  p_event_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_project_url text;
  v_service_role_key text;
  v_status text;
  v_dispatch_requested_at timestamptz;
  v_request_id bigint;
begin
  select e.status, e.dispatch_requested_at
    into v_status, v_dispatch_requested_at
  from public.order_email_notification_events e
  where e.id = p_event_id;

  if v_status is null then
    return null;
  end if;

  if v_status = 'SENT' then
    return null;
  end if;

  if v_status = 'SENDING' then
    return null;
  end if;

  -- Do not create another HTTP request while an earlier pg_net request is
  -- still considered fresh. The retry worker will revisit it after 2 minutes.
  if v_status = 'QUEUED'
     and v_dispatch_requested_at is not null
     and v_dispatch_requested_at > clock_timestamp() - interval '2 minutes' then
    return null;
  end if;

  -- FAILED rows use the Phase 3 attempt timestamp for their backoff.
  if v_status = 'FAILED'
     and exists (
       select 1
       from public.order_email_notification_events e
       where e.id = p_event_id
         and e.last_attempt_at is not null
         and e.last_attempt_at > clock_timestamp() - interval '1 minute'
     ) then
    return null;
  end if;

  select c.project_url, c.service_role_key
    into v_project_url, v_service_role_key
  from private.order_email_dispatch_credentials() c;

  if nullif(btrim(coalesce(v_project_url, '')), '') is null
     or nullif(btrim(coalesce(v_service_role_key, '')), '') is null then
    raise warning 'TABLELY order-email dispatcher is not configured; event % remains queued', p_event_id;
    return null;
  end if;

  v_project_url := regexp_replace(btrim(v_project_url), '/+$', '');

  select net.http_post(
    url := v_project_url || '/functions/v1/send-order-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_role_key,
      'apikey', v_service_role_key
    ),
    body := jsonb_build_object('event_id', p_event_id),
    timeout_milliseconds := 10000
  )
  into v_request_id;

  update public.order_email_notification_events
  set dispatch_requested_at = clock_timestamp(),
      pg_net_request_id = v_request_id
  where id = p_event_id
    and status in ('QUEUED', 'FAILED');

  return v_request_id;
exception
  when others then
    raise warning 'TABLELY order-email dispatch request failed for event %: %', p_event_id, sqlerrm;
    return null;
end;
$$;

revoke all on function private.dispatch_order_email_event(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) Central event enqueue helper
-- ---------------------------------------------------------------------------

create or replace function private.enqueue_order_email_event(
  p_order_id uuid,
  p_event_type text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_id uuid;
  v_email text;
  v_enabled boolean;
begin
  if p_order_id is null then
    return null;
  end if;

  if p_event_type not in (
    'ORDER_RECEIVED',
    'ORDER_ACCEPTED',
    'ORDER_PREPARING',
    'ORDER_READY',
    'ORDER_COMPLETED',
    'ORDER_CANCELLED',
    'ORDER_REJECTED'
  ) then
    return null;
  end if;

  select s.email, s.enabled
    into v_email, v_enabled
  from public.order_email_notification_subscriptions s
  where s.order_id = p_order_id
  order by s.created_at desc
  limit 1;

  if not found or coalesce(v_enabled, false) = false then
    return null;
  end if;

  insert into public.order_email_notification_events(
    order_id,
    subscription_id,
    event_type,
    status,
    recipient_email
  )
  values(
    p_order_id,
    (
      select s.id
      from public.order_email_notification_subscriptions s
      where s.order_id = p_order_id
      order by s.created_at desc
      limit 1
    ),
    p_event_type,
    'QUEUED',
    lower(btrim(v_email))
  )
  on conflict (order_id, event_type) do nothing
  returning id into v_event_id;

  if v_event_id is not null then
    perform private.dispatch_order_email_event(v_event_id);
  end if;

  return v_event_id;
exception
  when others then
    -- Queue creation is an auxiliary notification concern. Never make a
    -- customer order/status transaction fail because the notification system
    -- is unavailable or partially configured.
    raise warning 'TABLELY order-email event enqueue failed for order % / event %: %',
      p_order_id, p_event_type, sqlerrm;
    return null;
end;
$$;

revoke all on function private.enqueue_order_email_event(uuid, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8) Create a notification for the order's CURRENT state when a customer opts
-- in. This closes the race where a restaurant accepts/rejects an order before
-- the Phase 2 post-order subscription write reaches the database.
-- ---------------------------------------------------------------------------

create or replace function private.enqueue_order_email_current_status(
  p_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_status text;
  v_event_type text;
begin
  select o.status::text
    into v_status
  from public.orders o
  where o.id = p_order_id;

  if v_status is null then
    return null;
  end if;

  v_event_type := private.order_email_event_type_for_status(v_status);
  if v_event_type is null then
    return null;
  end if;

  return private.enqueue_order_email_event(p_order_id, v_event_type);
exception
  when others then
    raise warning 'TABLELY current-status email enqueue failed for order %: %', p_order_id, sqlerrm;
    return null;
end;
$$;

revoke all on function private.enqueue_order_email_current_status(uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9) Trigger: customer opts into email updates.
-- ---------------------------------------------------------------------------

create or replace function private.on_order_email_subscription_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.enqueue_order_email_current_status(new.order_id);
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.enabled is distinct from new.enabled
     and new.enabled = true then
    perform private.enqueue_order_email_current_status(new.order_id);
  end if;

  return new;
exception
  when others then
    raise warning 'TABLELY order-email subscription trigger failed for order %: %',
      coalesce(new.order_id, old.order_id), sqlerrm;
    return new;
end;
$$;

drop trigger if exists order_email_subscription_event_seed
  on public.order_email_notification_subscriptions;

create trigger order_email_subscription_event_seed
after insert or update of enabled
on public.order_email_notification_subscriptions
for each row
execute function private.on_order_email_subscription_change();

revoke all on function private.on_order_email_subscription_change()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10) Trigger: supported order status changes create customer email events.
--
-- SERVED intentionally has no customer email event in the Phase 1 event model;
-- the next customer-facing milestone remains COMPLETED.
-- ---------------------------------------------------------------------------

create or replace function private.on_order_status_email_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_type text;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if new.status::text is not distinct from old.status::text then
    return new;
  end if;

  v_event_type := private.order_email_event_type_for_status(new.status::text);
  if v_event_type is null then
    return new;
  end if;

  perform private.enqueue_order_email_event(new.id, v_event_type);
  return new;
exception
  when others then
    raise warning 'TABLELY order-email status trigger failed for order %: %', new.id, sqlerrm;
    return new;
end;
$$;

drop trigger if exists orders_customer_email_status_event
  on public.orders;

create trigger orders_customer_email_status_event
after update of status
on public.orders
for each row
execute function private.on_order_status_email_change();

revoke all on function private.on_order_status_email_change()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11) Retry worker.
--
-- - queued requests are retried when their last pg_net dispatch is older than
--   2 minutes;
-- - failed sends are retried after 1 minute;
-- - stale SENDING rows are made FAILED after 10 minutes;
-- - a single cron job is used to avoid duplicate schedulers.
-- ---------------------------------------------------------------------------

create or replace function private.process_order_email_queue()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event record;
begin
  update public.order_email_notification_events
  set status = 'FAILED',
      error_message = left(
        concat_ws(' ', nullif(error_message, ''), 'Recovered stale SENDING state by Phase 4 queue worker.'),
        1000
      )
  where status = 'SENDING'
    and last_attempt_at is not null
    and last_attempt_at < clock_timestamp() - interval '10 minutes';

  for v_event in
    select e.id
    from public.order_email_notification_events e
    join public.order_email_notification_subscriptions s
      on s.id = e.subscription_id
     and s.order_id = e.order_id
    where s.enabled = true
      and (
        (
          e.status = 'QUEUED'
          and (
            e.dispatch_requested_at is null
            or e.dispatch_requested_at < clock_timestamp() - interval '2 minutes'
          )
        )
        or
        (
          e.status = 'FAILED'
          and (
            e.last_attempt_at is null
            or e.last_attempt_at < clock_timestamp() - interval '1 minute'
          )
        )
      )
    order by e.created_at
    limit 25
  loop
    perform private.dispatch_order_email_event(v_event.id);
  end loop;
exception
  when others then
    raise warning 'TABLELY order-email queue worker failed: %', sqlerrm;
end;
$$;

revoke all on function private.process_order_email_queue()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 12) Schedule the retry worker every 30 seconds.
-- ---------------------------------------------------------------------------

do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'tablely-order-email-dispatch'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'tablely-order-email-dispatch',
    '30 seconds',
    $cron$select private.process_order_email_queue();$cron$
  );
end;
$$;

commit;

notify pgrst, 'reload schema';
