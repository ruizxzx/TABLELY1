-- TABLELY PHASE 5 — READ-ONLY PRODUCTION READINESS CHECK
--
-- Safe to run in Supabase SQL Editor.
-- This script deliberately returns booleans/status metadata only and NEVER
-- returns Vault secret values.

select *
from (
  select
    'vault_project_url' as check_name,
    case when exists (
      select 1
      from vault.decrypted_secrets
      where name = 'tablely_order_email_project_url'
        and length(btrim(decrypted_secret)) > 0
    ) then 'PASS' else 'FAIL' end as status,
    'Vault contains a non-empty project URL secret.' as detail

  union all

  select
    'vault_service_role_key',
    case when exists (
      select 1
      from vault.decrypted_secrets
      where name = 'tablely_order_email_service_role_key'
        and length(btrim(decrypted_secret)) > 0
    ) then 'PASS' else 'FAIL' end,
    'Vault contains a non-empty server dispatch credential.'

  union all

  select
    'pg_net_installed',
    case when exists (select 1 from pg_extension where extname = 'pg_net')
      then 'PASS' else 'FAIL' end,
    'pg_net is required for asynchronous HTTP dispatch.'

  union all

  select
    'pg_cron_installed',
    case when exists (select 1 from pg_extension where extname = 'pg_cron')
      then 'PASS' else 'FAIL' end,
    'pg_cron is required for retries/recovery.'

  union all

  select
    'cron_job_active',
    case when exists (
      select 1
      from cron.job
      where jobname = 'tablely-order-email-dispatch'
        and active = true
    ) then 'PASS' else 'FAIL' end,
    'Phase 4 retry/dispatch scheduler must be active.'

  union all

  select
    'status_event_trigger',
    case when exists (
      select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'orders'
        and t.tgname = 'orders_customer_email_status_event'
        and not t.tgisinternal
    ) then 'PASS' else 'FAIL' end,
    'Supported order status changes must enqueue email events.'

  union all

  select
    'subscription_seed_trigger',
    case when exists (
      select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'order_email_notification_subscriptions'
        and t.tgname = 'order_email_subscription_event_seed'
        and not t.tgisinternal
    ) then 'PASS' else 'FAIL' end,
    'Opt-in must seed an event for the order current status.'

  union all

  select
    'event_unique_protection',
    case when exists (
      select 1
      from pg_constraint c
      join pg_class r on r.oid = c.conrelid
      join pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'public'
        and r.relname = 'order_email_notification_events'
        and c.contype = 'u'
        and pg_get_constraintdef(c.oid) like '%(order_id, event_type)%'
    ) then 'PASS' else 'FAIL' end,
    'Duplicate logical events must be prevented by the database constraint.'

  union all

  select
    'event_table_rls',
    case when exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'order_email_notification_events'
        and c.relrowsecurity = true
    ) then 'PASS' else 'FAIL' end,
    'Event table RLS must remain enabled.'

  union all

  select
    'subscription_table_rls',
    case when exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'order_email_notification_subscriptions'
        and c.relrowsecurity = true
    ) then 'PASS' else 'FAIL' end,
    'Subscription table RLS must remain enabled.'
) checks
order by check_name;
