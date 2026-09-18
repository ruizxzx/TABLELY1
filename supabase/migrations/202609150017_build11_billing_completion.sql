-- TABLELY BUILD 11: authoritative SaaS billing, entitlements, provider state and history.

-- Authoritative catalog fields and current pricing.
alter table public.saas_plans add column if not exists description text;
alter table public.saas_plans add column if not exists currency text not null default 'INR';
alter table public.saas_plans add column if not exists billing_interval text not null default 'month';
alter table public.saas_plans add column if not exists provider_plan_id text;
create unique index if not exists saas_plans_provider_plan_id_uidx on public.saas_plans(provider_plan_id) where provider_plan_id is not null;

update public.saas_plans
set price_monthly = case id when 'STARTER' then 499 when 'GROWTH' then 999 when 'PRO' then 1999 else price_monthly end,
    currency = 'INR',
    billing_interval = 'month',
    description = case id
      when 'STARTER' then 'Digital menu, QR ordering, kitchen dashboard and pay at counter.'
      when 'GROWTH' then 'Starter plus online payments, service requests, analytics and branding.'
      when 'PRO' then 'Growth plus multi-branch and advanced operational entitlements.'
      else description
    end,
    features = case id
      when 'STARTER' then jsonb_build_object(
        'ONLINE_PAYMENTS', false, 'UNLIMITED_STAFF', false, 'SERVICE_REQUESTS', false,
        'ANALYTICS', false, 'PAYMENT_TRACKING', false, 'CUSTOM_BRANDING', false,
        'MULTI_BRANCH', false, 'ADVANCED_ANALYTICS', false, 'CROSS_BRANCH_REPORTING', false,
        'ADVANCED_PERMISSIONS', false, 'CUSTOM_DOMAIN', false, 'max_staff', 2, 'max_branches', 1)
      when 'GROWTH' then jsonb_build_object(
        'ONLINE_PAYMENTS', true, 'UNLIMITED_STAFF', true, 'SERVICE_REQUESTS', true,
        'ANALYTICS', true, 'PAYMENT_TRACKING', true, 'CUSTOM_BRANDING', true,
        'MULTI_BRANCH', false, 'ADVANCED_ANALYTICS', false, 'CROSS_BRANCH_REPORTING', false,
        'ADVANCED_PERMISSIONS', false, 'CUSTOM_DOMAIN', false, 'max_staff', null, 'max_branches', 1)
      when 'PRO' then jsonb_build_object(
        'ONLINE_PAYMENTS', true, 'UNLIMITED_STAFF', true, 'SERVICE_REQUESTS', true,
        'ANALYTICS', true, 'PAYMENT_TRACKING', true, 'CUSTOM_BRANDING', true,
        'MULTI_BRANCH', true, 'ADVANCED_ANALYTICS', true, 'CROSS_BRANCH_REPORTING', true,
        'ADVANCED_PERMISSIONS', true, 'CUSTOM_DOMAIN', true, 'max_staff', null, 'max_branches', null)
      else features
    end
where id in ('STARTER', 'GROWTH', 'PRO');

-- Subscription snapshots and lifecycle state.
alter table public.organization_subscriptions add column if not exists price_monthly_snapshot numeric(12,2);
alter table public.organization_subscriptions add column if not exists currency text not null default 'INR';
alter table public.organization_subscriptions add column if not exists billing_interval text not null default 'month';
alter table public.organization_subscriptions add column if not exists pending_plan_id text references public.saas_plans(id);
alter table public.organization_subscriptions add column if not exists pending_provider_plan_id text;
alter table public.organization_subscriptions add column if not exists cancellation_requested_at timestamptz;
alter table public.organization_subscriptions add column if not exists cancelled_at timestamptz;

update public.organization_subscriptions os
set price_monthly_snapshot = coalesce(os.price_monthly_snapshot, sp.price_monthly),
    currency = coalesce(nullif(os.currency, ''), sp.currency, 'INR'),
    billing_interval = coalesce(nullif(os.billing_interval, ''), sp.billing_interval, 'month')
from public.saas_plans sp
where sp.id = os.plan_id;

