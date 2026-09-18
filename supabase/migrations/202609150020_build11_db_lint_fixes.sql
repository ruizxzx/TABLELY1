-- Fix live-lint defects in Build 11 RPC bodies.
create or replace function public.create_service_request_for_table(p_table_code text, p_type text, p_note text default null)
returns table(id uuid, branch_id uuid, table_id uuid, type text, status text, note text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare v_table public.tables%rowtype; v_type text := upper(trim(coalesce(p_type, ''))); v_org uuid;
begin
  if not public.allow_rate_limit('service:' || trim(coalesce(p_table_code, '')), 60, 10) then raise exception 'Too many service requests. Please wait a moment.'; end if;
  select t.* into v_table
  from public.tables t join public.branches b on b.id = t.branch_id join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code) and t.active and o.status = 'ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  select b.organization_id into v_org from public.branches b where b.id = v_table.branch_id;
  if not public.organization_has_feature(v_org, 'SERVICE_REQUESTS') then raise exception 'Service requests are not available on the current Tablely plan'; end if;
  if v_type not in ('WAITER', 'WATER', 'BILL', 'ASSISTANCE') then raise exception 'Unsupported service request'; end if;
  if exists (select 1 from public.service_requests r where r.table_id = v_table.id and r.type = v_type and r.status in ('OPEN', 'ACKNOWLEDGED')) then raise exception 'This request is already open'; end if;
  return query insert into public.service_requests(branch_id, table_id, type, status, note)
  values(v_table.branch_id, v_table.id, v_type, 'OPEN', nullif(left(trim(coalesce(p_note, '')), 300), ''))
  returning service_requests.id, service_requests.branch_id, service_requests.table_id, service_requests.type, service_requests.status, service_requests.note, service_requests.created_at;
end;
$$;
grant execute on function public.create_service_request_for_table(text, text, text) to anon, authenticated;

create or replace function public.apply_provider_subscription_event(p_provider_subscription_id text, p_event_type text, p_status text, p_provider_plan_id text, p_payment_id text, p_payload jsonb)
returns public.organization_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare v_sub public.organization_subscriptions; v_plan public.saas_plans; v_status text := lower(coalesce(p_status, ''));
begin
  select * into v_sub from public.organization_subscriptions where provider_subscription_id = p_provider_subscription_id for update;
  if v_sub.id is null then raise exception 'Subscription not found'; end if;
  if v_status in ('active', 'authenticated') then v_status := 'ACTIVE';
  elsif v_status in ('pending', 'created') then v_status := v_sub.status;
  elsif v_status in ('cancelled', 'completed') then v_status := 'CANCELLED';
  elsif v_status = 'expired' then v_status := 'EXPIRED';
  elsif v_status in ('past_due', 'paused') then v_status := 'PAST_DUE';
  else v_status := v_sub.status; end if;
  if p_provider_plan_id is not null then select * into v_plan from public.saas_plans where provider_plan_id = p_provider_plan_id; end if;
  update public.organization_subscriptions
  set status = v_status,
      plan_id = coalesce(v_plan.id, plan_id),
      pending_plan_id = case when v_plan.id is not null and pending_plan_id = v_plan.id then null else pending_plan_id end,
      pending_provider_plan_id = case when v_plan.id is not null and pending_plan_id = v_plan.id then null else pending_provider_plan_id end,
      updated_at = now()
  where id = v_sub.id
  returning * into v_sub;
  update public.subscription_billing_events
  set organization_id = v_sub.organization_id,
      subscription_id = v_sub.id,
      provider_payment_id = coalesce(p_payment_id, provider_payment_id),
      status = v_status,
      payload = coalesce(p_payload, payload),
      occurred_at = now()
  where provider_subscription_id = p_provider_subscription_id and event_type = p_event_type and organization_id is null;
  return v_sub;
end;
$$;
grant execute on function public.apply_provider_subscription_event(text, text, text, text, text, jsonb) to service_role, authenticated;
