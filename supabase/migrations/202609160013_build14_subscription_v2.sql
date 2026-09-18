BEGIN;

-- Build 14: Subscription V2 + centralized entitlements and safe server-side limits.
-- Preserve existing storage vocabulary (TRIAL/ACTIVE/...) for compatibility.
-- The API layer maps TRIAL to TRIALING where a canonical lifecycle label is needed.

-- -----------------------------------------------------------------------------
-- 1. Canonical plan catalog fields
-- -----------------------------------------------------------------------------
alter table public.saas_plans add column if not exists price_annual numeric(12,2);
alter table public.saas_plans add column if not exists max_staff integer;
alter table public.saas_plans add column if not exists max_branches integer;
alter table public.saas_plans add column if not exists max_tables integer;
alter table public.saas_plans add column if not exists max_menu_items integer;
alter table public.saas_plans add column if not exists max_monthly_orders integer;
alter table public.saas_plans add column if not exists provider_plan_id_annual text;
alter table public.saas_plans add column if not exists updated_at timestamptz not null default now();

-- Prices are only rewritten while no provider plan has been provisioned for that
-- interval. Once a Razorpay plan exists the provider owns the amount, so silently
-- changing the internal price here would desynchronise internal and provider pricing
-- and existing subscribers would be billed an amount the catalog no longer shows.
update public.saas_plans
set
  price_monthly = case
    when provider_plan_id is not null then price_monthly
    else case id when 'STARTER' then 799 when 'GROWTH' then 1499 when 'PRO' then 2999 else price_monthly end
  end,
  price_annual = case
    when provider_plan_id_annual is not null then price_annual
    else case id when 'STARTER' then 7990 when 'GROWTH' then 14990 when 'PRO' then 29990 else coalesce(price_annual, price_monthly * 10) end
  end,
  trial_days = 14,
  currency = 'INR',
  billing_interval = 'month',
  description = case id
    when 'STARTER' then 'Digital menu, QR ordering, kitchen dashboard and pay at counter.'
    when 'GROWTH' then 'Starter plus online payments, service requests, analytics and branding.'
    when 'PRO' then 'Growth plus multi-branch and advanced operational entitlements.'
    else description
  end,
  max_staff = case id when 'STARTER' then 3 when 'GROWTH' then 8 when 'PRO' then 30 else max_staff end,
  max_branches = case id when 'STARTER' then 1 when 'GROWTH' then 1 when 'PRO' then 3 else max_branches end,
  max_tables = case id when 'STARTER' then 10 when 'GROWTH' then 25 when 'PRO' then 75 else max_tables end,
  max_menu_items = case id when 'STARTER' then 100 when 'GROWTH' then 300 when 'PRO' then 1000 else max_menu_items end,
  max_monthly_orders = case id when 'STARTER' then 1000 when 'GROWTH' then 3000 when 'PRO' then 10000 else max_monthly_orders end,
  features = case id
    when 'STARTER' then jsonb_build_object(
      'ONLINE_PAYMENTS', false, 'UNLIMITED_STAFF', false, 'SERVICE_REQUESTS', false,
      'ANALYTICS', false, 'PAYMENT_TRACKING', false, 'CUSTOM_BRANDING', false,
      'MULTI_BRANCH', false, 'ADVANCED_ANALYTICS', false, 'CROSS_BRANCH_REPORTING', false,
      'ADVANCED_PERMISSIONS', false, 'CUSTOM_DOMAIN', false, 'max_staff', 3, 'max_branches', 1)
    when 'GROWTH' then jsonb_build_object(
      'ONLINE_PAYMENTS', true, 'UNLIMITED_STAFF', false, 'SERVICE_REQUESTS', true,
      'ANALYTICS', true, 'PAYMENT_TRACKING', true, 'CUSTOM_BRANDING', true,
      'MULTI_BRANCH', false, 'ADVANCED_ANALYTICS', false, 'CROSS_BRANCH_REPORTING', false,
      'ADVANCED_PERMISSIONS', false, 'CUSTOM_DOMAIN', false, 'max_staff', 8, 'max_branches', 1)
    when 'PRO' then jsonb_build_object(
      'ONLINE_PAYMENTS', true, 'UNLIMITED_STAFF', false, 'SERVICE_REQUESTS', true,
      'ANALYTICS', true, 'PAYMENT_TRACKING', true, 'CUSTOM_BRANDING', true,
      'MULTI_BRANCH', true, 'ADVANCED_ANALYTICS', true, 'CROSS_BRANCH_REPORTING', true,
      'ADVANCED_PERMISSIONS', true, 'CUSTOM_DOMAIN', true, 'max_staff', 30, 'max_branches', 3)
    else features
  end
where id in ('STARTER','GROWTH','PRO');

-- Provider annual plan IDs are separate from monthly IDs because Razorpay plan
-- frequency is defined by the provider plan itself.
create unique index if not exists saas_plans_provider_plan_id_annual_uidx
  on public.saas_plans(provider_plan_id_annual)
  where provider_plan_id_annual is not null;

alter table public.saas_plans
  drop constraint if exists saas_plans_v2_limits_check;
alter table public.saas_plans
  add constraint saas_plans_v2_limits_check
  check (
    (price_annual is null or price_annual >= 0)
    and (max_staff is null or max_staff >= 0)
    and (max_branches is null or max_branches >= 0)
    and (max_tables is null or max_tables >= 0)
    and (max_menu_items is null or max_menu_items >= 0)
    and (max_monthly_orders is null or max_monthly_orders >= 0)
  );

-- -----------------------------------------------------------------------------
-- 2. Subscription snapshots / billing interval
-- -----------------------------------------------------------------------------
alter table public.organization_subscriptions add column if not exists price_annual_snapshot numeric(12,2);
alter table public.organization_subscriptions add column if not exists selected_price_snapshot numeric(12,2);
alter table public.organization_subscriptions add column if not exists billing_period_start_at timestamptz;
alter table public.organization_subscriptions add column if not exists billing_period_end_at timestamptz;
alter table public.organization_subscriptions add column if not exists last_provider_event_id text;
alter table public.organization_subscriptions add column if not exists pending_billing_interval text;

update public.organization_subscriptions os
set
  price_annual_snapshot = coalesce(os.price_annual_snapshot, sp.price_annual),
  selected_price_snapshot = coalesce(os.selected_price_snapshot,
    case when lower(coalesce(os.billing_interval,'month')) = 'year' then sp.price_annual else sp.price_monthly end),
  billing_period_start_at = coalesce(os.billing_period_start_at, os.current_period_start, os.trial_started_at),
  billing_period_end_at = coalesce(os.billing_period_end_at, os.current_period_end, os.trial_ends_at)
from public.saas_plans sp
where sp.id = os.plan_id;

-- Existing subscriptions created by organization onboarding already have a 14-day
-- trial without a payment method. Preserve that model and repair null windows only.
update public.organization_subscriptions
set trial_started_at = coalesce(trial_started_at, created_at),
    trial_ends_at = coalesce(trial_ends_at, created_at + interval '14 days')
where status = 'TRIAL';

