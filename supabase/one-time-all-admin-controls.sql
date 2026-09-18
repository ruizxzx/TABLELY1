-- TABLELY � ALL ADMIN CONTROLS + FEEDBACK � ONE-TIME SQL BUNDLE
-- Run this entire file once in the Supabase SQL Editor.
-- Includes feature controls, billing, operations, security, system settings, and feedback reports.

-- ============================================================
-- Included: one-time-admin-control-center-foundation.sql
-- ============================================================
-- Run this once in Supabase SQL Editor.
-- Equivalent to migration 202609180026_admin_control_center_foundation.sql.

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
returns table(key text, label text, description text, enabled boolean, maintenance_mode boolean, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  return query select f.key, f.label, f.description, f.enabled, f.maintenance_mode, f.updated_at from public.platform_feature_flags f order by f.label;
end;
$$;

create or replace function public.admin_set_feature_flag(p_key text, p_enabled boolean, p_maintenance_mode boolean default false)
returns public.platform_feature_flags
language plpgsql security definer set search_path = public as $$
declare v_flag public.platform_feature_flags;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  update public.platform_feature_flags set enabled = p_enabled, maintenance_mode = coalesce(p_maintenance_mode, false), updated_at = now(), updated_by = auth.uid()
  where key = upper(trim(p_key)) returning * into v_flag;
  if v_flag.key is null then raise exception 'Unknown feature flag'; end if;
  return v_flag;
end;
$$;

create or replace function public.admin_platform_health()
returns jsonb
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'database', jsonb_build_object('status', 'HEALTHY', 'checked_at', now()),
    'auth', jsonb_build_object('status', 'HEALTHY', 'checked_at', now()),
    'realtime', jsonb_build_object('status', 'CONFIGURED', 'checked_at', now()),
    'payments', jsonb_build_object('status', case when exists (select 1 from public.restaurant_payment_settings where enabled) then 'CONFIGURED' else 'NO_PROVIDER_CONFIGURED' end, 'checked_at', now()),
    'webhooks', jsonb_build_object('status', 'CONFIGURED', 'checked_at', now())
  );
end;
$$;

grant execute on function public.admin_list_feature_flags() to authenticated;
grant execute on function public.admin_set_feature_flag(text, boolean, boolean) to authenticated;
grant execute on function public.admin_platform_health() to authenticated;

