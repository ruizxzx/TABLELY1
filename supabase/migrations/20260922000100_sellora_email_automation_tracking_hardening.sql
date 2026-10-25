-- Harden email automation triggers and subscriber-limit concurrency.
-- This remains additive and keeps the existing daily dispatcher as the only scheduled runner.

alter table public.email_automations
  add column if not exists segment_id uuid references public.email_segments(id) on delete set null,
  add column if not exists delay_seconds integer not null default 0,
  add column if not exists last_triggered_at timestamptz,
  add column if not exists next_run_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.email_automations
  drop constraint if exists email_automations_trigger_type_check;

alter table public.email_automations
  alter column trigger_type type text;

alter table public.email_automations
  add constraint email_automations_trigger_type_check
  check (trigger_type in ('new_subscriber','customer_purchase','day_after_signup','segment_match'));

create or replace function public.create_email_subscriber_if_under_limit(
  p_store_id uuid,
  p_email text,
  p_source text,
  p_limit bigint
)
returns table (
  subscriber_id uuid,
  created boolean,
  limit_reached boolean
)
language plpgsql
security definer
as $$
declare
  v_email text := lower(trim(p_email));
  v_existing_id uuid;
  v_count bigint;
begin
  if p_store_id is null or v_email = '' then
    return query select null::uuid, false, true;
    return;
  end if;

  perform 1 from public.stores where id = p_store_id for update;

  select id into v_existing_id
  from public.email_subscribers
  where store_id = p_store_id and email = v_email
  limit 1;

  if v_existing_id is not null then
    update public.email_subscribers
    set source = coalesce(nullif(trim(p_source), ''), source),
        status = 'active',
        unsubscribed_at = null,
        last_seen_at = now()
    where id = v_existing_id;

    return query select v_existing_id, false, false;
    return;
  end if;

  select count(*) into v_count
  from public.email_subscribers
  where store_id = p_store_id;

  if p_limit is not null and p_limit >= 0 and v_count >= p_limit then
    return query select null::uuid, false, true;
    return;
  end if;

  insert into public.email_subscribers (store_id, email, source, status, last_seen_at, unsubscribed_at)
  values (p_store_id, v_email, coalesce(nullif(trim(p_source), ''), 'storefront'), 'active', now(), null)
  returning id into v_existing_id;

  return query select v_existing_id, true, false;
end;
$$;

grant execute on function public.create_email_subscriber_if_under_limit(uuid, text, text, bigint) to service_role;