-- -----------------------------------------------------------------------------
-- 2b. Order quota window
--
-- max_monthly_orders is a MONTHLY allowance. On an annual subscription the
-- billing period is twelve months long, so counting orders across the whole
-- billing period would turn a 1,000/month allowance into 1,000/year. This helper
-- returns the current one-month slice of the billing period and is used by both
-- the entitlement resolver (display) and the enforcement path so the number the
-- owner sees always matches the number that is enforced.
-- -----------------------------------------------------------------------------
create or replace function public.subscription_order_window(
  p_start timestamptz,
  p_end timestamptz,
  out window_start timestamptz,
  out window_end timestamptz
)
language plpgsql
stable
set search_path = public
as $$
declare v_months integer;
begin
  if p_start is null then
    window_start := date_trunc('month', now());
    window_end := window_start + interval '1 month';
    if p_end is not null and p_end < window_end then window_end := p_end; end if;
    -- Same inversion guard as the branch below: a p_end already in the past
    -- (relative to the current calendar month) would otherwise leave
    -- window_end before window_start.
    if window_end <= window_start then
      window_start := window_end - interval '1 month';
    end if;
    return;
  end if;
  v_months := (extract(year from age(now(), p_start)) * 12 + extract(month from age(now(), p_start)))::integer;
  if v_months < 0 then v_months := 0; end if;
  window_start := p_start + make_interval(months => v_months);
  window_end := window_start + interval '1 month';
  if p_end is not null and p_end < window_end then window_end := p_end; end if;
  -- window_end is clipped to the billing period end, so a stale current_period_end
  -- (a renewal webhook that arrives late, say) could otherwise leave window_end
  -- before window_start. The count query would then match nothing and briefly
  -- under-report usage. Never let the window invert: fall back to the trailing
  -- month ending at window_end.
  if window_end <= window_start then
    window_start := window_end - interval '1 month';
  end if;
