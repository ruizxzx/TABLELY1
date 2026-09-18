-- Subscription catalog and history RPCs used by the billing screens.
create or replace function public.get_active_plan_catalog()
returns table (
  id text,
  name text,
  price_monthly numeric,
  currency text,
  trial_days integer,
  active boolean,
  features jsonb,
  max_staff integer,
  max_branches integer,
  provider_plan_id text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.name,
    p.price_monthly,
    'INR'::text,
    p.trial_days,
    p.active,
    p.features,
    case when p.features->>'max_staff' is null then null else (p.features->>'max_staff')::integer end,
    case when p.features->>'max_branches' is null then null else (p.features->>'max_branches')::integer end,
    null::text
  from public.saas_plans p
  where p.active = true
  order by p.price_monthly;
$$;

grant execute on function public.get_active_plan_catalog() to authenticated;

create or replace function public.admin_list_plans()
returns table (
  id text,
  name text,
  description text,
  price_monthly numeric,
  currency text,
  trial_days integer,
  active boolean,
  features jsonb,
  provider_plan_id text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    p.id,
    p.name,
    null::text,
    p.price_monthly,
    'INR'::text,
    p.trial_days,
    p.active,
    p.features,
    null::text
  from public.saas_plans p
  where public.is_platform_admin()
  order by p.price_monthly;
$$;

grant execute on function public.admin_list_plans() to authenticated;

create or replace function public.get_subscription_payment_history()
returns table (
  id uuid,
  provider_payment_id text,
  amount numeric,
  currency text,
  status text,
  paid_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    null::uuid,
    null::text,
    0::numeric,
    'INR'::text,
    'PENDING'::text,
    null::timestamptz,
    now()
  where false;
$$;

grant execute on function public.get_subscription_payment_history() to authenticated;
