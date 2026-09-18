-- TABLELY PHASE 1 — ORDER EMAIL NOTIFICATION FOUNDATION
--
-- Database foundation only. No frontend, Resend integration, email sending,
-- status triggers, or customer-facing event creation is included here.

begin;

create table public.order_email_notification_subscriptions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
    references public.orders(id) on delete cascade,
  email text not null,
  enabled boolean not null default true,
  consented_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_email_notification_subscriptions_email_check
    check (char_length(btrim(email)) between 3 and 320),
  constraint order_email_notification_subscriptions_order_id_key
    unique (order_id),
  -- Required so events can enforce that subscription_id and order_id belong
  -- to the same subscription/order pair via a composite foreign key.
  constraint order_email_notification_subscriptions_id_order_id_key
    unique (id, order_id)
);

-- The unique(order_id) constraint already provides an order_id index.
-- A second order_id-only index would be redundant.

create table public.order_email_notification_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null
    references public.orders(id) on delete cascade,
  subscription_id uuid not null,
  event_type text not null,
  status text not null default 'QUEUED',
  recipient_email text not null,
  attempts integer not null default 0,
  resend_email_id text null,
  last_attempt_at timestamptz null,
  sent_at timestamptz null,
  error_message text null,
  created_at timestamptz not null default now(),
  constraint order_email_notification_events_subscription_order_fkey
    foreign key (subscription_id, order_id)
    references public.order_email_notification_subscriptions(id, order_id)
    on delete cascade,
  constraint order_email_notification_events_event_type_check
    check (event_type in (
      'ORDER_RECEIVED',
      'ORDER_ACCEPTED',
      'ORDER_PREPARING',
      'ORDER_READY',
      'ORDER_COMPLETED',
      'ORDER_CANCELLED',
      'ORDER_REJECTED'
    )),
  constraint order_email_notification_events_status_check
    check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED')),
  constraint order_email_notification_events_recipient_email_check
    check (char_length(btrim(recipient_email)) between 3 and 320),
  constraint order_email_notification_events_attempts_check
    check (attempts >= 0),
  constraint order_email_notification_events_order_event_key
    unique (order_id, event_type)
);

create index order_email_notification_events_subscription_idx
  on public.order_email_notification_events(subscription_id);

create index order_email_notification_events_queue_idx
  on public.order_email_notification_events(status, created_at)
  where status = 'QUEUED';

create index order_email_notification_events_created_idx
  on public.order_email_notification_events(created_at desc);

alter table public.order_email_notification_subscriptions enable row level security;
alter table public.order_email_notification_events enable row level security;

-- Customer email addresses and delivery records are not directly exposed to
-- browser roles. Future server-side notification workers use service_role.
revoke all on public.order_email_notification_subscriptions from anon, authenticated, public;
revoke all on public.order_email_notification_events from anon, authenticated, public;

grant all on public.order_email_notification_subscriptions to service_role;
grant all on public.order_email_notification_events to service_role;

drop trigger if exists order_email_notification_subscriptions_set_updated_at
  on public.order_email_notification_subscriptions;

create trigger order_email_notification_subscriptions_set_updated_at
before update on public.order_email_notification_subscriptions
for each row
execute function public.set_updated_at();

commit;

notify pgrst, 'reload schema';