end;
$$;
grant execute on function public.subscription_order_window(timestamptz,timestamptz) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Central entitlement resolver
-- -----------------------------------------------------------------------------
drop function if exists public.get_organization_entitlements_v2(uuid);
create function public.get_organization_entitlements_v2(p_organization_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := p_organization_id;
  v_plan public.saas_plans;
  v_sub public.organization_subscriptions;
  v_status text;
  v_trial_expired boolean := false;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_order_count integer := 0;
  v_staff_count integer := 0;
  v_branch_count integer := 0;
  v_table_count integer := 0;
  v_menu_count integer := 0;
  v_order_window_start timestamptz;
  v_order_window_end timestamptz;
  v_features jsonb := '{}'::jsonb;
begin
  if v_org is null then
    select s.organization_id into v_org
    from public.staff s
    where s.user_id = auth.uid() and s.active = true
    order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
    limit 1;
  elsif auth.uid() is not null and not public.is_org_member(v_org) and not public.is_platform_admin() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if v_org is null then return null; end if;

  select * into v_sub from public.organization_subscriptions where organization_id = v_org;
  if v_sub.id is null then return null; end if;
  select * into v_plan from public.saas_plans where id = v_sub.plan_id;
  if v_plan.id is null then return null; end if;

  v_trial_expired := v_sub.status = 'TRIAL' and v_sub.trial_ends_at is not null and v_sub.trial_ends_at <= now();
  v_status := case when v_trial_expired then 'EXPIRED' when v_sub.status = 'TRIAL' then 'TRIALING' else v_sub.status end;
  v_features := case when v_status in ('TRIALING','ACTIVE') then coalesce(v_plan.features,'{}'::jsonb) else '{}'::jsonb end;

  v_period_start := case when v_status = 'TRIALING' then v_sub.trial_started_at else coalesce(v_sub.current_period_start, v_sub.billing_period_start_at) end;
  v_period_end := case when v_status = 'TRIALING' then v_sub.trial_ends_at else coalesce(v_sub.current_period_end, v_sub.billing_period_end_at) end;

  select count(*)::integer into v_staff_count
  from public.staff s
  where s.organization_id = v_org and s.active = true and s.role <> 'OWNER';

  select count(*)::integer into v_branch_count from public.branches b where b.organization_id = v_org and b.is_active = true;
  select count(*)::integer into v_table_count
  from public.tables t join public.branches b on b.id = t.branch_id
  where b.organization_id = v_org and t.active = true and b.is_active = true;
  select count(*)::integer into v_menu_count
  from public.menu_items m join public.branches b on b.id = m.branch_id
  where b.organization_id = v_org and m.is_available = true and b.is_active = true;

  select w.window_start, w.window_end into v_order_window_start, v_order_window_end
  from public.subscription_order_window(v_period_start, v_period_end) w;

  select count(*)::integer into v_order_count
  from public.orders o join public.branches b on b.id = o.branch_id
  where b.organization_id = v_org
    and o.created_at >= v_order_window_start
    and (v_order_window_end is null or o.created_at < v_order_window_end);

  return jsonb_build_object(
    'organization_id', v_org,
    'plan_id', v_plan.id,
    'plan_name', v_plan.name,
    'status', v_status,
    'trial_started_at', v_sub.trial_started_at,
    'trial_ends_at', v_sub.trial_ends_at,
    'current_period_start', v_sub.current_period_start,
    'current_period_end', v_sub.current_period_end,
    'billing_interval', lower(coalesce(v_sub.billing_interval, 'month')),
    -- Snapshots first: a catalog price change must never retroactively alter what an
    -- existing subscriber is shown or charged. catalog_* exposes the live list price.
    'price_monthly', coalesce(v_sub.price_monthly_snapshot, v_plan.price_monthly),
    'price_annual', coalesce(v_sub.price_annual_snapshot, v_plan.price_annual),
    'catalog_price_monthly', v_plan.price_monthly,
    'catalog_price_annual', v_plan.price_annual,
    'selected_price', coalesce(
      v_sub.selected_price_snapshot,
      case when lower(coalesce(v_sub.billing_interval,'month'))='year'
        then coalesce(v_sub.price_annual_snapshot, v_plan.price_annual)
        else coalesce(v_sub.price_monthly_snapshot, v_plan.price_monthly) end),
    'currency', coalesce(v_sub.currency, v_plan.currency, 'INR'),
    'provider_subscription_id', v_sub.provider_subscription_id,
    'pending_plan_id', v_sub.pending_plan_id,
    'pending_billing_interval', v_sub.pending_billing_interval,
    'cancellation_requested_at', v_sub.cancellation_requested_at,
    'order_window_start', v_order_window_start,
    'order_window_end', v_order_window_end,
    'features', v_features,
    'limits', jsonb_build_object(
      'max_staff', v_plan.max_staff,
      'max_branches', v_plan.max_branches,
      'max_tables', v_plan.max_tables,
      'max_menu_items', v_plan.max_menu_items,
      'max_monthly_orders', v_plan.max_monthly_orders
    ),
    'usage', jsonb_build_object(
      'staff', v_staff_count,
      'branches', v_branch_count,
      'tables', v_table_count,
      'menu_items', v_menu_count,
      'orders', v_order_count
    ),
    'remaining', jsonb_build_object(
      'staff', case when v_plan.max_staff is null then null else greatest(v_plan.max_staff - v_staff_count, 0) end,
      'branches', case when v_plan.max_branches is null then null else greatest(v_plan.max_branches - v_branch_count, 0) end,
      'tables', case when v_plan.max_tables is null then null else greatest(v_plan.max_tables - v_table_count, 0) end,
      'menu_items', case when v_plan.max_menu_items is null then null else greatest(v_plan.max_menu_items - v_menu_count, 0) end,
      'orders', case when v_plan.max_monthly_orders is null then null else greatest(v_plan.max_monthly_orders - v_order_count, 0) end
    )
  );
end;
$$;
grant execute on function public.get_organization_entitlements_v2(uuid) to authenticated, service_role;

-- Keep the legacy function as a compatibility wrapper, now returning complete limits.
create or replace function public.get_current_entitlements()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.get_organization_entitlements_v2(null);
$$;
grant execute on function public.get_current_entitlements() to authenticated;

create or replace function public.organization_has_feature(p_organization_id uuid, p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_features jsonb; v_status text; v_trial_end timestamptz; v_key text:=upper(trim(coalesce(p_feature,'')));
begin
  if auth.uid() is not null and auth.role() <> 'anon' and not public.is_org_member(p_organization_id) and not public.is_platform_admin() then return false; end if;
  select os.status,os.trial_ends_at,sp.features into v_status,v_trial_end,v_features from public.organization_subscriptions os join public.saas_plans sp on sp.id=os.plan_id where os.organization_id=p_organization_id;
  if v_status is null then return false; end if;
  if v_status='TRIAL' and v_trial_end is not null and v_trial_end<=now() then return false; end if;
  if v_status not in ('TRIAL','ACTIVE') then return false; end if;
  return coalesce((v_features->>v_key)::boolean,false);
end;
$$;
grant execute on function public.organization_has_feature(uuid,text) to authenticated,service_role;

-- -----------------------------------------------------------------------------
-- 4. Safe server-side limit checks
-- -----------------------------------------------------------------------------
-- VOLATILE, not STABLE: the body takes a row lock (SELECT ... FOR UPDATE) to make
-- concurrent quota checks safe, and PostgreSQL rejects SELECT FOR UPDATE inside a
-- non-volatile function ("... is not allowed in a non-volatile function"). Marking
-- this STABLE made every branch/staff/table/menu insert fail at runtime.
create or replace function public.subscription_resource_available_internal(p_organization_id uuid, p_resource text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_sub public.organization_subscriptions;
  v_plan public.saas_plans;
  v_resource text := lower(trim(coalesce(p_resource,'')));
  v_limit integer;
  v_usage integer;
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_organization_id is null then return false; end if;
  select * into v_sub from public.organization_subscriptions where organization_id=p_organization_id for update;
  if v_sub.id is null then return false; end if;
  if v_sub.status='TRIAL' and v_sub.trial_ends_at is not null and v_sub.trial_ends_at <= now() then return false; end if;
  if v_sub.status not in ('TRIAL','ACTIVE') then return false; end if;
  select * into v_plan from public.saas_plans where id=v_sub.plan_id and active=true;
  if v_plan.id is null then return false; end if;
  v_limit := case v_resource
    when 'staff' then v_plan.max_staff
    when 'branches' then v_plan.max_branches
    when 'tables' then v_plan.max_tables
    when 'menu_items' then v_plan.max_menu_items
    when 'orders' then v_plan.max_monthly_orders
    else null
  end;
  if v_limit is null then return true; end if;
  if v_resource='staff' then
    select count(*)::integer into v_usage from public.staff where organization_id=p_organization_id and active=true and role <> 'OWNER';
  elsif v_resource='branches' then
    select count(*)::integer into v_usage from public.branches where organization_id=p_organization_id and is_active=true;
  elsif v_resource='tables' then
    select count(*)::integer into v_usage from public.tables t join public.branches b on b.id=t.branch_id where b.organization_id=p_organization_id and b.is_active=true and t.active=true;
  elsif v_resource='menu_items' then
    select count(*)::integer into v_usage from public.menu_items m join public.branches b on b.id=m.branch_id where b.organization_id=p_organization_id and b.is_active=true and m.is_available=true;
  elsif v_resource='orders' then
    v_start := case when v_sub.status='TRIAL' then v_sub.trial_started_at else coalesce(v_sub.current_period_start,v_sub.billing_period_start_at) end;
    v_end := case when v_sub.status='TRIAL' then v_sub.trial_ends_at else coalesce(v_sub.current_period_end,v_sub.billing_period_end_at) end;
    -- Same one-month slice the entitlement resolver reports, so the enforced quota
    -- always matches the usage shown in the dashboard (including on annual plans).
    select w.window_start, w.window_end into v_start, v_end from public.subscription_order_window(v_start, v_end) w;
    select count(*)::integer into v_usage from public.orders o join public.branches b on b.id=o.branch_id where b.organization_id=p_organization_id and o.created_at >= v_start and (v_end is null or o.created_at < v_end);
  else
    return false;
  end if;
  return v_usage < v_limit;
end;
$$;

grant execute on function public.subscription_resource_available_internal(uuid,text) to service_role;

-- VOLATILE for the same reason as subscription_resource_available_internal, which
-- this delegates to.
create or replace function public.organization_can_add_resource(p_organization_id uuid, p_resource text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return false; end if;
  if not public.is_org_member(p_organization_id) and not public.is_platform_admin() then return false; end if;
  return public.subscription_resource_available_internal(p_organization_id,p_resource);
end;
$$;
grant execute on function public.organization_can_add_resource(uuid,text) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Subscription V2 checkout/metadata functions
-- -----------------------------------------------------------------------------
drop function if exists public.begin_subscription_checkout_v2(text,text);
create function public.begin_subscription_checkout_v2(p_plan_id text, p_billing_interval text default 'month')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_sub public.organization_subscriptions;
  v_plan public.saas_plans;
  v_interval text := lower(trim(coalesce(p_billing_interval,'month')));
  v_provider_plan_id text;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Only the organization owner can manage billing' using errcode='42501'; end if;
  if v_interval not in ('month','year') then raise exception 'Invalid billing interval'; end if;
  select * into v_plan from public.saas_plans where id=p_plan_id and active=true;
  if v_plan.id is null then raise exception 'Invalid plan' using errcode='22023'; end if;
  if v_interval='month' and v_plan.price_monthly < 1 then raise exception 'Monthly plan price must be at least ₹1' using errcode='22023'; end if;
  if v_interval='year' and coalesce(v_plan.price_annual,0) < 1 then raise exception 'Annual plan price must be at least ₹1' using errcode='22023'; end if;

  select * into v_sub from public.organization_subscriptions where organization_id=v_org for update;
  if v_sub.id is null then
    raise exception 'Restaurant subscription was not initialized' using errcode='P0001';
  end if;
  if v_sub.provider_subscription_id is not null and v_sub.status = 'ACTIVE' then
    -- A genuinely active, paid subscription must go through the plan-change path
    -- (schedule_subscription_plan_change_v2) instead of a second Razorpay
    -- subscription. Every other stored state -- TRIAL, PAST_DUE, EXPIRED,
    -- CANCELLED, SUSPENDED -- has no live paid access, so once the trial or
    -- billing period has lapsed (or the provider subscription failed/expired)
    -- the owner must still be able to start a fresh checkout, even if a stale
    -- provider_subscription_id is still attached to the row.
    raise exception 'An active Tablely subscription already exists' using errcode='23505';
  end if;
  v_provider_plan_id := case when v_interval='year' then v_plan.provider_plan_id_annual else v_plan.provider_plan_id end;
  if v_provider_plan_id is null then
    raise exception 'This billing interval is not provisioned for the selected plan' using errcode='55000';
  end if;

  return jsonb_build_object(
    'organization_id', v_org,
    'plan_id', v_plan.id,
    'plan_name', v_plan.name,
    'billing_interval', v_interval,
    'price', case when v_interval='year' then v_plan.price_annual else v_plan.price_monthly end,
    'currency', coalesce(v_plan.currency,'INR'),
    'provider_plan_id', v_provider_plan_id,
    'provider_subscription_id', v_sub.provider_subscription_id
  );
end;
$$;
grant execute on function public.begin_subscription_checkout_v2(text,text) to authenticated;

create or replace function public.record_subscription_provider_creation_v2(
  p_organization_id uuid,
  p_plan_id text,
  p_provider_subscription_id text,
  p_billing_interval text
)
returns public.organization_subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub public.organization_subscriptions;
  v_plan public.saas_plans;
  v_interval text := lower(trim(coalesce(p_billing_interval,'month')));
begin
  if auth.uid() is not null and not public.is_org_owner(p_organization_id) then
    raise exception 'Only the organization owner can update billing' using errcode='42501';
  end if;
  if v_interval not in ('month','year') then raise exception 'Invalid billing interval'; end if;
  select * into v_plan from public.saas_plans where id=p_plan_id and active=true;
  if v_plan.id is null then raise exception 'Plan not found'; end if;
  update public.organization_subscriptions
  set plan_id=p_plan_id,
      provider='RAZORPAY',
      provider_subscription_id=p_provider_subscription_id,
      billing_interval=v_interval,
      price_monthly_snapshot=v_plan.price_monthly,
      price_annual_snapshot=v_plan.price_annual,
      selected_price_snapshot=case when v_interval='year' then v_plan.price_annual else v_plan.price_monthly end,
      currency=coalesce(v_plan.currency,'INR'),
      billing_period_start_at=coalesce(current_period_start, trial_started_at),
      billing_period_end_at=current_period_end,
      updated_at=now()
  where organization_id=p_organization_id
  returning * into v_sub;
  if v_sub.id is null then raise exception 'Subscription not found'; end if;
  return v_sub;
end;
$$;
-- Server-only. Granting this to authenticated lets an owner bind an arbitrary
-- provider subscription id to any plan and, with confirm_subscription_payment_v2,
-- activate a paid plan without a payment. The checkout API calls it with the
-- service-role client after begin_subscription_checkout_v2 has authorized the owner.
revoke execute on function public.record_subscription_provider_creation_v2(uuid,text,text,text) from public, authenticated;
grant execute on function public.record_subscription_provider_creation_v2(uuid,text,text,text) to service_role;

-- -----------------------------------------------------------------------------
-- 6. Billing context / current subscription wrappers now expose V2 fields
-- -----------------------------------------------------------------------------
create or replace function public.get_current_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_sub public.organization_subscriptions;
  v_plan public.saas_plans;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active order by case when s.role='OWNER' then 0 when s.role='MANAGER' then 1 else 2 end, s.created_at limit 1;
  if v_org is null then return null; end if;
  select * into v_sub from public.organization_subscriptions where organization_id=v_org;
  if v_sub.id is null then return null; end if;
  select * into v_plan from public.saas_plans where id=v_sub.plan_id;
  return jsonb_build_object(
    'id',v_sub.id,'organization_id',v_sub.organization_id,'plan_id',v_sub.plan_id,
    'plan_name',v_plan.name,
    'status',case when v_sub.status='TRIAL' and v_sub.trial_ends_at <= now() then 'EXPIRED' when v_sub.status='TRIAL' then 'TRIALING' else v_sub.status end,
    'price_monthly_snapshot',v_sub.price_monthly_snapshot,
    'price_annual_snapshot',v_sub.price_annual_snapshot,
    'selected_price_snapshot',v_sub.selected_price_snapshot,
    'currency',v_sub.currency,'billing_interval',lower(coalesce(v_sub.billing_interval,'month')),
    'trial_started_at',v_sub.trial_started_at,'trial_ends_at',v_sub.trial_ends_at,
    'current_period_start',v_sub.current_period_start,'current_period_end',v_sub.current_period_end,
    'provider',v_sub.provider,'provider_customer_id',v_sub.provider_customer_id,
    'provider_subscription_id',v_sub.provider_subscription_id,
    'pending_plan_id',v_sub.pending_plan_id,'pending_provider_plan_id',v_sub.pending_provider_plan_id,
    'pending_billing_interval',v_sub.pending_billing_interval,
    'cancellation_requested_at',v_sub.cancellation_requested_at,'cancelled_at',v_sub.cancelled_at
  );
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
declare v_org uuid; v_ent jsonb;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active order by s.created_at limit 1;
  if v_org is null then return null; end if;
  v_ent := public.get_organization_entitlements_v2(v_org);
  return jsonb_build_object(
    'plan_id',v_ent->>'plan_id','plan_name',v_ent->>'plan_name','price_monthly',(v_ent->>'price_monthly')::numeric,
    'price_annual',(v_ent->>'price_annual')::numeric,'selected_price',(v_ent->>'selected_price')::numeric,
    'currency',v_ent->>'currency','status',v_ent->>'status','billing_interval',v_ent->>'billing_interval',
    'trial_ends_at',v_ent->>'trial_ends_at','current_period_end',v_ent->>'current_period_end',
    'provider_subscription_id',v_ent->>'provider_subscription_id','pending_plan_id',v_ent->>'pending_plan_id',
    'cancellation_requested_at',v_ent->>'cancellation_requested_at','pending_billing_interval',v_ent->>'pending_billing_interval',
    'order_window_start',v_ent->>'order_window_start','order_window_end',v_ent->>'order_window_end',
    'limits',v_ent->'limits','usage',v_ent->'usage','remaining',v_ent->'remaining'
  );
end;
$$;
grant execute on function public.get_billing_context() to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Server-side limit triggers. Existing data is preserved; only creation or
-- activation beyond a plan limit is rejected.
-- -----------------------------------------------------------------------------
create or replace function public.enforce_subscription_resource_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_limit integer;
  v_usage integer;
  v_resource text;
  v_status text;
begin
  if tg_table_name = 'branches' then
    if coalesce(new.is_active,true) and (tg_op='INSERT' or not coalesce(old.is_active,false)) then
      v_org := new.organization_id; v_resource := 'branches';
    else return new; end if;
  elsif tg_table_name = 'staff' then
    if coalesce(new.active,true) and new.role <> 'OWNER' and (tg_op='INSERT' or not coalesce(old.active,false) or old.role='OWNER') then
      v_org := new.organization_id; v_resource := 'staff';
    else return new; end if;
  elsif tg_table_name = 'tables' then
    if coalesce(new.active,true) and (tg_op='INSERT' or not coalesce(old.active,false)) then
      select organization_id into v_org from public.branches where id=new.branch_id; v_resource := 'tables';
    else return new; end if;
  elsif tg_table_name = 'menu_items' then
    if (tg_op='INSERT' or not coalesce(old.is_available,false)) and coalesce(new.is_available,true) then
      select organization_id into v_org from public.branches where id=new.branch_id; v_resource := 'menu_items';
    else return new; end if;
  else
    return new;
  end if;

  if v_org is null then raise exception 'Organization could not be resolved' using errcode='23514'; end if;
  select status into v_status from public.organization_subscriptions where organization_id=v_org;
  if v_status = 'TRIAL' and exists(select 1 from public.organization_subscriptions where organization_id=v_org and trial_ends_at <= now()) then
    raise exception 'Your Tablely trial has expired' using errcode='42501';
  end if;
  if not public.subscription_resource_available_internal(v_org, v_resource) then
    raise exception 'Your current Tablely plan has reached its % limit', v_resource using errcode='42501';
  end if;
  return new;
end;
$$;

drop trigger if exists subscription_limit_branches on public.branches;
create trigger subscription_limit_branches before insert or update of is_active on public.branches for each row execute function public.enforce_subscription_resource_limit();

drop trigger if exists subscription_limit_staff on public.staff;
create trigger subscription_limit_staff before insert or update of active,role on public.staff for each row execute function public.enforce_subscription_resource_limit();

drop trigger if exists subscription_limit_tables on public.tables;
create trigger subscription_limit_tables before insert or update of active on public.tables for each row execute function public.enforce_subscription_resource_limit();

drop trigger if exists subscription_limit_menu_items on public.menu_items;
create trigger subscription_limit_menu_items before insert or update of is_available on public.menu_items for each row execute function public.enforce_subscription_resource_limit();

-- Order quota: restaurant orders count when an order row is actually created.
create or replace function public.enforce_subscription_order_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid; v_limit integer; v_usage integer; v_sub public.organization_subscriptions;
begin
  select organization_id into v_org from public.branches where id=new.branch_id;
  if v_org is null then raise exception 'Organization could not be resolved' using errcode='23514'; end if;
  if not public.subscription_resource_available_internal(v_org,'orders') then
    select * into v_sub from public.organization_subscriptions where organization_id=v_org;
    if v_sub.id is null then raise exception 'Restaurant subscription not found' using errcode='42501'; end if;
    if v_sub.status='TRIAL' and v_sub.trial_ends_at is not null and v_sub.trial_ends_at <= now() then raise exception 'Your Tablely trial has expired' using errcode='42501'; end if;
    raise exception 'Your current Tablely plan has reached its monthly order limit' using errcode='42501';
  end if;
  return new;
end;
$$;
grant execute on function public.enforce_subscription_order_limit() to service_role;

-- The function above was previously defined but never attached, so the order quota
-- was advertised in the UI and never enforced. Bind it. BEFORE INSERT only: an order
-- row exists only once create_order_for_table succeeds, so an abandoned or
-- unverified PAY_NOW attempt never consumes quota (Build 13.3 payment-first flow).
drop trigger if exists subscription_limit_orders on public.orders;
create trigger subscription_limit_orders
before insert on public.orders
for each row execute function public.enforce_subscription_order_limit();

-- Plan catalog: authenticated users can read active plans, but not the Razorpay plan
-- identifiers. Those are only needed by the platform-admin catalog and by server-side
-- checkout, and every identifier a client holds is one more input to a forged billing
-- call. Column-level grants replace the previous table-wide grant.
revoke select on public.saas_plans from authenticated;
grant select (
  id, name, description, price_monthly, price_annual, currency, billing_interval,
  trial_days, active, features, max_staff, max_branches, max_tables, max_menu_items,
  max_monthly_orders, created_at, updated_at
) on public.saas_plans to authenticated;



-- -----------------------------------------------------------------------------
-- 8. Catalog/admin compatibility RPCs for Build 14 UI
-- -----------------------------------------------------------------------------
-- No provider_plan_id columns here: this is the catalog every authenticated user can
-- read. Platform admins get the provider ids from admin_list_plans_v2 instead, and
-- has_monthly/has_annual is all any client needs in order to know which billing
-- intervals are actually purchasable.
drop function if exists public.get_active_plan_catalog_v2();
create function public.get_active_plan_catalog_v2()
returns table(
  id text, name text, description text, price_monthly numeric, price_annual numeric,
  currency text, trial_days integer, active boolean, features jsonb,
  max_staff integer, max_branches integer, max_tables integer, max_menu_items integer,
  max_monthly_orders integer, has_monthly boolean, has_annual boolean
)
language sql stable security definer set search_path=public as $$
  select p.id,p.name,p.description,p.price_monthly,p.price_annual,p.currency,p.trial_days,p.active,p.features,
         p.max_staff,p.max_branches,p.max_tables,p.max_menu_items,p.max_monthly_orders,
         p.provider_plan_id is not null,p.provider_plan_id_annual is not null
  from public.saas_plans p
  where p.active=true
  order by p.price_monthly;
$$;
grant execute on function public.get_active_plan_catalog_v2() to authenticated;

create or replace function public.admin_list_plans_v2()
returns table(
  id text, name text, description text, price_monthly numeric, price_annual numeric,
  currency text, trial_days integer, active boolean, features jsonb,
  max_staff integer, max_branches integer, max_tables integer, max_menu_items integer,
  max_monthly_orders integer, provider_plan_id text, provider_plan_id_annual text
)
language sql stable security definer set search_path=public as $$
  select p.id,p.name,p.description,p.price_monthly,p.price_annual,p.currency,p.trial_days,p.active,p.features,
         p.max_staff,p.max_branches,p.max_tables,p.max_menu_items,p.max_monthly_orders,
         p.provider_plan_id,p.provider_plan_id_annual
  from public.saas_plans p
  where public.is_platform_admin()
  order by p.price_monthly;
$$;
grant execute on function public.admin_list_plans_v2() to authenticated;

create or replace function public.admin_update_plan_v2(
  p_plan_id text,
  p_price_monthly numeric,
  p_price_annual numeric,
  p_trial_days integer,
  p_active boolean,
  p_features jsonb,
  p_max_staff integer,
  p_max_branches integer,
  p_max_tables integer,
  p_max_menu_items integer,
  p_max_monthly_orders integer,
  p_description text default null
)
returns public.saas_plans
language plpgsql security definer set search_path=public as $$
declare v_plan public.saas_plans; v_features jsonb := coalesce(p_features,'{}'::jsonb);
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  if p_price_monthly is null or p_price_monthly < 1 then raise exception 'Monthly price must be at least ₹1'; end if;
  if p_price_annual is null or p_price_annual < 1 then raise exception 'Annual price must be at least ₹1'; end if;
  if p_trial_days is null or p_trial_days < 0 or p_trial_days > 90 then raise exception 'Trial days must be between 0 and 90'; end if;
  if p_max_staff is not null and p_max_staff < 0 then raise exception 'Maximum staff cannot be negative'; end if;
  if p_max_branches is not null and p_max_branches < 0 then raise exception 'Maximum branches cannot be negative'; end if;
  if p_max_tables is not null and p_max_tables < 0 then raise exception 'Maximum tables cannot be negative'; end if;
  if p_max_menu_items is not null and p_max_menu_items < 0 then raise exception 'Maximum menu items cannot be negative'; end if;
  if p_max_monthly_orders is not null and p_max_monthly_orders < 0 then raise exception 'Maximum monthly orders cannot be negative'; end if;
  select * into v_plan from public.saas_plans where id=p_plan_id for update;
  if v_plan.id is null then raise exception 'Plan not found'; end if;
  if v_plan.provider_plan_id is not null and p_price_monthly <> v_plan.price_monthly then raise exception 'Monthly price is locked after provider plan provisioning'; end if;
  if v_plan.provider_plan_id_annual is not null and p_price_annual <> v_plan.price_annual then raise exception 'Annual price is locked after provider plan provisioning'; end if;
  v_features := jsonb_set(v_features,'{max_staff}',to_jsonb(p_max_staff),true);
  v_features := jsonb_set(v_features,'{max_branches}',to_jsonb(p_max_branches),true);
  update public.saas_plans
  set price_monthly=p_price_monthly,
      price_annual=p_price_annual,
      trial_days=p_trial_days,
      active=coalesce(p_active,true),
      features=v_features,
      max_staff=p_max_staff,
      max_branches=p_max_branches,
      max_tables=p_max_tables,
      max_menu_items=p_max_menu_items,
      max_monthly_orders=p_max_monthly_orders,
      description=coalesce(p_description,description),
      updated_at=now()
  where id=p_plan_id
  returning * into v_plan;
  if v_plan.id is null then raise exception 'Plan not found'; end if;
  return v_plan;
end;
$$;

grant execute on function public.admin_update_plan_v2(text,numeric,numeric,integer,boolean,jsonb,integer,integer,integer,integer,integer,text) to authenticated;

create or replace function public.admin_set_provider_plan_id_v2(p_plan_id text,p_provider_plan_id text,p_billing_interval text)
returns public.saas_plans
language plpgsql security definer set search_path=public as $$
declare v_plan public.saas_plans; v_interval text:=lower(trim(coalesce(p_billing_interval,'month')));
begin
  if auth.uid() is not null and not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  if v_interval not in ('month','year') then raise exception 'Invalid billing interval'; end if;
  if p_provider_plan_id is null or trim(p_provider_plan_id)='' then raise exception 'Provider plan ID is required'; end if;
  update public.saas_plans
  set provider_plan_id=case when v_interval='month' then p_provider_plan_id else provider_plan_id end,
      provider_plan_id_annual=case when v_interval='year' then p_provider_plan_id else provider_plan_id_annual end,
      updated_at=now()
  where id=p_plan_id
  returning * into v_plan;
  if v_plan.id is null then raise exception 'Plan not found'; end if;
  return v_plan;
end;
$$;
-- Server-only: provider plan ids are written by the provisioning API after it has
-- verified platform-admin access.
revoke execute on function public.admin_set_provider_plan_id_v2(text,text,text) from public, authenticated;
grant execute on function public.admin_set_provider_plan_id_v2(text,text,text) to service_role;


create or replace function public.schedule_subscription_plan_change_v2(p_plan_id text,p_billing_interval text default 'month')
returns jsonb
language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_sub public.organization_subscriptions; v_plan public.saas_plans; v_interval text:=lower(trim(coalesce(p_billing_interval,'month'))); v_provider_plan text;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Only the organization owner can manage billing' using errcode='42501'; end if;
  if v_interval not in ('month','year') then raise exception 'Invalid billing interval'; end if;
  select * into v_plan from public.saas_plans where id=p_plan_id and active=true;
  if v_plan.id is null then raise exception 'Plan not found'; end if;
  select * into v_sub from public.organization_subscriptions where organization_id=v_org for update;
  if v_sub.id is null or v_sub.provider_subscription_id is null then raise exception 'This subscription is not connected to provider billing'; end if;
  v_provider_plan := case when v_interval='year' then v_plan.provider_plan_id_annual else v_plan.provider_plan_id end;
  if v_provider_plan is null then raise exception 'The selected billing interval is not provisioned'; end if;
  if p_plan_id=v_sub.plan_id and v_interval=lower(coalesce(v_sub.billing_interval,'month')) then raise exception 'You are already on this plan and billing interval'; end if;
  update public.organization_subscriptions set pending_plan_id=p_plan_id,pending_provider_plan_id=v_provider_plan,pending_billing_interval=v_interval,updated_at=now() where id=v_sub.id returning * into v_sub;
  return jsonb_build_object('provider_subscription_id',v_sub.provider_subscription_id,'provider_plan_id',v_provider_plan,'pending_plan_id',p_plan_id,'pending_billing_interval',v_interval);
end;
$$;
grant execute on function public.schedule_subscription_plan_change_v2(text,text) to authenticated;

create or replace function public.clear_pending_subscription_plan_change()
returns public.organization_subscriptions
language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_sub public.organization_subscriptions;
begin
  select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active and s.role='OWNER' order by s.created_at limit 1;
  if v_org is null then raise exception 'Only the organization owner can manage billing' using errcode='42501'; end if;
  update public.organization_subscriptions set pending_plan_id=null,pending_provider_plan_id=null,pending_billing_interval=null,updated_at=now() where organization_id=v_org returning * into v_sub;
  return v_sub;
end;
$$;
grant execute on function public.clear_pending_subscription_plan_change() to authenticated;

create or replace function public.get_subscription_usage()
returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('usage', x->'usage','limits',x->'limits','remaining',x->'remaining','status',x->'status','plan_id',x->'plan_id','plan_name',x->'plan_name','billing_interval',x->'billing_interval')
  from (select public.get_organization_entitlements_v2(null) x) q;
$$;
grant execute on function public.get_subscription_usage() to authenticated;


create or replace function public.admin_list_subscription_overview_v2()
returns table(
  organization_id uuid, organization_name text, plan_id text, plan_name text, status text,
  billing_interval text, selected_price numeric, trial_ends_at timestamptz,
  current_period_end timestamptz, provider_subscription_id text,
  staff_used integer, staff_limit integer, branches_used integer, branches_limit integer,
  tables_used integer, tables_limit integer, menu_items_used integer, menu_items_limit integer,
  orders_used integer, orders_limit integer, cancellation_requested_at timestamptz
)
language plpgsql security definer set search_path=public as $$
declare r record; x jsonb; v_provider_subscription_id text; v_cancellation_requested_at timestamptz;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  for r in select o.id,o.name from public.organizations o order by o.name loop
    x := public.get_organization_entitlements_v2(r.id);
    if x is not null then
      organization_id := r.id; organization_name := r.name; plan_id := x->>'plan_id'; plan_name := x->>'plan_name';
      status := x->>'status'; billing_interval := x->>'billing_interval'; selected_price := (x->>'selected_price')::numeric;
      trial_ends_at := (x->>'trial_ends_at')::timestamptz; current_period_end := (x->>'current_period_end')::timestamptz;
      -- Read into locals and qualify every column: the OUT parameters of this
      -- RETURNS TABLE share names with these columns, and plpgsql's default
      -- variable_conflict = error would abort with "column reference ... is ambiguous".
      select os.provider_subscription_id, os.cancellation_requested_at
        into v_provider_subscription_id, v_cancellation_requested_at
      from public.organization_subscriptions os
      where os.organization_id = r.id;
      provider_subscription_id := v_provider_subscription_id;
      cancellation_requested_at := v_cancellation_requested_at;
      staff_used := (x->'usage'->>'staff')::integer; staff_limit := (x->'limits'->>'max_staff')::integer;
      branches_used := (x->'usage'->>'branches')::integer; branches_limit := (x->'limits'->>'max_branches')::integer;
      tables_used := (x->'usage'->>'tables')::integer; tables_limit := (x->'limits'->>'max_tables')::integer;
      menu_items_used := (x->'usage'->>'menu_items')::integer; menu_items_limit := (x->'limits'->>'max_menu_items')::integer;
      orders_used := (x->'usage'->>'orders')::integer; orders_limit := (x->'limits'->>'max_monthly_orders')::integer;
      return next;
    end if;
  end loop;
end;
$$;
grant execute on function public.admin_list_subscription_overview_v2() to authenticated;



create or replace function public.confirm_subscription_payment_v2(
  p_provider_subscription_id text,
  p_provider_payment_id text,
  p_provider_period_start timestamptz default null,
  p_provider_period_end timestamptz default null
)
returns public.organization_subscriptions
language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_sub public.organization_subscriptions; v_plan public.saas_plans; v_amount numeric; v_start timestamptz; v_end timestamptz;
begin
  -- Normal path is the service role, called from /api/subscriptions/verify after the
  -- Razorpay signature and the provider subscription status have both been checked.
  -- A direct authenticated caller is still held to the owner check.
  if auth.uid() is null then
    select * into v_sub from public.organization_subscriptions where provider_subscription_id=p_provider_subscription_id for update;
    if v_sub.id is null then raise exception 'Subscription not found'; end if;
    v_org := v_sub.organization_id;
  else
    select s.organization_id into v_org from public.staff s where s.user_id=auth.uid() and s.active and s.role='OWNER' order by s.created_at limit 1;
    if v_org is null then raise exception 'Owner access required' using errcode='42501'; end if;
    select * into v_sub from public.organization_subscriptions where organization_id=v_org and provider_subscription_id=p_provider_subscription_id for update;
    if v_sub.id is null then raise exception 'Subscription not found'; end if;
  end if;
  if v_sub.status='CANCELLED' then raise exception 'Subscription is cancelled' using errcode='40901'; end if;
  select * into v_plan from public.saas_plans where id=v_sub.plan_id;
  v_amount := coalesce(v_sub.selected_price_snapshot, case when lower(coalesce(v_sub.billing_interval,'month'))='year' then v_plan.price_annual else v_plan.price_monthly end);
  v_start := coalesce(p_provider_period_start,now());
  v_end := coalesce(p_provider_period_end, v_start + case when lower(coalesce(v_sub.billing_interval,'month'))='year' then interval '1 year' else interval '1 month' end);
  update public.organization_subscriptions
  set status='ACTIVE', current_period_start=v_start,current_period_end=v_end,
      billing_period_start_at=v_start,billing_period_end_at=v_end,
      cancellation_requested_at=null,updated_at=now()
  where id=v_sub.id returning * into v_sub;
  insert into public.subscription_billing_events(organization_id,subscription_id,provider_subscription_id,provider_payment_id,event_type,status,amount,currency,payload)
  values(v_org,v_sub.id,p_provider_subscription_id,p_provider_payment_id,'subscription.payment_confirmed','PAID',coalesce(v_amount,0),coalesce(v_plan.currency,'INR'),'{}'::jsonb)
  on conflict do nothing;
  perform public.write_subscription_audit_event(v_org,v_sub.id,'PAYMENT_CONFIRMED',null,jsonb_build_object('status','ACTIVE','billing_interval',v_sub.billing_interval,'amount',v_amount),null);
  return v_sub;
end;
$$;
-- Server-only. Activation must only follow a verified Razorpay signature plus a
-- provider status fetch, both of which happen in /api/subscriptions/verify.
revoke execute on function public.confirm_subscription_payment_v2(text,text,timestamptz,timestamptz) from public, authenticated;
grant execute on function public.confirm_subscription_payment_v2(text,text,timestamptz,timestamptz) to service_role;

create or replace function public.apply_provider_subscription_event(p_provider_subscription_id text,p_event_type text,p_status text,p_provider_plan_id text,p_payment_id text,p_payload jsonb)
returns public.organization_subscriptions
language plpgsql security definer set search_path=public as $$
declare v_sub public.organization_subscriptions; v_plan public.saas_plans; v_status text:=lower(coalesce(p_status,'')); v_interval text;
begin
  -- Server-only. This function trusts its arguments completely and is keyed solely on
  -- a provider subscription id, so any caller that reaches it can rewrite the status,
  -- plan and price of an arbitrary subscription. It must only ever run under the
  -- service role from the verified webhook handler.
  if auth.uid() is not null then
    raise exception 'Provider synchronization is server-only' using errcode='42501';
  end if;
  select * into v_sub from public.organization_subscriptions where provider_subscription_id=p_provider_subscription_id for update;
  if v_sub.id is null then raise exception 'Subscription not found'; end if;
  if v_status in ('active','authenticated') then v_status:='ACTIVE';
  elsif v_status in ('pending','created') then v_status:=v_sub.status;
  elsif v_status in ('cancelled','completed') then v_status:='CANCELLED';
  elsif v_status='expired' then v_status:='EXPIRED';
  elsif v_status in ('past_due','paused') then v_status:='PAST_DUE';
  else v_status:=v_sub.status; end if;
  if p_provider_plan_id is not null then
    select * into v_plan from public.saas_plans where provider_plan_id=p_provider_plan_id or provider_plan_id_annual=p_provider_plan_id limit 1;
    if v_plan.id is not null then
      v_interval := case when v_plan.provider_plan_id_annual=p_provider_plan_id then 'year' else 'month' end;
    end if;
  end if;
  update public.organization_subscriptions
  set status=v_status,
      plan_id=coalesce(v_plan.id,plan_id),
      billing_interval=coalesce(v_interval,billing_interval),
      selected_price_snapshot=case when v_plan.id is not null then case when coalesce(v_interval,billing_interval)='year' then v_plan.price_annual else v_plan.price_monthly end else selected_price_snapshot end,
      price_monthly_snapshot=coalesce(v_plan.price_monthly,price_monthly_snapshot),
      price_annual_snapshot=coalesce(v_plan.price_annual,price_annual_snapshot),
      -- A scheduled change has landed once the provider reports the pending plan and
      -- interval as current. Build 14 dropped this clearing, which left the dashboard
      -- showing "plan change scheduled" permanently after the change had applied.
      pending_plan_id=case when v_plan.id is not null and pending_plan_id=v_plan.id and coalesce(v_interval,billing_interval)=coalesce(pending_billing_interval,billing_interval) then null else pending_plan_id end,
      pending_provider_plan_id=case when v_plan.id is not null and pending_plan_id=v_plan.id and coalesce(v_interval,billing_interval)=coalesce(pending_billing_interval,billing_interval) then null else pending_provider_plan_id end,
      pending_billing_interval=case when v_plan.id is not null and pending_plan_id=v_plan.id and coalesce(v_interval,billing_interval)=coalesce(pending_billing_interval,billing_interval) then null else pending_billing_interval end,
      last_provider_event_id=coalesce(p_payload->>'id',last_provider_event_id),
      current_period_start=coalesce(to_timestamp(nullif(p_payload->'payload'->'subscription'->'entity'->>'current_start','')::bigint),current_period_start),
      current_period_end=coalesce(to_timestamp(nullif(p_payload->'payload'->'subscription'->'entity'->>'current_end','')::bigint),current_period_end),
      cancellation_requested_at=case when v_status='ACTIVE' then null else cancellation_requested_at end,
      updated_at=now()
  where id=v_sub.id returning * into v_sub;
  update public.subscription_billing_events set organization_id=v_sub.organization_id,subscription_id=v_sub.id,provider_payment_id=coalesce(p_payment_id,provider_payment_id),status=v_status,payload=coalesce(p_payload,payload),occurred_at=now() where provider_subscription_id=p_provider_subscription_id and event_type=p_event_type and organization_id is null;
  perform public.write_subscription_audit_event(v_sub.organization_id,v_sub.id,p_event_type,null,jsonb_build_object('status',v_status,'plan_id',v_sub.plan_id,'billing_interval',v_sub.billing_interval),null);
  return v_sub;
end;
$$;
-- Server-only: Build 11 (202609150021) deliberately revoked this from authenticated
-- so clients cannot forge billing events. Build 14 must not re-grant it.
revoke execute on function public.apply_provider_subscription_event(text,text,text,text,text,jsonb) from public, authenticated;
grant execute on function public.apply_provider_subscription_event(text,text,text,text,text,jsonb) to service_role;

create or replace function public.admin_overview()
returns jsonb language plpgsql security definer set search_path=public as $$
declare v jsonb;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'restaurants',(select count(*) from public.organizations),
    'active_restaurants',(select count(*) from public.organizations where status='ACTIVE'),
    'trial_restaurants',(select count(*) from public.organization_subscriptions where status='TRIAL' and trial_ends_at > now()),
    'active_subscriptions',(select count(*) from public.organization_subscriptions where status='ACTIVE'),
    'orders_today',(select count(*) from public.orders where created_at>=date_trunc('day',now())),
    'payments_today',(select coalesce(sum(total),0) from public.orders where payment_status='PAID' and created_at>=date_trunc('day',now())),
    'mrr',(select coalesce(sum(case when lower(coalesce(os.billing_interval,'month'))='year' then coalesce(os.price_annual_snapshot,sp.price_annual,os.price_monthly_snapshot*10,0)/12 else coalesce(os.price_monthly_snapshot,sp.price_monthly,0) end),0) from public.organization_subscriptions os join public.saas_plans sp on sp.id=os.plan_id where os.status='ACTIVE')
  ) into v;
  return v;
end;
$$;
grant execute on function public.admin_overview() to authenticated;

create table if not exists public.subscription_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  subscription_id uuid references public.organization_subscriptions(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  old_state jsonb,
  new_state jsonb,
  provider_event_id text,
  created_at timestamptz not null default now()
);
create index if not exists subscription_audit_events_org_idx on public.subscription_audit_events(organization_id,created_at desc);
alter table public.subscription_audit_events enable row level security;
revoke all on public.subscription_audit_events from anon;

-- -----------------------------------------------------------------------------
-- 11. Billing read authorization
--
-- lib/subscription-access.ts gates every /api/subscriptions/* route behind
-- "OWNER, or staff holding SUBSCRIPTION_MANAGEMENT". The RLS on the underlying
-- tables did not match that: the existing policies used is_org_member(), which is
-- true for ANY active staff row, and the tables carry a matching
-- `grant select ... to authenticated`. A waiter or kitchen user could therefore
-- read the full subscription row directly through PostgREST with the same browser
-- client the app already ships -- provider subscription id, price snapshots,
-- pending plan and interval, cancellation state, billing period dates -- and the
-- API-layer gate would never see the request. Build 14 did not create those
-- policies but it did add most of the columns that now leak through them.
--
-- All billing reads in the app go through SECURITY DEFINER RPCs, which bypass RLS,
-- so tightening these policies does not change any supported code path.
-- -----------------------------------------------------------------------------
create or replace function public.can_view_organization_billing(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_organization_id is not null
    and auth.uid() is not null
    and (
      public.is_platform_admin()
      or public.is_org_owner(p_organization_id)
      or exists (
        select 1
        from public.staff s
        where s.organization_id = p_organization_id
          and s.user_id = auth.uid()
          and s.active = true
          and (
            -- the OWNER staff role is authoritative on its own: since Build 12
            -- separated the restaurant owner, an OWNER staff row need not match
            -- organizations.owner_id.
            s.role = 'OWNER'::public.staff_role
            or exists (
              select 1
              from public.staff_permissions sp
              where sp.staff_id = s.id
                and sp.allowed = true
                and upper(trim(sp.permission)) in ('SUBSCRIPTION_MANAGEMENT','BILLING')
            )
          )
      )
    );
$$;
revoke execute on function public.can_view_organization_billing(uuid) from anon, public;
grant execute on function public.can_view_organization_billing(uuid) to authenticated, service_role;

drop policy if exists subscriptions_select_member on public.organization_subscriptions;
create policy subscriptions_select_member on public.organization_subscriptions
  for select to authenticated
  using (public.can_view_organization_billing(organization_id));

drop policy if exists subscription_billing_events_select_member on public.subscription_billing_events;
create policy subscription_billing_events_select_member on public.subscription_billing_events
  for select to authenticated
  using (public.can_view_organization_billing(organization_id));

drop policy if exists subscription_audit_events_select_member on public.subscription_audit_events;
create policy subscription_audit_events_select_member on public.subscription_audit_events
  for select to authenticated
  using (public.can_view_organization_billing(organization_id));
grant select on public.subscription_audit_events to authenticated;

-- Re-assert the Build 11 hardening (202609150021). Already revoked there; restated
-- here so the posture survives any future migration reordering, and because Build 14
-- runs last.
revoke execute on function public.record_subscription_webhook_event(text, text, text, jsonb) from public, authenticated;
grant execute on function public.record_subscription_webhook_event(text, text, text, jsonb) to service_role;

create or replace function public.write_subscription_audit_event(p_organization_id uuid,p_subscription_id uuid,p_event_type text,p_old_state jsonb default null,p_new_state jsonb default null,p_provider_event_id text default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is not null and not public.is_org_owner(p_organization_id) and not public.is_platform_admin() then raise exception 'Billing audit access required' using errcode='42501'; end if;
  insert into public.subscription_audit_events(organization_id,subscription_id,actor_user_id,event_type,old_state,new_state,provider_event_id)
  values(p_organization_id,p_subscription_id,auth.uid(),trim(p_event_type),p_old_state,p_new_state,p_provider_event_id)
  returning id into v_id;
  return v_id;
end;
$$;
-- Server-only: audit rows must not be forgeable by the actor they describe. The
-- SECURITY DEFINER billing functions call this internally as the function owner.
revoke execute on function public.write_subscription_audit_event(uuid,uuid,text,jsonb,jsonb,text) from public, authenticated;
grant execute on function public.write_subscription_audit_event(uuid,uuid,text,jsonb,jsonb,text) to service_role;


create or replace function public.get_public_plan_catalog_v2()
returns table(id text,name text,description text,price_monthly numeric,price_annual numeric,currency text,trial_days integer,max_staff integer,max_branches integer,max_tables integer,max_menu_items integer,max_monthly_orders integer,features jsonb)
language sql stable security definer set search_path=public as $$
  select p.id,p.name,p.description,p.price_monthly,p.price_annual,p.currency,p.trial_days,p.max_staff,p.max_branches,p.max_tables,p.max_menu_items,p.max_monthly_orders,p.features
  from public.saas_plans p
  where p.active=true
  order by p.price_monthly;
$$;
grant execute on function public.get_public_plan_catalog_v2() to anon,authenticated;


-- Keep platform-admin controls compatible while snapshotting the selected catalog price.
create or replace function public.admin_update_subscription(
  p_organization_id uuid,
  p_plan_id text,
  p_status text,
  p_start_at timestamptz default null,
  p_end_at timestamptz default null
)
returns public.organization_subscriptions
language plpgsql security definer set search_path=public as $$
declare v_row public.organization_subscriptions%rowtype; v_user uuid:=auth.uid(); v_status text:=upper(trim(p_status)); v_plan public.saas_plans;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  select * into v_plan from public.saas_plans where id=p_plan_id and active=true;
  if v_plan.id is null then raise exception 'Invalid plan'; end if;
  if v_status not in ('TRIAL','ACTIVE','PAST_DUE','CANCELLED','SUSPENDED','EXPIRED') then raise exception 'Invalid subscription status'; end if;
  if p_end_at is not null and p_start_at is not null and p_end_at <= p_start_at then raise exception 'End time must be after start time'; end if;
  update public.organization_subscriptions
  set plan_id=p_plan_id,status=v_status,
      trial_started_at=case when v_status='TRIAL' then coalesce(p_start_at,trial_started_at,now()) else trial_started_at end,
      trial_ends_at=case when v_status='TRIAL' then p_end_at else trial_ends_at end,
      current_period_start=case when v_status='ACTIVE' then coalesce(p_start_at,current_period_start,now()) else current_period_start end,
      current_period_end=case when v_status='ACTIVE' then p_end_at else current_period_end end,
      selected_price_snapshot=case when lower(coalesce(billing_interval,'month'))='year' then v_plan.price_annual else v_plan.price_monthly end,
      price_monthly_snapshot=v_plan.price_monthly,price_annual_snapshot=v_plan.price_annual,
      billing_period_start_at=case when v_status='ACTIVE' then coalesce(p_start_at,current_period_start,now()) else billing_period_start_at end,
      billing_period_end_at=case when v_status='ACTIVE' then p_end_at else billing_period_end_at end,
      updated_at=now()
  where organization_id=p_organization_id returning * into v_row;
  if v_row.id is null then
    insert into public.organization_subscriptions(organization_id,plan_id,status,trial_started_at,trial_ends_at,current_period_start,current_period_end,price_monthly_snapshot,price_annual_snapshot,selected_price_snapshot,billing_period_start_at,billing_period_end_at)
    values(p_organization_id,p_plan_id,v_status,case when v_status='TRIAL' then coalesce(p_start_at,now()) end,case when v_status='TRIAL' then p_end_at end,case when v_status='ACTIVE' then coalesce(p_start_at,now()) end,case when v_status='ACTIVE' then p_end_at end,v_plan.price_monthly,v_plan.price_annual,v_plan.price_monthly,case when v_status='ACTIVE' then coalesce(p_start_at,now()) end,case when v_status='ACTIVE' then p_end_at end)
    returning * into v_row;
  end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata) values(v_user,'SUBSCRIPTION_UPDATED','ORGANIZATION',p_organization_id,jsonb_build_object('plan_id',p_plan_id,'status',v_status,'start_at',p_start_at,'end_at',p_end_at));
  return v_row;
end;
$$;
grant execute on function public.admin_update_subscription(uuid,text,text,timestamptz,timestamptz) to authenticated;

COMMIT;
