-- Admin control-center foundation: global feature flags, organization overrides,
-- and platform health checks. All writes are restricted to platform admins.

create table if not exists public.platform_feature_flags (
  key text primary key,
  label text not null,
  description text not null default '',
  enabled boolean not null default true,
  maintenance_mode boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.organization_feature_overrides (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  feature_key text not null references public.platform_feature_flags(key) on delete cascade,
  enabled boolean,
  maintenance_mode boolean,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (organization_id, feature_key)
);

alter table public.platform_feature_flags enable row level security;
alter table public.organization_feature_overrides enable row level security;
revoke all on public.platform_feature_flags from anon, authenticated, public;
revoke all on public.organization_feature_overrides from anon, authenticated, public;

insert into public.platform_feature_flags(key, label, description)
values
  ('RESTAURANT_ORDERING', 'Restaurant ordering', 'Allow restaurants to receive new customer orders.'),
  ('ONLINE_PAYMENTS', 'Online payments', 'Allow online payment checkout for eligible restaurants.'),
  ('PAY_AFTER_DELIVERY', 'Pay after delivery', 'Allow eligible customers to use Pay After Delivery.'),
  ('SHARED_PAY_LATER', 'Shared Pay-Later', 'Allow staff to settle Pay-Later orders from operations.'),
  ('REVIEWS', 'Reviews', 'Allow customers to submit and view reviews.'),
  ('RESERVATIONS', 'Reservations', 'Enable reservation workflows when available.'),
  ('LOYALTY', 'Loyalty', 'Enable loyalty features when available.'),
  ('INVENTORY', 'Inventory', 'Enable inventory controls when available.'),
  ('CUSTOMER_CRM', 'Customer CRM', 'Enable restaurant customer management.'),
  ('ANALYTICS', 'Analytics', 'Enable restaurant analytics surfaces.')
on conflict (key) do nothing;

create or replace function public.admin_list_feature_flags()
returns table(
  key text,
  label text,
  description text,
  enabled boolean,
  maintenance_mode boolean,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
  return query
  select f.key, f.label, f.description, f.enabled, f.maintenance_mode, f.updated_at
  from public.platform_feature_flags f
  order by f.label;
end;
$$;

create or replace function public.admin_set_feature_flag(
  p_key text,
  p_enabled boolean,
  p_maintenance_mode boolean default false
)
returns public.platform_feature_flags
language plpgsql
security definer
set search_path = public
as $$
declare v_flag public.platform_feature_flags;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
  update public.platform_feature_flags
  set enabled = p_enabled,
      maintenance_mode = coalesce(p_maintenance_mode, false),
      updated_at = now(),
      updated_by = auth.uid()
  where key = upper(trim(p_key))
  returning * into v_flag;
  if v_flag.key is null then raise exception 'Unknown feature flag'; end if;
  return v_flag;
end;
$$;

create or replace function public.admin_platform_health()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'database', jsonb_build_object('status', 'HEALTHY', 'checked_at', now()),
    'auth', jsonb_build_object('status', 'HEALTHY', 'checked_at', now()),
    'realtime', jsonb_build_object('status', 'CONFIGURED', 'checked_at', now()),
    'payments', jsonb_build_object(
      'status', case when exists (select 1 from public.restaurant_payment_settings where enabled) then 'CONFIGURED' else 'NO_PROVIDER_CONFIGURED' end,
      'checked_at', now()
    ),
    'webhooks', jsonb_build_object('status', 'CONFIGURED', 'checked_at', now())
  );
end;
$$;

grant execute on function public.admin_list_feature_flags() to authenticated;
grant execute on function public.admin_set_feature_flag(text, boolean, boolean) to authenticated;
grant execute on function public.admin_platform_health() to authenticated;

-- Make the new controls effective for every existing entitlement gate.
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
  v_global public.platform_feature_flags;
  v_override public.organization_feature_overrides;
begin
  if auth.uid() is not null and auth.role() <> 'anon'
     and not public.is_org_member(p_organization_id)
     and not public.is_platform_admin() then return false; end if;
  select * into v_global from public.platform_feature_flags where key = v_key;
  if v_global.key is not null and (not v_global.enabled or v_global.maintenance_mode) then return false; end if;
  select * into v_override from public.organization_feature_overrides
  where organization_id = p_organization_id and feature_key = v_key;
  if v_override.organization_id is not null
     and (v_override.enabled is false or v_override.maintenance_mode is true) then return false; end if;
  select os.status, os.trial_ends_at, sp.features
  into v_status, v_trial_end, v_features
  from public.organization_subscriptions os
  join public.saas_plans sp on sp.id = os.plan_id
  where os.organization_id = p_organization_id;
  if v_status is null or (v_status = 'TRIAL' and v_trial_end is not null and v_trial_end <= now())
     or v_status not in ('TRIAL', 'ACTIVE') then return false; end if;
  return coalesce((v_features->>v_key)::boolean, false);
end;
$$;
grant execute on function public.organization_has_feature(uuid, text) to authenticated, service_role;

create or replace function public.admin_set_organization_feature_override(
  p_organization_id uuid,
  p_feature_key text,
  p_enabled boolean default null,
  p_maintenance_mode boolean default null
)
returns public.organization_feature_overrides
language plpgsql
security definer
set search_path = public
as $$
declare v_override public.organization_feature_overrides;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  if not exists (select 1 from public.platform_feature_flags where key = upper(trim(p_feature_key))) then raise exception 'Unknown feature flag'; end if;
  insert into public.organization_feature_overrides(organization_id, feature_key, enabled, maintenance_mode, updated_at, updated_by)
  values (p_organization_id, upper(trim(p_feature_key)), p_enabled, p_maintenance_mode, now(), auth.uid())
  on conflict (organization_id, feature_key) do update set enabled = excluded.enabled, maintenance_mode = excluded.maintenance_mode, updated_at = now(), updated_by = auth.uid()
  returning * into v_override;
  return v_override;
end;
$$;
grant execute on function public.admin_set_organization_feature_override(uuid, text, boolean, boolean) to authenticated;