-- Provider events are both the webhook idempotency ledger and subscription history source.
create table if not exists public.subscription_billing_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  subscription_id uuid references public.organization_subscriptions(id) on delete set null,
  provider_event_id text unique,
  provider_subscription_id text,
  provider_payment_id text,
  event_type text not null,
  status text,
  amount numeric(12,2),
  currency text not null default 'INR',
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists subscription_billing_events_org_idx on public.subscription_billing_events(organization_id, occurred_at desc);
create index if not exists subscription_billing_events_subscription_idx on public.subscription_billing_events(provider_subscription_id, occurred_at desc);
alter table public.subscription_billing_events enable row level security;
revoke all on public.subscription_billing_events from anon;
drop policy if exists subscription_billing_events_select_member on public.subscription_billing_events;
create policy subscription_billing_events_select_member on public.subscription_billing_events
for select to authenticated using (public.is_org_member(organization_id));
grant select on public.subscription_billing_events to authenticated;

-- One authoritative entitlement check. Trial expiry is evaluated on the server.
create or replace function public.organization_has_feature(p_organization_id uuid, p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_features jsonb;
  v_status text;
  v_trial_end timestamptz;
  v_key text := upper(trim(coalesce(p_feature, '')));
begin
  if not exists (
    select 1 from public.staff s
    where s.organization_id = p_organization_id and s.user_id = auth.uid() and s.active = true
  ) and auth.uid() is not null then
    return false;
  end if;

  select os.status, os.trial_ends_at, sp.features
  into v_status, v_trial_end, v_features
  from public.organization_subscriptions os
  join public.saas_plans sp on sp.id = os.plan_id
  where os.organization_id = p_organization_id;

  if v_status is null then return false; end if;
  if v_status = 'TRIAL' and (v_trial_end is null or v_trial_end <= now()) then return false; end if;
  if v_status not in ('TRIAL', 'ACTIVE') then return false; end if;
  return coalesce((v_features ->> v_key)::boolean, false);
end;
$$;
grant execute on function public.organization_has_feature(uuid, text) to authenticated, service_role;

-- Keep the Starter limit server-side and align it with canonical feature keys.
create or replace function public.organization_can_add_staff(p_organization_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.staff s where s.organization_id = p_organization_id and s.user_id = v_user and s.active = true and s.role = 'OWNER') then
    raise exception 'Only the owner can check the staff limit' using errcode = '42501';
  end if;
  if public.organization_has_feature(p_organization_id, 'UNLIMITED_STAFF') then return true; end if;
  select nullif(sp.features->>'max_staff', '')::integer into v_limit
  from public.organization_subscriptions os join public.saas_plans sp on sp.id = os.plan_id
  where os.organization_id = p_organization_id and (os.status = 'ACTIVE' or (os.status = 'TRIAL' and os.trial_ends_at > now()));
  if v_limit is null then return false; end if;
  select count(*)::integer into v_count from public.staff s where s.organization_id = p_organization_id and s.active = true and s.role <> 'OWNER';
  return v_count < v_limit;
end;
$$;
grant execute on function public.organization_can_add_staff(uuid) to authenticated;

-- Provider plan storage for Super Admin provisioning.
create or replace function public.admin_set_provider_plan_id(p_plan_id text, p_provider_plan_id text)
returns public.saas_plans
language plpgsql
security definer
set search_path = public
as $$
declare v_plan public.saas_plans;
begin
  if auth.uid() is not null and not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_provider_plan_id, '')), '') is null then raise exception 'Provider plan ID is required'; end if;
  update public.saas_plans set provider_plan_id = trim(p_provider_plan_id) where id = p_plan_id returning * into v_plan;
  if v_plan.id is null then raise exception 'Plan not found'; end if;
  return v_plan;
end;
$$;
grant execute on function public.admin_set_provider_plan_id(text, text) to authenticated, service_role;

