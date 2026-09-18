-- Platform-wide operations, security, webhook, maintenance and settings controls.

create table if not exists public.platform_system_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  description text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.platform_system_settings enable row level security;
revoke all on public.platform_system_settings from anon, authenticated, public;

insert into public.platform_system_settings(key, value, description)
values
  ('maintenance_mode', '{"enabled": false, "message": ""}'::jsonb, 'Global maintenance banner and ordering lock.'),
  ('content', '{"support_email": "", "privacy_url": "/privacy", "terms_url": "/terms"}'::jsonb, 'Public platform content and support links.'),
  ('order_policy', '{"allow_guest_checkout": true, "default_order_timeout_minutes": 30}'::jsonb, 'Global ordering policy defaults.')
on conflict (key) do nothing;

create or replace function public.admin_operations_overview()
returns jsonb
language plpgsql security definer stable set search_path = public
as $$
declare v_result jsonb;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  select jsonb_build_object(
    'orders_today', (select count(*) from public.orders where created_at >= date_trunc('day', now())),
    'orders_open', (select count(*) from public.orders where status in ('NEW','ACCEPTED','PREPARING','READY','SERVED')),
    'orders_completed_today', (select count(*) from public.orders where status='COMPLETED' and created_at >= date_trunc('day', now())),
    'revenue_today', (select coalesce(sum(total) filter (where payment_status='PAID'),0) from public.orders where created_at >= date_trunc('day', now())),
    'payments_today', (select count(*) from public.payment_transactions where created_at >= date_trunc('day', now())),
    'customers', (select count(*) from public.customer_profiles),
    'active_restaurants', (select count(*) from public.organizations where status='ACTIVE'),
    'open_support', (select count(*) from public.service_requests where status in ('OPEN','ACKNOWLEDGED')),
    'failed_payments', (select count(*) from public.payment_transactions where status in ('FAILED','FAILURE') and created_at >= now()-interval '24 hours'),
    'webhook_events_24h', (select count(*) from public.subscription_billing_events where occurred_at >= now()-interval '24 hours'),
    'maintenance', coalesce((select value from public.platform_system_settings where key='maintenance_mode'),'{"enabled":false}'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.admin_list_orders(p_limit integer default 250)
returns table(id uuid, order_number bigint, organization_name text, branch_id uuid, status text, payment_status text, payment_method text, total numeric, created_at timestamptz)
language plpgsql security definer stable set search_path=public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select o.id,o.order_number,org.name,o.branch_id,o.status::text,o.payment_status::text,o.payment_method,o.total,o.created_at
  from public.orders o join public.branches b on b.id=o.branch_id join public.organizations org on org.id=b.organization_id
  order by o.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000));
end;
$$;

create or replace function public.admin_list_payments(p_limit integer default 250)
returns table(id uuid, order_id uuid, organization_name text, provider text, provider_payment_id text, amount numeric, currency text, status text, method text, created_at timestamptz)
language plpgsql security definer stable set search_path=public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select p.id,p.order_id,org.name,p.provider,p.provider_payment_id,p.amount,p.currency,p.status,p.method,p.created_at
  from public.payment_transactions p join public.branches b on b.id=p.branch_id join public.organizations org on org.id=b.organization_id
  order by p.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000));
end;
$$;

create or replace function public.admin_list_customers(p_limit integer default 250)
returns table(id uuid, name text, email text, phone text, created_at timestamptz, order_count bigint, lifetime_value numeric)
language plpgsql security definer stable set search_path=public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select c.id,c.name,c.email,c.phone,c.created_at,count(o.id),coalesce(sum(o.total) filter (where o.payment_status='PAID'),0)
  from public.customer_profiles c left join public.orders o on o.customer_profile_id=c.id
  group by c.id order by c.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000));
end;
$$;

create or replace function public.admin_list_support(p_limit integer default 250)
returns table(id uuid, organization_name text, branch_id uuid, type text, status text, note text, created_at timestamptz)
language plpgsql security definer stable set search_path=public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select r.id,org.name,r.branch_id,r.type,r.status,r.note,r.created_at
  from public.service_requests r join public.branches b on b.id=r.branch_id join public.organizations org on org.id=b.organization_id
  order by r.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000));
end;
$$;

create or replace function public.admin_list_security_events(p_limit integer default 250)
returns table(id uuid, actor_user_id uuid, action text, entity_type text, entity_id uuid, metadata jsonb, created_at timestamptz)
language plpgsql security definer stable set search_path=public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select a.id,a.actor_user_id,a.action,a.entity_type,a.entity_id,a.metadata,a.created_at
  from public.admin_audit_logs a order by a.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000));
end;
$$;

create or replace function public.admin_list_webhook_events(p_limit integer default 250)
returns table(id uuid, organization_id uuid, organization_name text, provider_event_id text, event_type text, status text, amount numeric, currency text, occurred_at timestamptz, payload jsonb)
language plpgsql security definer stable set search_path=public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select e.id,e.organization_id,o.name,e.provider_event_id,e.event_type,e.status,e.amount,e.currency,e.occurred_at,e.payload
  from public.subscription_billing_events e left join public.organizations o on o.id=e.organization_id
  order by e.occurred_at desc limit greatest(1,least(coalesce(p_limit,250),1000));
end;
$$;

create or replace function public.admin_list_system_settings()
returns table(key text, value jsonb, description text, updated_at timestamptz)
language plpgsql security definer stable set search_path=public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select s.key,s.value,s.description,s.updated_at from public.platform_system_settings s order by s.key;
end;
$$;

create or replace function public.admin_update_system_setting(p_key text, p_value jsonb)
returns public.platform_system_settings
language plpgsql security definer set search_path=public
as $$
declare v_setting public.platform_system_settings;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  update public.platform_system_settings set value=coalesce(p_value,'{}'::jsonb),updated_at=now(),updated_by=auth.uid() where key=trim(p_key) returning * into v_setting;
  if v_setting.key is null then raise exception 'Unknown system setting'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,metadata) values(auth.uid(),'SYSTEM_SETTING_UPDATED','SYSTEM_SETTING',jsonb_build_object('key',p_key));
  return v_setting;
end;
$$;

create or replace function public.admin_set_maintenance(p_enabled boolean, p_message text default '')
returns public.platform_system_settings
language plpgsql security definer set search_path=public
as $$
begin
  return public.admin_update_system_setting('maintenance_mode',jsonb_build_object('enabled',coalesce(p_enabled,false),'message',left(coalesce(p_message,''),500)));
end;
$$;

grant execute on function public.admin_operations_overview() to authenticated;
grant execute on function public.admin_list_orders(integer) to authenticated;
grant execute on function public.admin_list_payments(integer) to authenticated;
grant execute on function public.admin_list_customers(integer) to authenticated;
grant execute on function public.admin_list_support(integer) to authenticated;
grant execute on function public.admin_list_security_events(integer) to authenticated;
grant execute on function public.admin_list_webhook_events(integer) to authenticated;
grant execute on function public.admin_list_system_settings() to authenticated;
grant execute on function public.admin_update_system_setting(text,jsonb) to authenticated;
grant execute on function public.admin_set_maintenance(boolean,text) to authenticated;