create or replace function public.organization_has_feature(p_organization_id uuid, p_feature text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_features jsonb; v_status text; v_trial_end timestamptz; v_key text := upper(trim(coalesce(p_feature, ''))); v_global public.platform_feature_flags; v_override public.organization_feature_overrides;
begin
  if auth.uid() is not null and auth.role() <> 'anon' and not public.is_org_member(p_organization_id) and not public.is_platform_admin() then return false; end if;
  select * into v_global from public.platform_feature_flags where key = v_key;
  if v_global.key is not null and (not v_global.enabled or v_global.maintenance_mode) then return false; end if;
  select * into v_override from public.organization_feature_overrides where organization_id = p_organization_id and feature_key = v_key;
  if v_override.organization_id is not null and (v_override.enabled is false or v_override.maintenance_mode is true) then return false; end if;
  select os.status, os.trial_ends_at, sp.features into v_status, v_trial_end, v_features from public.organization_subscriptions os join public.saas_plans sp on sp.id = os.plan_id where os.organization_id = p_organization_id;
  if v_status is null or (v_status = 'TRIAL' and v_trial_end is not null and v_trial_end <= now()) or v_status not in ('TRIAL', 'ACTIVE') then return false; end if;
  return coalesce((v_features->>v_key)::boolean, false);
end;
$$;
grant execute on function public.organization_has_feature(uuid, text) to authenticated, service_role;

create or replace function public.admin_set_organization_feature_override(p_organization_id uuid, p_feature_key text, p_enabled boolean default null, p_maintenance_mode boolean default null)
returns public.organization_feature_overrides language plpgsql security definer set search_path = public as $$
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

-- ============================================================
-- Included: one-time-admin-billing-controls.sql
-- ============================================================
-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180027_admin_billing_controls.sql.

create or replace function public.admin_list_billing_events(p_limit integer default 200)
returns table(id uuid, organization_id uuid, organization_name text, subscription_id uuid, provider_event_id text, provider_subscription_id text, provider_payment_id text, event_type text, status text, amount numeric, currency text, occurred_at timestamptz, payload jsonb)
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  return query select e.id,e.organization_id,o.name,e.subscription_id,e.provider_event_id,e.provider_subscription_id,e.provider_payment_id,e.event_type,e.status,e.amount,e.currency,e.occurred_at,e.payload from public.subscription_billing_events e left join public.organizations o on o.id=e.organization_id order by e.occurred_at desc limit greatest(1,least(coalesce(p_limit,200),500));
end;
$$;

create or replace function public.admin_list_invoices(p_limit integer default 200)
returns table(id uuid, organization_id uuid, organization_name text, provider_payment_id text, provider_subscription_id text, status text, amount numeric, currency text, issued_at timestamptz, event_type text)
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  return query select e.id,e.organization_id,o.name,e.provider_payment_id,e.provider_subscription_id,e.status,e.amount,e.currency,e.occurred_at,e.event_type from public.subscription_billing_events e left join public.organizations o on o.id=e.organization_id where lower(e.event_type) like '%invoice%' or lower(e.event_type) like '%payment%' order by e.occurred_at desc limit greatest(1,least(coalesce(p_limit,200),500));
end;
$$;

create or replace function public.admin_list_coupons(p_limit integer default 500)
returns table(id uuid, organization_id uuid, organization_name text, branch_id uuid, code text, title text, discount_type text, discount_value numeric, is_active boolean, starts_at timestamptz, ends_at timestamptz, usage_limit_total integer, usage_count bigint, updated_at timestamptz)
language plpgsql security definer stable set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  return query select c.id,c.organization_id,o.name,c.branch_id,c.code,c.title,c.discount_type,c.discount_value,c.is_active,c.starts_at,c.ends_at,c.usage_limit_total,count(u.id),c.updated_at from public.coupons c join public.organizations o on o.id=c.organization_id left join public.coupon_usages u on u.coupon_id=c.id group by c.id,o.name order by c.updated_at desc limit greatest(1,least(coalesce(p_limit,500),1000));
end;
$$;

create or replace function public.admin_set_coupon_status(p_coupon_id uuid,p_is_active boolean)
returns public.coupons language plpgsql security definer set search_path = public as $$
declare v_coupon public.coupons;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  update public.coupons set is_active=p_is_active,updated_at=now() where id=p_coupon_id returning * into v_coupon;
  if v_coupon.id is null then raise exception 'Coupon not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata) values(auth.uid(),case when p_is_active then 'COUPON_ENABLED' else 'COUPON_DISABLED' end,'COUPON',p_coupon_id,jsonb_build_object('is_active',p_is_active));
  return v_coupon;
end;
$$;

create or replace function public.admin_delete_coupon(p_coupon_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  if not exists(select 1 from public.coupons where id=p_coupon_id) then raise exception 'Coupon not found'; end if;
  delete from public.coupons where id=p_coupon_id;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id) values(auth.uid(),'COUPON_DELETED','COUPON',p_coupon_id);
end;
$$;

grant execute on function public.admin_list_billing_events(integer) to authenticated;
grant execute on function public.admin_list_invoices(integer) to authenticated;
grant execute on function public.admin_list_coupons(integer) to authenticated;
grant execute on function public.admin_set_coupon_status(uuid,boolean) to authenticated;
grant execute on function public.admin_delete_coupon(uuid) to authenticated;

-- ============================================================
-- Included: one-time-admin-operations-system-controls.sql
-- ============================================================
-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180028_admin_operations_system_controls.sql.

create table if not exists public.platform_system_settings(key text primary key,value jsonb not null default '{}'::jsonb,description text not null default '',updated_at timestamptz not null default now(),updated_by uuid references auth.users(id));
alter table public.platform_system_settings enable row level security;
revoke all on public.platform_system_settings from anon, authenticated, public;
insert into public.platform_system_settings(key,value,description) values
('maintenance_mode','{"enabled":false,"message":""}'::jsonb,'Global maintenance banner and ordering lock.'),
('content','{"support_email":"","privacy_url":"/privacy","terms_url":"/terms"}'::jsonb,'Public platform content and support links.'),
('order_policy','{"allow_guest_checkout":true,"default_order_timeout_minutes":30}'::jsonb,'Global ordering policy defaults.')
on conflict(key) do nothing;

create or replace function public.admin_operations_overview() returns jsonb language plpgsql security definer stable set search_path=public as $$
begin
if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
return jsonb_build_object('orders_today',(select count(*) from public.orders where created_at>=date_trunc('day',now())),'orders_open',(select count(*) from public.orders where status in('NEW','ACCEPTED','PREPARING','READY','SERVED')),'orders_completed_today',(select count(*) from public.orders where status='COMPLETED' and created_at>=date_trunc('day',now())),'revenue_today',(select coalesce(sum(total) filter(where payment_status='PAID'),0) from public.orders where created_at>=date_trunc('day',now())),'payments_today',(select count(*) from public.payment_transactions where created_at>=date_trunc('day',now())),'customers',(select count(*) from public.customer_profiles),'active_restaurants',(select count(*) from public.organizations where status='ACTIVE'),'open_support',(select count(*) from public.service_requests where status in('OPEN','ACKNOWLEDGED')),'failed_payments',(select count(*) from public.payment_transactions where status in('FAILED','FAILURE') and created_at>=now()-interval '24 hours'),'webhook_events_24h',(select count(*) from public.subscription_billing_events where occurred_at>=now()-interval '24 hours'),'maintenance',coalesce((select value from public.platform_system_settings where key='maintenance_mode'),'{"enabled":false}'::jsonb));
end; $$;

create or replace function public.admin_list_orders(p_limit integer default 250) returns table(id uuid,order_number bigint,organization_name text,branch_id uuid,status text,payment_status text,payment_method text,total numeric,created_at timestamptz) language plpgsql security definer stable set search_path=public as $$ begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; return query select o.id,o.order_number,org.name,o.branch_id,o.status::text,o.payment_status::text,o.payment_method,o.total,o.created_at from public.orders o join public.branches b on b.id=o.branch_id join public.organizations org on org.id=b.organization_id order by o.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000)); end; $$;
create or replace function public.admin_list_payments(p_limit integer default 250) returns table(id uuid,order_id uuid,organization_name text,provider text,provider_payment_id text,amount numeric,currency text,status text,method text,created_at timestamptz) language plpgsql security definer stable set search_path=public as $$ begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; return query select p.id,p.order_id,org.name,p.provider,p.provider_payment_id,p.amount,p.currency,p.status,p.method,p.created_at from public.payment_transactions p join public.branches b on b.id=p.branch_id join public.organizations org on org.id=b.organization_id order by p.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000)); end; $$;
create or replace function public.admin_list_customers(p_limit integer default 250) returns table(id uuid,name text,email text,phone text,created_at timestamptz,order_count bigint,lifetime_value numeric) language plpgsql security definer stable set search_path=public as $$ begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; return query select c.id,c.name,c.email,c.phone,c.created_at,count(o.id),coalesce(sum(o.total) filter(where o.payment_status='PAID'),0) from public.customer_profiles c left join public.orders o on o.customer_profile_id=c.id group by c.id order by c.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000)); end; $$;
create or replace function public.admin_list_support(p_limit integer default 250) returns table(id uuid,organization_name text,branch_id uuid,type text,status text,note text,created_at timestamptz) language plpgsql security definer stable set search_path=public as $$ begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; return query select r.id,org.name,r.branch_id,r.type,r.status,r.note,r.created_at from public.service_requests r join public.branches b on b.id=r.branch_id join public.organizations org on org.id=b.organization_id order by r.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000)); end; $$;
create or replace function public.admin_list_security_events(p_limit integer default 250) returns table(id uuid,actor_user_id uuid,action text,entity_type text,entity_id uuid,metadata jsonb,created_at timestamptz) language plpgsql security definer stable set search_path=public as $$ begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; return query select a.id,a.actor_user_id,a.action,a.entity_type,a.entity_id,a.metadata,a.created_at from public.admin_audit_logs a order by a.created_at desc limit greatest(1,least(coalesce(p_limit,250),1000)); end; $$;
create or replace function public.admin_list_webhook_events(p_limit integer default 250) returns table(id uuid,organization_id uuid,organization_name text,provider_event_id text,event_type text,status text,amount numeric,currency text,occurred_at timestamptz,payload jsonb) language plpgsql security definer stable set search_path=public as $$ begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; return query select e.id,e.organization_id,o.name,e.provider_event_id,e.event_type,e.status,e.amount,e.currency,e.occurred_at,e.payload from public.subscription_billing_events e left join public.organizations o on o.id=e.organization_id order by e.occurred_at desc limit greatest(1,least(coalesce(p_limit,250),1000)); end; $$;
create or replace function public.admin_list_system_settings() returns table(key text,value jsonb,description text,updated_at timestamptz) language plpgsql security definer stable set search_path=public as $$ begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; return query select s.key,s.value,s.description,s.updated_at from public.platform_system_settings s order by s.key; end; $$;
create or replace function public.admin_update_system_setting(p_key text,p_value jsonb) returns public.platform_system_settings language plpgsql security definer set search_path=public as $$ declare v public.platform_system_settings; begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; update public.platform_system_settings set value=coalesce(p_value,'{}'::jsonb),updated_at=now(),updated_by=auth.uid() where key=trim(p_key) returning * into v; if v.key is null then raise exception 'Unknown system setting'; end if; insert into public.admin_audit_logs(actor_user_id,action,entity_type,metadata) values(auth.uid(),'SYSTEM_SETTING_UPDATED','SYSTEM_SETTING',jsonb_build_object('key',p_key)); return v; end; $$;
create or replace function public.admin_set_maintenance(p_enabled boolean,p_message text default '') returns public.platform_system_settings language plpgsql security definer set search_path=public as $$ begin return public.admin_update_system_setting('maintenance_mode',jsonb_build_object('enabled',coalesce(p_enabled,false),'message',left(coalesce(p_message,''),500))); end; $$;
grant execute on function public.admin_operations_overview() to authenticated; grant execute on function public.admin_list_orders(integer) to authenticated; grant execute on function public.admin_list_payments(integer) to authenticated; grant execute on function public.admin_list_customers(integer) to authenticated; grant execute on function public.admin_list_support(integer) to authenticated; grant execute on function public.admin_list_security_events(integer) to authenticated; grant execute on function public.admin_list_webhook_events(integer) to authenticated; grant execute on function public.admin_list_system_settings() to authenticated; grant execute on function public.admin_update_system_setting(text,jsonb) to authenticated; grant execute on function public.admin_set_maintenance(boolean,text) to authenticated;