-- Subscription checkout context. Client plan input is validated against the catalog here.
create or replace function public.begin_subscription_checkout(p_plan_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_sub public.organization_subscriptions;
  v_plan public.saas_plans;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active = true and s.role = 'OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode = '42501'; end if;
  select * into v_plan from public.saas_plans where id = p_plan_id and active = true;
  if v_plan.id is null or v_plan.provider_plan_id is null then raise exception 'Tablely billing plan is not configured'; end if;
  select * into v_sub from public.organization_subscriptions where organization_id = v_org for update;
  if v_sub.id is null then raise exception 'Subscription record not found'; end if;
  if v_sub.trial_ends_at is not null and v_sub.status = 'TRIAL' and v_sub.trial_ends_at <= now() then
    update public.organization_subscriptions set status = 'EXPIRED', updated_at = now() where id = v_sub.id returning * into v_sub;
  end if;
  return jsonb_build_object('organization_id', v_org, 'plan_id', v_plan.id, 'provider_plan_id', v_plan.provider_plan_id, 'provider_subscription_id', v_sub.provider_subscription_id, 'status', v_sub.status);
end;
$$;
grant execute on function public.begin_subscription_checkout(text) to authenticated;

create or replace function public.record_subscription_provider_creation(p_organization_id uuid, p_plan_id text, p_provider_subscription_id text)
returns public.organization_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare v_sub public.organization_subscriptions; v_plan public.saas_plans;
begin
  if auth.uid() is not null and not exists (select 1 from public.staff s where s.organization_id = p_organization_id and s.user_id = auth.uid() and s.role = 'OWNER' and s.active) then raise exception 'Owner access required' using errcode = '42501'; end if;
  select * into v_plan from public.saas_plans where id = p_plan_id and active;
  if v_plan.id is null then raise exception 'Invalid plan'; end if;
  update public.organization_subscriptions
  set provider = 'RAZORPAY', provider_subscription_id = p_provider_subscription_id,
      price_monthly_snapshot = v_plan.price_monthly, currency = v_plan.currency, billing_interval = v_plan.billing_interval,
      updated_at = now()
  where organization_id = p_organization_id returning * into v_sub;
  if v_sub.id is null then raise exception 'Subscription record not found'; end if;
  return v_sub;
end;
$$;
grant execute on function public.record_subscription_provider_creation(uuid, text, text) to authenticated, service_role;

create or replace function public.schedule_subscription_plan_change(p_plan_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid; v_sub public.organization_subscriptions; v_plan public.saas_plans;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active and s.role = 'OWNER' limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode = '42501'; end if;
  select * into v_plan from public.saas_plans where id = p_plan_id and active and provider_plan_id is not null;
  if v_plan.id is null then raise exception 'Invalid or unconfigured plan'; end if;
  select * into v_sub from public.organization_subscriptions where organization_id = v_org for update;
  if v_sub.id is null or v_sub.provider_subscription_id is null then raise exception 'This subscription is not connected to provider billing'; end if;
  if v_sub.plan_id = p_plan_id then raise exception 'This is already the current plan'; end if;
  update public.organization_subscriptions set pending_plan_id = p_plan_id, pending_provider_plan_id = v_plan.provider_plan_id, updated_at = now() where id = v_sub.id returning * into v_sub;
  return jsonb_build_object('provider_subscription_id', v_sub.provider_subscription_id, 'provider_plan_id', v_plan.provider_plan_id, 'pending_plan_id', p_plan_id);
end;
$$;
grant execute on function public.schedule_subscription_plan_change(text) to authenticated;

create or replace function public.clear_pending_subscription_plan_change()
returns public.organization_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid; v_sub public.organization_subscriptions;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active and s.role = 'OWNER' limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode = '42501'; end if;
  update public.organization_subscriptions set pending_plan_id = null, pending_provider_plan_id = null, updated_at = now() where organization_id = v_org returning * into v_sub;
  return v_sub;
end;
$$;
grant execute on function public.clear_pending_subscription_plan_change() to authenticated;

create or replace function public.schedule_subscription_cancellation()
returns public.organization_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid; v_sub public.organization_subscriptions;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active and s.role = 'OWNER' limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode = '42501'; end if;
  update public.organization_subscriptions set cancellation_requested_at = now(), updated_at = now() where organization_id = v_org returning * into v_sub;
  if v_sub.id is null then raise exception 'Subscription record not found'; end if;
  return v_sub;
end;
$$;
grant execute on function public.schedule_subscription_cancellation() to authenticated;

create or replace function public.confirm_subscription_payment(p_provider_subscription_id text, p_provider_payment_id text)
returns public.organization_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid; v_sub public.organization_subscriptions; v_plan public.saas_plans;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active and s.role = 'OWNER' limit 1;
  if v_org is null then raise exception 'Owner access required' using errcode = '42501'; end if;
  select * into v_sub from public.organization_subscriptions where organization_id = v_org and provider_subscription_id = p_provider_subscription_id for update;
  if v_sub.id is null then raise exception 'Subscription not found'; end if;
  select * into v_plan from public.saas_plans where id = v_sub.plan_id;
  update public.organization_subscriptions set status = 'ACTIVE', current_period_start = coalesce(current_period_start, now()), current_period_end = coalesce(current_period_end, now() + interval '1 month'), cancellation_requested_at = null, updated_at = now() where id = v_sub.id returning * into v_sub;
  insert into public.subscription_billing_events(organization_id, subscription_id, provider_subscription_id, provider_payment_id, event_type, status, amount, currency, payload)
  values(v_org, v_sub.id, p_provider_subscription_id, p_provider_payment_id, 'subscription.payment_confirmed', 'PAID', v_plan.price_monthly, coalesce(v_plan.currency, 'INR'), '{}'::jsonb)
  on conflict (provider_event_id) do nothing;
  return v_sub;
end;
$$;
grant execute on function public.confirm_subscription_payment(text, text) to authenticated;

create or replace function public.record_subscription_webhook_event(p_provider_event_id text, p_event_type text, p_provider_subscription_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid; v_duplicate boolean;
begin
  insert into public.subscription_billing_events(provider_event_id, provider_subscription_id, event_type, payload)
  values(p_provider_event_id, p_provider_subscription_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (provider_event_id) do nothing
  returning id into v_id;
  v_duplicate := v_id is null;
  return jsonb_build_object('duplicate', v_duplicate, 'id', v_id);
end;
$$;
grant execute on function public.record_subscription_webhook_event(text, text, text, jsonb) to service_role, authenticated;

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
  elsif v_status in ('expired') then v_status := 'EXPIRED';
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
  update public.subscription_billing_events set organization_id = v_sub.organization_id, subscription_id = v_sub.id, provider_payment_id = coalesce(p_payment_id, provider_payment_id), status = v_status, occurred_at = now() where provider_subscription_id = p_provider_subscription_id and event_type = p_event_type and organization_id is null;
  return v_sub;
end;
$$;
grant execute on function public.apply_provider_subscription_event(text, text, text, text, text, jsonb) to service_role, authenticated;

-- Real subscription history, scoped to the authenticated organization.
create or replace function public.get_subscription_payment_history()
returns table(id uuid, provider_payment_id text, amount numeric, currency text, status text, paid_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
declare v_org uuid;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active order by s.created_at limit 1;
  if v_org is null then raise exception 'Restaurant workspace not found' using errcode = '42501'; end if;
  return query
  select e.id, e.provider_payment_id, coalesce(e.amount, 0), e.currency, coalesce(e.status, e.event_type), e.occurred_at, e.created_at
  from public.subscription_billing_events e
  where e.organization_id = v_org
  order by e.occurred_at desc;
end;
$$;
grant execute on function public.get_subscription_payment_history() to authenticated;

-- Current subscription/billing views use the historical snapshot, not today's catalog price.
create or replace function public.get_current_subscription()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_org uuid; v_result jsonb;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active order by case when s.role='OWNER' then 0 when s.role='MANAGER' then 1 else 2 end, s.created_at limit 1;
  if v_org is null then return null; end if;
  update public.organization_subscriptions set status = 'EXPIRED', updated_at = now() where organization_id = v_org and status = 'TRIAL' and trial_ends_at is not null and trial_ends_at <= now();
  select jsonb_build_object('id',os.id,'organization_id',os.organization_id,'plan_id',os.plan_id,'status',os.status,'price_monthly_snapshot',os.price_monthly_snapshot,'currency',os.currency,'billing_interval',os.billing_interval,'trial_started_at',os.trial_started_at,'trial_ends_at',os.trial_ends_at,'current_period_start',os.current_period_start,'current_period_end',os.current_period_end,'provider',os.provider,'provider_customer_id',os.provider_customer_id,'provider_subscription_id',os.provider_subscription_id,'pending_plan_id',os.pending_plan_id,'pending_provider_plan_id',os.pending_provider_plan_id,'cancellation_requested_at',os.cancellation_requested_at) into v_result from public.organization_subscriptions os where os.organization_id = v_org;
  return v_result;
end; $$;
grant execute on function public.get_current_subscription() to authenticated;

create or replace function public.get_billing_context()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_org uuid; v_result jsonb;
begin
  select s.organization_id into v_org from public.staff s where s.user_id = auth.uid() and s.active order by s.created_at limit 1;
  if v_org is null then return null; end if;
  update public.organization_subscriptions set status = 'EXPIRED', updated_at = now() where organization_id = v_org and status = 'TRIAL' and trial_ends_at is not null and trial_ends_at <= now();
  select jsonb_build_object('plan_id',os.plan_id,'plan_name',sp.name,'price_monthly',os.price_monthly_snapshot,'currency',os.currency,'status',os.status,'trial_ends_at',os.trial_ends_at,'current_period_end',os.current_period_end,'provider_subscription_id',os.provider_subscription_id,'pending_plan_id',os.pending_plan_id,'cancellation_requested_at',os.cancellation_requested_at) into v_result from public.organization_subscriptions os join public.saas_plans sp on sp.id = os.plan_id where os.organization_id = v_org;
  return v_result;
end; $$;
grant execute on function public.get_billing_context() to authenticated;

-- Catalog RPCs expose the authoritative catalog and provider IDs.
drop function if exists public.get_active_plan_catalog();
create or replace function public.get_active_plan_catalog()
returns table(id text,name text,description text,price_monthly numeric,currency text,billing_interval text,trial_days integer,active boolean,features jsonb,max_staff integer,max_branches integer,provider_plan_id text)
language sql stable security definer set search_path = public as $$
  select p.id,p.name,p.description,p.price_monthly,p.currency,p.billing_interval,p.trial_days,p.active,p.features,nullif(p.features->>'max_staff','')::integer,nullif(p.features->>'max_branches','')::integer,p.provider_plan_id from public.saas_plans p where p.active order by p.price_monthly;
$$;
grant execute on function public.get_active_plan_catalog() to authenticated;

drop function if exists public.admin_list_plans();
create or replace function public.admin_list_plans()
returns table(id text,name text,description text,price_monthly numeric,currency text,billing_interval text,trial_days integer,active boolean,features jsonb,max_staff integer,max_branches integer,provider_plan_id text)
language sql stable security definer set search_path = public as $$
  select p.id,p.name,p.description,p.price_monthly,p.currency,p.billing_interval,p.trial_days,p.active,p.features,nullif(p.features->>'max_staff','')::integer,nullif(p.features->>'max_branches','')::integer,p.provider_plan_id from public.saas_plans p where public.is_platform_admin() order by p.price_monthly;
$$;
grant execute on function public.admin_list_plans() to authenticated;

-- Authoritative MRR uses effective subscription snapshots.
create or replace function public.admin_overview()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  select jsonb_build_object('restaurants',(select count(*) from public.organizations),'active_restaurants',(select count(*) from public.organizations where status='ACTIVE'),'trial_restaurants',(select count(*) from public.organization_subscriptions where status='TRIAL' and trial_ends_at > now()),'active_subscriptions',(select count(*) from public.organization_subscriptions where status='ACTIVE'),'orders_today',(select count(*) from public.orders where created_at>=date_trunc('day',now())),'payments_today',(select coalesce(sum(total),0) from public.orders where payment_status='PAID' and created_at>=date_trunc('day',now())),'mrr',(select coalesce(sum(price_monthly_snapshot),0) from public.organization_subscriptions where status='ACTIVE')) into v;
  return v;
end;
$$;
grant execute on function public.admin_overview() to authenticated;

-- Fix admin plan editing to one canonical signature and persist description/limits/provider-safe features.
drop function if exists public.admin_update_plan(boolean, text, jsonb, text, numeric, integer);
drop function if exists public.admin_update_plan(text, numeric, integer, boolean, jsonb, integer, integer, text);
create or replace function public.admin_update_plan(p_plan_id text,p_price_monthly numeric,p_trial_days integer,p_active boolean,p_features jsonb,p_max_staff integer,p_max_branches integer,p_description text default null)
returns public.saas_plans language plpgsql security definer set search_path = public as $$
declare v_plan public.saas_plans; v_features jsonb := coalesce(p_features,'{}'::jsonb);
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  if p_price_monthly is null or p_price_monthly < 0 then raise exception 'Monthly price must be zero or greater'; end if;
  if p_trial_days is null or p_trial_days < 0 or p_trial_days > 90 then raise exception 'Trial days must be between 0 and 90'; end if;
  if p_max_staff is not null and p_max_staff < 0 then raise exception 'Maximum staff cannot be negative'; end if;
  if p_max_branches is not null and p_max_branches < 0 then raise exception 'Maximum branches cannot be negative'; end if;
  v_features := jsonb_set(v_features,'{max_staff}',to_jsonb(p_max_staff),true);
  v_features := jsonb_set(v_features,'{max_branches}',to_jsonb(p_max_branches),true);
  update public.saas_plans set price_monthly=p_price_monthly,trial_days=p_trial_days,active=coalesce(p_active,true),features=v_features,description=p_description where id=p_plan_id returning * into v_plan;
  if v_plan.id is null then raise exception 'Plan not found'; end if;
  return v_plan;
end; $$;
grant execute on function public.admin_update_plan(text,numeric,integer,boolean,jsonb,integer,integer,text) to authenticated;
