-- Qualify admin invite cleanup columns to avoid collision with RETURNS TABLE status.
create or replace function public.admin_list_subscription_invites()
returns table(
  id uuid,
  email text,
  plan_id text,
  status text,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz,
  redeemed_at timestamptz,
  redeemed_organization_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;

  update public.admin_subscription_invites as i
  set status = 'EXPIRED', updated_at = now()
  where i.status = 'PENDING'
    and i.ends_at <= now();

  return query
  select i.id, i.email, i.plan_id, i.status, i.starts_at, i.ends_at,
         i.created_at, i.redeemed_at, i.redeemed_organization_id
  from public.admin_subscription_invites as i
  order by i.created_at desc;
end;
$$;

grant execute on function public.admin_list_subscription_invites() to authenticated;