-- ============================================================
-- Included: one-time-feedback-reports.sql
-- ============================================================
-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180029_feedback_reports.sql.

create table if not exists public.feedback_reports (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete set null, table_id uuid references public.tables(id) on delete set null,
  reporter_user_id uuid references auth.users(id) on delete set null, reporter_name text, reporter_email text,
  source text not null check (source in ('RESTAURANT','CUSTOMER')), category text not null check (category in ('BUG','IDEA','SUPPORT','OTHER')),
  subject text not null check (char_length(trim(subject)) between 3 and 160), description text not null check (char_length(trim(description)) between 5 and 4000),
  status text not null default 'OPEN' check (status in ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')), admin_note text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists feedback_reports_status_created_idx on public.feedback_reports(status,created_at desc);
create index if not exists feedback_reports_org_created_idx on public.feedback_reports(organization_id,created_at desc);
alter table public.feedback_reports enable row level security;
revoke all on public.feedback_reports from anon,authenticated,public;

create or replace function public.submit_customer_feedback(p_table_code text,p_category text,p_subject text,p_description text,p_reporter_name text default null,p_reporter_email text default null)
returns public.feedback_reports language plpgsql security definer set search_path=public as $$
declare v_table public.tables; v_report public.feedback_reports; v_category text:=upper(trim(coalesce(p_category,'OTHER')));
begin
  select t.* into v_table from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id where t.table_code=trim(coalesce(p_table_code,'')) and t.active and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if v_category not in('BUG','IDEA','SUPPORT','OTHER') then raise exception 'Invalid feedback category'; end if;
  insert into public.feedback_reports(organization_id,branch_id,table_id,reporter_user_id,reporter_name,reporter_email,source,category,subject,description)
  select b.organization_id,v_table.branch_id,v_table.id,auth.uid(),nullif(left(trim(coalesce(p_reporter_name,'')),120),''),nullif(left(trim(coalesce(p_reporter_email,'')),200),''),'CUSTOMER',v_category,left(trim(p_subject),160),left(trim(p_description),4000) from public.branches b where b.id=v_table.branch_id returning * into v_report;
  return v_report;
end; $$;

create or replace function public.submit_restaurant_feedback(p_category text,p_subject text,p_description text)
returns public.feedback_reports language plpgsql security definer set search_path=public as $$
declare v_staff public.staff%rowtype; v_org uuid; v_report public.feedback_reports; v_category text:=upper(trim(coalesce(p_category,'OTHER')));
begin
  select s.* into v_staff from public.staff s where s.user_id=auth.uid() and s.active order by case when s.role='OWNER' then 0 else 1 end,s.created_at limit 1;
  if v_staff.id is null then raise exception 'Restaurant workspace not found'; end if;
  select s.organization_id into v_org from public.staff s where s.id=v_staff.id;
  if v_category not in('BUG','IDEA','SUPPORT','OTHER') then raise exception 'Invalid feedback category'; end if;
  insert into public.feedback_reports(organization_id,branch_id,reporter_user_id,reporter_name,reporter_email,source,category,subject,description)
  select v_org,v_staff.branch_id,auth.uid(),p.full_name,u.email,'RESTAURANT',v_category,left(trim(p_subject),160),left(trim(p_description),4000) from public.profiles p join auth.users u on u.id=auth.uid() where p.id=auth.uid() returning * into v_report;
  return v_report;
end; $$;

create or replace function public.admin_list_feedback_reports(p_limit integer default 300)
returns table(id uuid,organization_name text,branch_id uuid,source text,category text,subject text,description text,reporter_name text,reporter_email text,status text,admin_note text,created_at timestamptz,updated_at timestamptz)
language plpgsql security definer stable set search_path=public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query select f.id,o.name,f.branch_id,f.source,f.category,f.subject,f.description,f.reporter_name,f.reporter_email,f.status,f.admin_note,f.created_at,f.updated_at from public.feedback_reports f join public.organizations o on o.id=f.organization_id order by f.created_at desc limit greatest(1,least(coalesce(p_limit,300),1000));
end; $$;

create or replace function public.admin_update_feedback_report(p_id uuid,p_status text,p_admin_note text default null)
returns public.feedback_reports language plpgsql security definer set search_path=public as $$
declare v_report public.feedback_reports;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  if upper(trim(p_status)) not in('OPEN','IN_PROGRESS','RESOLVED','CLOSED') then raise exception 'Invalid feedback status'; end if;
  update public.feedback_reports set status=upper(trim(p_status)),admin_note=left(nullif(trim(p_admin_note),''),4000),updated_at=now() where id=p_id returning * into v_report;
  if v_report.id is null then raise exception 'Feedback report not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata) values(auth.uid(),'FEEDBACK_UPDATED','FEEDBACK_REPORT',p_id,jsonb_build_object('status',v_report.status));
  return v_report;
end; $$;

grant execute on function public.submit_customer_feedback(text,text,text,text,text,text) to anon,authenticated;
grant execute on function public.submit_restaurant_feedback(text,text,text) to authenticated;
grant execute on function public.admin_list_feedback_reports(integer) to authenticated;
grant execute on function public.admin_update_feedback_report(uuid,text,text) to authenticated;



-- Landing CMS and Enterprise plan controls
-- The singleton marketing reader returns one composite row; it must not use RETURN QUERY.
-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180030_landing_plan_controls.sql.

create table if not exists public.platform_marketing_settings(id boolean primary key default true check(id),hero_kicker text not null default 'BUILT FOR AMBITIOUS RESTAURANTS',hero_title text not null default 'More orders. Less chaos.',hero_description text not null default 'Tablely gives your restaurant a beautifully simple operating system — from the first QR scan to the final payment.',hero_primary_label text not null default 'Build your restaurant',hero_primary_href text not null default '/signup',hero_secondary_label text not null default 'See how it works',hero_secondary_href text not null default '#how',features_title text not null default 'Everything your team needs to run a better shift.',features_description text not null default 'One calm workspace for ordering, kitchen flow, payments and the decisions that move your restaurant forward.',how_title text not null default 'From scan to served in a few simple steps.',how_steps jsonb not null default '[]'::jsonb,updated_at timestamptz not null default now(),updated_by uuid references auth.users(id));
insert into public.platform_marketing_settings(id) values(true) on conflict(id) do nothing;
alter table public.platform_marketing_settings enable row level security;
revoke all on public.platform_marketing_settings from anon,authenticated,public;
insert into public.saas_plans(id,name,price_monthly,price_annual,trial_days,features,active,description,currency,billing_interval) values('ENTERPRISE','Enterprise',0,0,0,jsonb_build_object('enterprise_contact',true,'custom_lines',jsonb_build_array('Custom pricing and rollout','Dedicated success support','Advanced security and controls'),'ONLINE_PAYMENTS',true,'UNLIMITED_STAFF',true,'SERVICE_REQUESTS',true,'ANALYTICS',true,'PAYMENT_TRACKING',true,'CUSTOM_BRANDING',true,'MULTI_BRANCH',true,'ADVANCED_ANALYTICS',true,'CROSS_BRANCH_REPORTING',true,'ADVANCED_PERMISSIONS',true,'CUSTOM_DOMAIN',true),true,'For restaurant groups that need a tailored operating system.','INR','month') on conflict(id) do update set name=excluded.name,features=excluded.features,description=excluded.description,active=true;
create or replace function public.get_public_marketing_settings() returns public.platform_marketing_settings language sql stable security definer set search_path=public as $$ select * from public.platform_marketing_settings where id=true; $$;
create or replace function public.admin_get_marketing_settings() returns public.platform_marketing_settings language plpgsql security definer set search_path=public as $$ declare v_row public.platform_marketing_settings; begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; select * into v_row from public.platform_marketing_settings where id=true; return v_row; end; $$;
create or replace function public.admin_update_marketing_settings(p_hero_kicker text,p_hero_title text,p_hero_description text,p_hero_primary_label text,p_hero_primary_href text,p_hero_secondary_label text,p_hero_secondary_href text,p_features_title text,p_features_description text,p_how_title text,p_how_steps jsonb) returns public.platform_marketing_settings language plpgsql security definer set search_path=public as $$ declare v public.platform_marketing_settings; begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; update public.platform_marketing_settings set hero_kicker=left(trim(p_hero_kicker),120),hero_title=left(trim(p_hero_title),180),hero_description=left(trim(p_hero_description),500),hero_primary_label=left(trim(p_hero_primary_label),80),hero_primary_href=left(trim(p_hero_primary_href),200),hero_secondary_label=left(trim(p_hero_secondary_label),80),hero_secondary_href=left(trim(p_hero_secondary_href),200),features_title=left(trim(p_features_title),180),features_description=left(trim(p_features_description),500),how_title=left(trim(p_how_title),180),how_steps=coalesce(p_how_steps,'[]'::jsonb),updated_at=now(),updated_by=auth.uid() where id=true returning * into v; insert into public.admin_audit_logs(actor_user_id,action,entity_type,metadata) values(auth.uid(),'MARKETING_SETTINGS_UPDATED','MARKETING_SETTINGS','{}'::jsonb); return v; end; $$;
grant execute on function public.get_public_marketing_settings() to anon,authenticated; grant execute on function public.admin_get_marketing_settings() to authenticated; grant execute on function public.admin_update_marketing_settings(text,text,text,text,text,text,text,text,text,text,jsonb) to authenticated;


-- Global Tablely logo controls
-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180031_global_brand_logo.sql.

create table if not exists public.platform_brand_settings(id boolean primary key default true check(id),logo_url text,logo_path text,updated_at timestamptz not null default now(),updated_by uuid references auth.users(id));
insert into public.platform_brand_settings(id) values(true) on conflict(id) do nothing;
alter table public.platform_brand_settings enable row level security;
revoke all on public.platform_brand_settings from anon,authenticated,public;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('brand-assets','brand-assets',true,5242880,array['image/jpeg','image/png','image/webp','image/svg+xml']) on conflict(id) do update set public=true,file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/svg+xml'];
drop policy if exists brand_assets_insert_owner on storage.objects;
create policy brand_assets_insert_owner on storage.objects for insert to authenticated with check(bucket_id='brand-assets' and (storage.foldername(name))[1] <> 'platform' and public.is_org_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists brand_assets_update_owner on storage.objects;
create policy brand_assets_update_owner on storage.objects for update to authenticated using(bucket_id='brand-assets' and (storage.foldername(name))[1] <> 'platform' and public.is_org_owner(((storage.foldername(name))[1])::uuid)) with check(bucket_id='brand-assets' and (storage.foldername(name))[1] <> 'platform' and public.is_org_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists brand_assets_delete_owner on storage.objects;
create policy brand_assets_delete_owner on storage.objects for delete to authenticated using(bucket_id='brand-assets' and (storage.foldername(name))[1] <> 'platform' and public.is_org_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists platform_brand_assets_insert_admin on storage.objects;
create policy platform_brand_assets_insert_admin on storage.objects for insert to authenticated with check(bucket_id='brand-assets' and (storage.foldername(name))[1]='platform' and public.is_platform_admin());
drop policy if exists platform_brand_assets_update_admin on storage.objects;
create policy platform_brand_assets_update_admin on storage.objects for update to authenticated using(bucket_id='brand-assets' and (storage.foldername(name))[1]='platform' and public.is_platform_admin()) with check(bucket_id='brand-assets' and (storage.foldername(name))[1]='platform' and public.is_platform_admin());
drop policy if exists platform_brand_assets_delete_admin on storage.objects;
create policy platform_brand_assets_delete_admin on storage.objects for delete to authenticated using(bucket_id='brand-assets' and (storage.foldername(name))[1]='platform' and public.is_platform_admin());
create or replace function public.get_public_platform_brand() returns table(logo_url text) language sql stable security definer set search_path=public as $$ select logo_url from public.platform_brand_settings where id=true; $$;
create or replace function public.admin_get_platform_brand() returns public.platform_brand_settings language plpgsql security definer set search_path=public as $$ declare v_row public.platform_brand_settings; begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; select * into v_row from public.platform_brand_settings where id=true; return v_row; end; $$;
create or replace function public.admin_update_platform_brand(p_logo_url text,p_logo_path text) returns public.platform_brand_settings language plpgsql security definer set search_path=public as $$ declare v_row public.platform_brand_settings; begin if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if; update public.platform_brand_settings set logo_url=nullif(left(trim(coalesce(p_logo_url,'')),1000),''),logo_path=nullif(left(trim(coalesce(p_logo_path,'')),500),''),updated_at=now(),updated_by=auth.uid() where id=true returning * into v_row; insert into public.admin_audit_logs(actor_user_id,action,entity_type,metadata) values(auth.uid(),'PLATFORM_BRAND_UPDATED','PLATFORM_BRAND','{}'::jsonb); return v_row; end; $$;
grant execute on function public.get_public_platform_brand() to anon,authenticated;
grant execute on function public.admin_get_platform_brand() to authenticated;
grant execute on function public.admin_update_platform_brand(text,text) to authenticated;



-- Shared Pay-Later customer creation and share controls
-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180032_shared_paylater_customer_flow.sql.

alter table public.table_sessions add column if not exists join_code_display text;

create or replace function public.create_shared_pay_later_tab(p_table_code text,p_session_token text default null,p_device_token text default null) returns table(session public.table_sessions,join_code text) language plpgsql security definer set search_path=public as $$ declare v_session public.table_sessions%rowtype; v_profile uuid:=public.build22_current_customer_profile(); v_code text; begin if v_profile is null then raise exception 'Authentication required' using errcode='42501'; end if; v_session:=public.open_pay_later_session(p_table_code,p_session_token,p_device_token); insert into public.table_session_members(session_id,customer_profile_id,role) values(v_session.id,v_profile,'OWNER') on conflict(session_id,customer_profile_id) do nothing; if v_session.join_code_hash is null then v_code:=upper(substr(encode(extensions.gen_random_bytes(6),'hex'),1,10)); update public.table_sessions set join_code_hash=public.build19_hash_token(v_code),join_code_display=v_code where id=v_session.id returning * into v_session; else v_code:=v_session.join_code_display; end if; return query select v_session,v_code; end; $$;

drop function if exists public.get_my_active_pay_later_sessions();
create function public.get_my_active_pay_later_sessions() returns table(session_id uuid,table_id uuid,table_number integer,restaurant_name text,outstanding numeric,status text,role text,join_code text) language sql security definer stable set search_path=public as $$ select s.id,s.table_id,t.table_number,o.name,coalesce((select sum(ord.total) from public.orders ord where ord.table_session_id=s.id and ord.payment_status='PENDING' and ord.status not in('CANCELLED','REJECTED')),0),s.status,case when s.owner_customer_id=public.build22_current_customer_profile() then 'OWNER' else 'MEMBER' end,case when s.owner_customer_id=public.build22_current_customer_profile() then s.join_code_display else null end from public.table_sessions s join public.tables t on t.id=s.table_id join public.branches b on b.id=s.branch_id join public.organizations o on o.id=b.organization_id where s.is_pay_later and s.status in('ACTIVE','SETTLING') and (s.owner_customer_id=public.build22_current_customer_profile() or exists(select 1 from public.table_session_members m where m.session_id=s.id and m.customer_profile_id=public.build22_current_customer_profile())) order by s.opened_at desc; $$;

revoke execute on function public.create_shared_pay_later_tab(text,text,text) from anon,public;
grant execute on function public.create_shared_pay_later_tab(text,text,text) to authenticated;
revoke execute on function public.get_my_active_pay_later_sessions() from anon,public;
grant execute on function public.get_my_active_pay_later_sessions() to authenticated;
notify pgrst,'reload schema';


-- Enterprise demand-based pricing floor
-- Run once in Supabase SQL Editor.
-- Equivalent to migration 202609180033_enterprise_pricing_floor.sql.

update public.saas_plans
set price_monthly = 10000,
    price_annual = 100000
where id = 'ENTERPRISE';

notify pgrst, 'reload schema';

