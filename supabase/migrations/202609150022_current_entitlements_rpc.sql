-- Entitlement payload consumed by the authenticated StudioShell navigation.
create or replace function public.get_current_entitlements()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_plan public.saas_plans;
  v_sub public.organization_subscriptions;
  v_features jsonb;
begin
  select s.organization_id into v_org
  from public.staff s
  where s.user_id = auth.uid() and s.active = true
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;
  if v_org is null then return null; end if;

  select * into v_sub from public.organization_subscriptions where organization_id = v_org;
  if v_sub.id is null then return null; end if;
  select * into v_plan from public.saas_plans where id = v_sub.plan_id;
  if v_plan.id is null then return null; end if;

  v_features := case
    when v_sub.status in ('TRIAL', 'ACTIVE') and (v_sub.status <> 'TRIAL' or v_sub.trial_ends_at > now()) then v_plan.features
    else '{}'::jsonb
  end;

  return jsonb_build_object(
    'organization_id', v_org,
    'plan_id', v_plan.id,
    'plan_name', v_plan.name,
    'price_monthly', v_sub.price_monthly_snapshot,
    'currency', v_sub.currency,
    'status', case when v_sub.status = 'TRIAL' and v_sub.trial_ends_at <= now() then 'EXPIRED' else v_sub.status end,
    'trial_ends_at', v_sub.trial_ends_at,
    'current_period_end', v_sub.current_period_end,
    'features', v_features,
    'limits', jsonb_build_object(
      'max_staff', nullif(v_plan.features->>'max_staff', '')::integer,
      'max_branches', nullif(v_plan.features->>'max_branches', '')::integer
    )
  );
end;
$$;

grant execute on function public.get_current_entitlements() to authenticated;
