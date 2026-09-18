-- Build 11 follow-up: snapshot defaults and server-side feature gates.

create or replace function public.snapshot_subscription_catalog_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_plan public.saas_plans;
begin
  select * into v_plan from public.saas_plans where id = new.plan_id;
  if v_plan.id is not null then
    new.price_monthly_snapshot := coalesce(new.price_monthly_snapshot, v_plan.price_monthly);
    new.currency := coalesce(nullif(new.currency, ''), v_plan.currency, 'INR');
    new.billing_interval := coalesce(nullif(new.billing_interval, ''), v_plan.billing_interval, 'month');
  end if;
  return new;
end;
$$;

drop trigger if exists organization_subscriptions_snapshot_fields on public.organization_subscriptions;
create trigger organization_subscriptions_snapshot_fields
before insert or update of plan_id on public.organization_subscriptions
for each row execute function public.snapshot_subscription_catalog_fields();

create or replace function public.get_current_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_org uuid; v_result jsonb;
begin
  select s.organization_id into v_org
  from public.staff s
  where s.user_id = auth.uid() and s.active
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;
  if v_org is null then return null; end if;
  select jsonb_build_object(
    'id', os.id, 'organization_id', os.organization_id, 'plan_id', os.plan_id,
    'status', case when os.status = 'TRIAL' and os.trial_ends_at <= now() then 'EXPIRED' else os.status end,
    'price_monthly_snapshot', os.price_monthly_snapshot, 'currency', os.currency,
    'billing_interval', os.billing_interval, 'trial_started_at', os.trial_started_at,
    'trial_ends_at', os.trial_ends_at, 'current_period_start', os.current_period_start,
    'current_period_end', os.current_period_end, 'provider', os.provider,
    'provider_customer_id', os.provider_customer_id, 'provider_subscription_id', os.provider_subscription_id,
    'pending_plan_id', os.pending_plan_id, 'pending_provider_plan_id', os.pending_provider_plan_id,
    'cancellation_requested_at', os.cancellation_requested_at
  ) into v_result
  from public.organization_subscriptions os
  where os.organization_id = v_org;
  return v_result;
end;
$$;
grant execute on function public.get_current_subscription() to authenticated;

create or replace function public.get_billing_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_org uuid; v_result jsonb;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active order by s.created_at limit 1;
  if v_org is null then return null; end if;
  select jsonb_build_object(
    'plan_id', os.plan_id, 'plan_name', sp.name, 'price_monthly', os.price_monthly_snapshot,
    'currency', os.currency, 'status', case when os.status = 'TRIAL' and os.trial_ends_at <= now() then 'EXPIRED' else os.status end,
    'trial_ends_at', os.trial_ends_at, 'current_period_end', os.current_period_end,
    'provider_subscription_id', os.provider_subscription_id, 'pending_plan_id', os.pending_plan_id,
    'cancellation_requested_at', os.cancellation_requested_at
  ) into v_result
  from public.organization_subscriptions os join public.saas_plans sp on sp.id = os.plan_id
  where os.organization_id = v_org;
  return v_result;
end;
$$;
grant execute on function public.get_billing_context() to authenticated;

create or replace function public.create_service_request_for_table(p_table_code text, p_type text, p_note text default null)
returns table(id uuid, branch_id uuid, table_id uuid, type text, status text, note text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare v_table public.tables%rowtype; v_type text := upper(trim(coalesce(p_type, ''))); v_org uuid;
begin
  if not public.allow_rate_limit('service:' || trim(coalesce(p_table_code, '')), 60, 10) then raise exception 'Too many service requests. Please wait a moment.'; end if;
  select t into v_table
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

create or replace function public.get_branch_analytics(p_branch_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare v_result jsonb;
begin
  if not public.is_branch_member(p_branch_id) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not public.organization_has_feature((select b.organization_id from public.branches b where b.id = p_branch_id), 'ANALYTICS') then raise exception 'Analytics are not available on the current Tablely plan' using errcode = '42501'; end if;
  select jsonb_build_object(
    'revenue', coalesce(sum(case when o.payment_status = 'PAID' then o.total else 0 end), 0),
    'orders', count(*), 'completed_orders', count(*) filter (where o.status = 'COMPLETED'),
    'average_order_value', coalesce(avg(o.total), 0), 'paid_orders', count(*) filter (where o.payment_status = 'PAID'),
    'cancelled_orders', count(*) filter (where o.status = 'CANCELLED'),
    'online_revenue', coalesce(sum(case when o.payment_status = 'PAID' and o.payment_method = 'PAY_NOW' then o.total else 0 end), 0),
    'counter_revenue', coalesce(sum(case when o.payment_status = 'PAID' and coalesce(o.payment_method, '') not like 'PAY_NOW:%' then o.total else 0 end), 0)
  ) into v_result from public.orders o where o.branch_id = p_branch_id and o.created_at >= p_from and o.created_at < p_to;
  return v_result;
end;
$$;
grant execute on function public.get_branch_analytics(uuid, timestamptz, timestamptz) to authenticated;
