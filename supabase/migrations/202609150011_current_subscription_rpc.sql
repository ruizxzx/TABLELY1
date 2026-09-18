-- Return the authenticated user's current organization subscription.
create or replace function public.get_current_subscription()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_organization_id uuid;
  v_subscription jsonb;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select s.organization_id
  into v_organization_id
  from public.staff s
  where s.user_id = v_user
    and s.active = true
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;

  if v_organization_id is null then
    return null;
  end if;

  select jsonb_build_object(
    'id', os.id,
    'organization_id', os.organization_id,
    'plan_id', os.plan_id,
    'status', os.status,
    'trial_started_at', os.trial_started_at,
    'trial_ends_at', os.trial_ends_at,
    'current_period_start', os.current_period_start,
    'current_period_end', os.current_period_end,
    'provider', os.provider,
    'provider_customer_id', os.provider_customer_id,
    'provider_subscription_id', os.provider_subscription_id,
    'created_at', os.created_at,
    'updated_at', os.updated_at,
    'price_monthly', sp.price_monthly,
    'currency', 'INR'
  )
  into v_subscription
  from public.organization_subscriptions os
  left join public.saas_plans sp on sp.id = os.plan_id
  where os.organization_id = v_organization_id;

  return v_subscription;
end;
$$;

grant execute on function public.get_current_subscription() to authenticated;
