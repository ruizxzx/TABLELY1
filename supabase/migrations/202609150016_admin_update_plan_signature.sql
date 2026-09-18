-- Compatibility overload for the admin page's six-parameter RPC call.
create or replace function public.admin_update_plan(
  p_active boolean,
  p_description text,
  p_features jsonb,
  p_plan_id text,
  p_price_monthly numeric,
  p_trial_days integer
)
returns public.saas_plans
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan public.saas_plans;
  v_features jsonb := coalesce(p_features, '{}'::jsonb);
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
  if p_price_monthly is null or p_price_monthly < 0 then
    raise exception 'Monthly price must be zero or greater';
  end if;
  if p_trial_days is null or p_trial_days < 0 or p_trial_days > 90 then
    raise exception 'Trial days must be between 0 and 90';
  end if;

  update public.saas_plans
  set price_monthly = p_price_monthly,
      trial_days = p_trial_days,
      active = coalesce(p_active, true),
      features = v_features
  where id = p_plan_id
  returning * into v_plan;

  if v_plan.id is null then
    raise exception 'Plan not found';
  end if;
  return v_plan;
end;
$$;

grant execute on function public.admin_update_plan(boolean, text, jsonb, text, numeric, integer) to authenticated;
