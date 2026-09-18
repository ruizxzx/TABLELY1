-- TABLELY BUILDS 6-10
-- Additive production-oriented migration for operations, payments, subscriptions,
-- notifications, admin controls and hardening primitives.
-- No refund workflow is implemented.

create extension if not exists pgcrypto with schema extensions;

-- -------------------- Plans / subscriptions --------------------
create table if not exists public.saas_plans (
  id text primary key,
  name text not null,
  price_monthly numeric(12,2) not null check (price_monthly >= 0),
  trial_days integer not null default 14 check (trial_days >= 0 and trial_days <= 90),
  features jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.saas_plans(id,name,price_monthly,trial_days,features)
values
  ('STARTER','Starter',399,14,jsonb_build_object('online_payments',false,'max_staff',2,'multi_branch',false,'advanced_analytics',false,'custom_domain',false)),
  ('GROWTH','Growth',799,14,jsonb_build_object('online_payments',true,'max_staff',null,'multi_branch',false,'advanced_analytics',false,'custom_domain',false)),
  ('PRO','Pro',1499,14,jsonb_build_object('online_payments',true,'max_staff',null,'multi_branch',true,'advanced_analytics',true,'custom_domain',true))
on conflict (id) do update set name=excluded.name, price_monthly=excluded.price_monthly, trial_days=excluded.trial_days, features=excluded.features;

create table if not exists public.organization_subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  plan_id text not null references public.saas_plans(id),
  status text not null default 'TRIAL' check (status in ('TRIAL','ACTIVE','PAST_DUE','CANCELLED','SUSPENDED','EXPIRED')),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists organization_subscriptions_status_idx on public.organization_subscriptions(status, current_period_end desc);

create or replace function public.ensure_organization_subscription()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.organization_subscriptions(organization_id,plan_id,status,trial_started_at,trial_ends_at)
  values(new.id,'STARTER','TRIAL',now(),now()+interval '14 days')
  on conflict (organization_id) do nothing;
  return new;
end;
$$;
drop trigger if exists organizations_create_subscription on public.organizations;
create trigger organizations_create_subscription after insert on public.organizations for each row execute function public.ensure_organization_subscription();

-- -------------------- Restaurant configuration --------------------
alter table public.organizations add column if not exists logo_url text;
alter table public.organizations add column if not exists primary_color text;
alter table public.branches add column if not exists settings jsonb not null default '{}'::jsonb;

create table if not exists public.restaurant_payment_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  razorpay_key_id text,
  razorpay_key_secret_encrypted text,
  razorpay_webhook_secret_encrypted text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- -------------------- Notifications --------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  recipient_staff_id uuid not null references public.staff(id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_recipient_created_idx on public.notifications(recipient_staff_id, created_at desc);
create index if not exists notifications_branch_created_idx on public.notifications(branch_id, created_at desc);

create or replace function public.create_staff_notification(
  p_branch_id uuid,
  p_roles public.staff_role[],
  p_type text,
  p_title text,
  p_message text,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_exclude_user uuid default null
)
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer := 0;
begin
  insert into public.notifications(branch_id,recipient_staff_id,type,title,message,entity_type,entity_id,metadata)
  select p_branch_id,s.id,p_type,p_title,p_message,p_entity_type,p_entity_id,coalesce(p_metadata,'{}'::jsonb)
  from public.staff s
  where s.branch_id=p_branch_id and s.role = any(p_roles) and (p_exclude_user is null or s.user_id <> p_exclude_user);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Centralized order notification fan-out.
create or replace function public.notify_order_status_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_table integer; v_order bigint; v_msg text; v_roles public.staff_role[];
begin
  if TG_OP='INSERT' then
    select table_number into v_table from public.tables where id=NEW.table_id;
    v_order := NEW.order_number;
    perform public.create_staff_notification(NEW.branch_id, ARRAY['OWNER','MANAGER']::public.staff_role[], 'ORDER_NEW', 'New order', format('Order #%s received from Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')), 'ORDER',NEW.id,'{}'::jsonb,null);
    return NEW;
  end if;
  select table_number into v_table from public.tables where id=NEW.table_id;
  v_order := NEW.order_number;
  if NEW.status::text = OLD.status::text and NEW.payment_status::text = OLD.payment_status::text then return NEW; end if;
  if NEW.status::text='ACCEPTED' then
    v_roles := ARRAY['KITCHEN']::public.staff_role[];
    v_msg := format('Order #%s accepted. Start preparing Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—'));
    perform public.create_staff_notification(NEW.branch_id,v_roles,'ORDER_ACCEPTED','Start preparing',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','ACCEPTED'),null);
  elsif NEW.status::text='READY' then
    v_roles := ARRAY['OWNER','MANAGER','WAITER']::public.staff_role[];
    v_msg := format('Order #%s is ready at Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—'));
    perform public.create_staff_notification(NEW.branch_id,v_roles,'ORDER_READY','Order ready',v_msg,'ORDER',NEW.id,jsonb_build_object('order_status','READY'),null);
  elsif NEW.status::text='SERVED' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_SERVED','Order served',format('Order #%s was served at Table %s.',coalesce(v_order::text,'—'),coalesce(v_table::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','SERVED'),null);
  elsif NEW.status::text='COMPLETED' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_COMPLETED','Order completed',format('Order #%s is completed.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','COMPLETED'),null);
  elsif NEW.status::text='CANCELLED' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER','WAITER','KITCHEN']::public.staff_role[],'ORDER_CANCELLED','Order cancelled',format('Order #%s was cancelled.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','CANCELLED'),null);
  elsif NEW.status::text='PREPARING' and OLD.status::text='NEW' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'ORDER_PREPARING','Order preparing',format('Order #%s has started preparing.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('order_status','PREPARING'),null);
  end if;
  if NEW.payment_status::text <> OLD.payment_status::text and NEW.payment_status::text='PAID' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER','WAITER']::public.staff_role[],'PAYMENT_PAID','Payment received',format('Order #%s is marked paid.',coalesce(v_order::text,'—')),'ORDER',NEW.id,jsonb_build_object('payment_status','PAID'),null);
  end if;
  return NEW;
end;
$$;

drop trigger if exists orders_notification_fanout on public.orders;
create trigger orders_notification_fanout after insert or update of status,payment_status on public.orders for each row execute function public.notify_order_status_change();

-- -------------------- Cancellation requests --------------------
create table if not exists public.order_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  reason text,
  status text not null default 'PENDING' check (status in ('PENDING','ACCEPTED','REJECTED')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null
);
create unique index if not exists order_cancellation_pending_uidx on public.order_cancellation_requests(order_id) where status='PENDING';
create index if not exists order_cancellation_branch_idx on public.order_cancellation_requests(branch_id, requested_at desc);

create or replace function public.request_order_cancellation(p_order_id uuid,p_reason text default null)
returns public.order_cancellation_requests language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype; v_req public.order_cancellation_requests%rowtype;
begin
  select * into v_order from public.orders where id=p_order_id;
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then raise exception 'Cancellation is no longer available for this order'; end if;
  insert into public.order_cancellation_requests(order_id,branch_id,reason) values(v_order.id,v_order.branch_id,nullif(left(trim(coalesce(p_reason,'')),300),'')) returning * into v_req;
  perform public.create_staff_notification(v_order.branch_id,ARRAY['OWNER','MANAGER','WAITER']::public.staff_role[],'CANCELLATION_REQUEST','Cancellation requested',format('Order #%s has a cancellation request.',coalesce(v_order.order_number::text,'—')),'ORDER_CANCELLATION',v_req.id,jsonb_build_object('order_id',v_order.id),null);
  return v_req;
end;
$$;
grant execute on function public.request_order_cancellation(uuid,text) to anon, authenticated;

create or replace function public.decide_order_cancellation(p_request_id uuid,p_accept boolean)
returns public.order_cancellation_requests language plpgsql security definer set search_path=public as $$
declare v_req public.order_cancellation_requests%rowtype; v_order public.orders%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into v_req from public.order_cancellation_requests where id=p_request_id for update;
  if v_req.id is null then raise exception 'Cancellation request not found'; end if;
  if v_req.status <> 'PENDING' then raise exception 'Cancellation request already decided'; end if;
  select * into v_order from public.orders where id=v_req.order_id for update;
  select * into v_staff from public.staff where user_id=v_user and branch_id=v_req.branch_id order by created_at limit 1;
  if v_staff.id is null or v_staff.role not in ('OWNER','MANAGER','WAITER') then raise exception 'Not authorized' using errcode='42501'; end if;
  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then
    update public.order_cancellation_requests set status='REJECTED', decided_at=now(), decided_by=v_user where id=v_req.id returning * into v_req;
    update public.notifications set read_at=coalesce(read_at,now()) where entity_type='ORDER_CANCELLATION' and entity_id=v_req.id;
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
    values(v_order.id,v_order.branch_id,'CANCELLATION_AUTO_REJECTED',v_user,jsonb_build_object('request_id',v_req.id,'reason','Order was no longer cancellable'));
    return v_req;
  end if;
  update public.order_cancellation_requests set status=case when p_accept then 'ACCEPTED' else 'REJECTED' end, decided_at=now(), decided_by=v_user where id=v_req.id returning * into v_req;
  update public.notifications set read_at=coalesce(read_at,now()) where entity_type='ORDER_CANCELLATION' and entity_id=v_req.id;
  if p_accept then
    update public.orders set status='CANCELLED', updated_at=now() where id=v_order.id;
    insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata)
    values(v_order.id,v_order.branch_id,'CANCELLATION_ACCEPTED',v_order.status::text,'CANCELLED',v_user,jsonb_build_object('request_id',v_req.id,'reason',v_req.reason));
  else
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
    values(v_order.id,v_order.branch_id,'CANCELLATION_REJECTED',v_user,jsonb_build_object('request_id',v_req.id,'reason',v_req.reason));
  end if;
  return v_req;
end;
$$;
grant execute on function public.decide_order_cancellation(uuid,boolean) to authenticated;


-- Automatically resolve stale cancellation requests when an order becomes non-cancellable.
update public.order_cancellation_requests r
set status='REJECTED', decided_at=coalesce(r.decided_at,now())
where r.status='PENDING'
  and exists(
    select 1 from public.orders o
    where o.id=r.order_id and o.status::text not in ('NEW','ACCEPTED','PREPARING')
  );

create or replace function public.resolve_stale_cancellation_requests()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if NEW.status::text not in ('NEW','ACCEPTED','PREPARING') and OLD.status::text <> NEW.status::text then
    update public.order_cancellation_requests r
    set status='REJECTED', decided_at=coalesce(r.decided_at,now())
    where r.order_id=NEW.id and r.status='PENDING';
    update public.notifications n
    set read_at=coalesce(n.read_at,now())
    where n.entity_type='ORDER_CANCELLATION' and n.entity_id in (select r.id from public.order_cancellation_requests r where r.order_id=NEW.id);
  end if;
  return NEW;
end;
$$;
drop trigger if exists orders_resolve_stale_cancellations on public.orders;
create trigger orders_resolve_stale_cancellations after update of status on public.orders for each row execute function public.resolve_stale_cancellation_requests();

-- -------------------- Service-request notification fan-out --------------------
create or replace function public.notify_service_request()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_table integer;
begin
  if TG_OP='INSERT' then
    select table_number into v_table from public.tables where id=NEW.table_id;
  end if;
  if TG_OP='INSERT' and NEW.status='OPEN' then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER','WAITER']::public.staff_role[],'SERVICE_REQUEST','Service request',format('Table %s requested %s.',coalesce(v_table::text,'—'),replace(lower(NEW.type),'_',' ')),'SERVICE_REQUEST',NEW.id,jsonb_build_object('type',NEW.type),null);
  end if;
  if TG_OP='UPDATE' and OLD.status<>NEW.status and NEW.status in ('RESOLVED','CANCELLED') then
    perform public.create_staff_notification(NEW.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'SERVICE_RESOLVED','Service request resolved',format('Table %s service request was %s.',coalesce(v_table::text,'—'),lower(NEW.status)),'SERVICE_REQUEST',NEW.id,jsonb_build_object('status',NEW.status),NEW.resolved_by);
  end if;
  return NEW;
end;
$$;
drop trigger if exists service_request_notification_fanout on public.service_requests;
create trigger service_request_notification_fanout after insert or update of status on public.service_requests for each row execute function public.notify_service_request();


-- -------------------- Staff invitations / no-admin fallback --------------------
create table if not exists public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  email text not null,
  role public.staff_role not null check (role in ('MANAGER','WAITER','KITCHEN')),
  token_hash text not null unique,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists staff_invitations_branch_idx on public.staff_invitations(branch_id, created_at desc);
create index if not exists staff_invitations_email_idx on public.staff_invitations(lower(email));
alter table public.staff_invitations enable row level security;
revoke all on public.staff_invitations from anon, authenticated;
alter table public.staff add column if not exists active boolean not null default true;
alter table public.staff add column if not exists display_name text;

drop policy if exists staff_invitations_owner_select on public.staff_invitations;
create policy staff_invitations_owner_select on public.staff_invitations for select to authenticated
using (exists(select 1 from public.staff s where s.user_id=auth.uid() and s.organization_id=staff_invitations.organization_id and s.role='OWNER' and s.active=true));

drop policy if exists staff_invitations_owner_insert on public.staff_invitations;
create policy staff_invitations_owner_insert on public.staff_invitations for insert to authenticated
with check (exists(select 1 from public.staff s where s.user_id=auth.uid() and s.organization_id=staff_invitations.organization_id and s.role='OWNER' and s.active=true));


-- -------------------- Staff lifecycle --------------------
create index if not exists staff_branch_active_idx on public.staff(branch_id,active,role);


create or replace function public.create_staff_invitation(p_branch_id uuid,p_email text,p_role public.staff_role)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_actor public.staff%rowtype; v_branch public.branches%rowtype; v_token text; v_row public.staff_invitations%rowtype; v_email text:=lower(trim(p_email));
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select s.* into v_actor from public.staff s where s.user_id=auth.uid() and s.active=true and s.role='OWNER' order by s.created_at limit 1;
  if v_actor.id is null then raise exception 'Only the owner can invite staff' using errcode='42501'; end if;
  select b.* into v_branch from public.branches b where b.id=p_branch_id and b.organization_id=v_actor.organization_id;
  if v_branch.id is null then raise exception 'Invalid branch' using errcode='42501'; end if;
  if p_role not in ('MANAGER','WAITER','KITCHEN') then raise exception 'Invalid staff role'; end if;
  if v_email='' or v_email !~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' then raise exception 'Invalid email address'; end if;
  if exists(select 1 from public.staff s where s.organization_id=v_actor.organization_id and lower(coalesce((select au.email from auth.users au where au.id=s.user_id),''))=v_email and s.active=true) then
    raise exception 'A staff member with this email is already active';
  end if;
  v_token:=encode(extensions.gen_random_bytes(24),'hex');
  insert into public.staff_invitations(organization_id,branch_id,email,role,token_hash,created_by)
  values(v_actor.organization_id,v_branch.id,v_email,p_role,encode(extensions.digest(v_token,'sha256'),'hex'),auth.uid())
  returning * into v_row;
  return jsonb_build_object('id',v_row.id,'email',v_row.email,'role',v_row.role,'expires_at',v_row.expires_at,'token',v_token);
end;
$$;
grant execute on function public.create_staff_invitation(uuid,text,public.staff_role) to authenticated;

create or replace function public.claim_staff_invitation(p_token text,p_display_name text default null)
returns public.staff language plpgsql security definer set search_path=public,extensions as $$
declare v_inv public.staff_invitations%rowtype; v_hash text:=encode(extensions.digest(trim(coalesce(p_token,'')),'sha256'),'hex'); v_user uuid:=auth.uid(); v_email text; v_staff public.staff%rowtype;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  if trim(coalesce(p_token,''))='' then raise exception 'Invitation link is invalid'; end if;
  select * into v_inv from public.staff_invitations where token_hash=v_hash for update;
  if v_inv.id is null then raise exception 'Invitation link is invalid or expired'; end if;
  if v_inv.accepted_at is not null or v_inv.expires_at<=now() then raise exception 'Invitation link is invalid or expired'; end if;
  select lower(coalesce(email,'')) into v_email from auth.users where id=v_user;
  if v_email is null or v_email<>lower(v_inv.email) then raise exception 'Sign in with the invited email address' using errcode='42501'; end if;
  insert into public.staff as st(user_id,organization_id,branch_id,role,active,display_name)
  values(v_user,v_inv.organization_id,v_inv.branch_id,v_inv.role,true,nullif(left(trim(coalesce(p_display_name,'')),120),''))
  on conflict (user_id,organization_id,branch_id) do update set role=excluded.role,active=true,display_name=coalesce(excluded.display_name,st.display_name),updated_at=now()
  returning * into v_staff;
  update public.staff_invitations set accepted_at=now() where id=v_inv.id;
  return v_staff;
end;
$$;
grant execute on function public.claim_staff_invitation(text,text) to authenticated;

create or replace function public.set_staff_active(p_staff_id uuid,p_active boolean)
returns public.staff language plpgsql security definer set search_path=public as $$
declare v_staff public.staff%rowtype; v_actor public.staff%rowtype; v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into v_staff from public.staff where id=p_staff_id for update;
  select * into v_actor from public.staff where user_id=v_user and organization_id=v_staff.organization_id and active=true order by case when role='OWNER' then 0 else 1 end limit 1;
  if v_staff.id is null or v_actor.id is null or v_actor.role <> 'OWNER' then raise exception 'Only the owner can change staff status' using errcode='42501'; end if;
  if v_staff.role='OWNER' and not p_active then raise exception 'Owner cannot be disabled'; end if;
  update public.staff set active=p_active,updated_at=now() where id=p_staff_id returning * into v_staff;
  return v_staff;
end;
$$;
grant execute on function public.set_staff_active(uuid,boolean) to authenticated;

create or replace function public.change_staff_role(p_staff_id uuid,p_role public.staff_role)
returns public.staff language plpgsql security definer set search_path=public as $$
declare v_staff public.staff%rowtype; v_actor public.staff%rowtype; v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into v_staff from public.staff where id=p_staff_id for update;
  select * into v_actor from public.staff where user_id=v_user and organization_id=v_staff.organization_id and active=true order by created_at limit 1;
  if v_staff.id is null or v_actor.id is null or v_actor.role <> 'OWNER' then raise exception 'Only the owner can change staff role' using errcode='42501'; end if;
  if v_staff.role='OWNER' and p_role<>'OWNER' then raise exception 'Owner role cannot be reassigned through this action'; end if;
  update public.staff set role=p_role,updated_at=now() where id=p_staff_id returning * into v_staff;
  return v_staff;
end;
$$;
grant execute on function public.change_staff_role(uuid,public.staff_role) to authenticated;

-- -------------------- Payment + subscription helpers --------------------
create or replace function public.record_manual_payment(p_order_id uuid,p_method text,p_reference text default null)
returns table(id uuid,payment_status public.payment_status,payment_method text,paid_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  return query select * from public.mark_order_paid(p_order_id,p_method,p_reference);
end;
$$;
grant execute on function public.record_manual_payment(uuid,text,text) to authenticated;

-- -------------------- Notifications RLS --------------------
alter table public.notifications enable row level security;
revoke all on public.notifications from anon;
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications for select to authenticated using (exists(select 1 from public.staff s where s.id=notifications.recipient_staff_id and s.user_id=auth.uid() and s.active=true));
drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications for update to authenticated using (exists(select 1 from public.staff s where s.id=notifications.recipient_staff_id and s.user_id=auth.uid() and s.active=true)) with check (exists(select 1 from public.staff s where s.id=notifications.recipient_staff_id and s.user_id=auth.uid() and s.active=true));
grant select,update on public.notifications to authenticated;

alter table public.order_cancellation_requests enable row level security;
revoke all on public.order_cancellation_requests from anon;
drop policy if exists cancellation_select_member on public.order_cancellation_requests;
create policy cancellation_select_member on public.order_cancellation_requests for select to authenticated using (public.is_branch_member(branch_id));
grant select on public.order_cancellation_requests to authenticated;

alter table public.organization_subscriptions enable row level security;
revoke all on public.organization_subscriptions from anon;
drop policy if exists subscriptions_select_member on public.organization_subscriptions;
create policy subscriptions_select_member on public.organization_subscriptions for select to authenticated using (public.is_org_member(organization_id));
grant select on public.organization_subscriptions to authenticated;

alter table public.saas_plans enable row level security;
revoke all on public.saas_plans from anon;
drop policy if exists plans_select_authenticated on public.saas_plans;
create policy plans_select_authenticated on public.saas_plans for select to authenticated using (active=true);
grant select on public.saas_plans to authenticated;

alter table public.restaurant_payment_settings enable row level security;
revoke all on public.restaurant_payment_settings from anon;
drop policy if exists payment_settings_select_owner on public.restaurant_payment_settings;
create policy payment_settings_select_owner on public.restaurant_payment_settings for select to authenticated using (public.is_org_owner(organization_id));
grant select on public.restaurant_payment_settings to authenticated;

-- -------------------- Platform admin --------------------
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon,authenticated;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.platform_admins a where a.user_id=auth.uid() and a.active=true);
$$;
grant execute on function public.is_platform_admin() to authenticated;

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_logs_created_idx on public.admin_audit_logs(created_at desc);
alter table public.admin_audit_logs enable row level security;
revoke all on public.admin_audit_logs from anon,authenticated;
drop policy if exists admin_audit_select on public.admin_audit_logs;
create policy admin_audit_select on public.admin_audit_logs for select to authenticated using (public.is_platform_admin());
grant select on public.admin_audit_logs to authenticated;

create or replace function public.admin_set_organization_status(p_organization_id uuid,p_status public.account_status)
returns public.organizations language plpgsql security definer set search_path=public as $$
declare v_org public.organizations%rowtype; v_user uuid:=auth.uid();
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  update public.organizations set status=p_status,updated_at=now() where id=p_organization_id returning * into v_org;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata) values(v_user,'ORG_STATUS_CHANGED','ORGANIZATION',p_organization_id,jsonb_build_object('status',p_status::text));
  return v_org;
end;
$$;
grant execute on function public.admin_set_organization_status(uuid,public.account_status) to authenticated;

-- -------------------- Realtime --------------------
alter table public.notifications replica identity full;
alter table public.order_cancellation_requests replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.notifications; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.order_cancellation_requests; exception when duplicate_object then null; end;
end $$;

-- -------------------- Additional indexes / integrity --------------------
create index if not exists orders_branch_status_updated_idx on public.orders(branch_id,status,updated_at desc);
create index if not exists orders_branch_payment_idx on public.orders(branch_id,payment_status,created_at desc);

-- Note: the legacy payment_status enum may still contain REFUNDED for backward compatibility.
-- V1 application code does not use or expose a refund workflow.

select pg_notify('pgrst','reload schema');

-- -------------------- Final order transition policy for Build 6 --------------------
create or replace function public.transition_order_status(p_order_id uuid, p_new_status public.order_status)
returns table (
  id uuid, order_number bigint, table_id uuid, branch_id uuid,
  status public.order_status, payment_status public.payment_status,
  payment_method text, subtotal numeric, tax numeric, discount numeric,
  total numeric, created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer set search_path=public as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_allowed boolean := false;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select o.* into v_order from public.orders o where o.id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select s.* into v_staff from public.staff s where s.user_id=v_user and s.branch_id=v_order.branch_id and s.active=true
    order by case when s.role='OWNER' then 0 when s.role='MANAGER' then 1 when s.role='KITCHEN' then 2 else 3 end, s.created_at limit 1;
  if v_staff.id is null then raise exception 'You do not have access to this order' using errcode='42501'; end if;

  if v_order.status='NEW' and p_new_status='ACCEPTED' and v_staff.role in ('OWNER','MANAGER') then v_allowed:=true;
  elsif v_order.status='ACCEPTED' and p_new_status='PREPARING' and v_staff.role in ('OWNER','MANAGER','KITCHEN') then v_allowed:=true;
  elsif v_order.status='PREPARING' and p_new_status='READY' and v_staff.role in ('OWNER','MANAGER','KITCHEN') then v_allowed:=true;
  elsif v_order.status='READY' and p_new_status='SERVED' and v_staff.role in ('OWNER','MANAGER','WAITER') then v_allowed:=true;
  elsif v_order.status='SERVED' and p_new_status='COMPLETED' and v_staff.role in ('OWNER','MANAGER','WAITER') then v_allowed:=true;
  end if;
  if not v_allowed then raise exception 'Invalid or unauthorized order status transition: % → %',v_order.status,p_new_status using errcode='42501'; end if;

  update public.orders as ord set status=p_new_status,updated_at=now() where ord.id=v_order.id;
  insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id)
  values(v_order.id,v_order.branch_id,'STATUS_CHANGED',v_order.status::text,p_new_status::text,v_user);
  return query select ord.id,ord.order_number,ord.table_id,ord.branch_id,ord.status,ord.payment_status,ord.payment_method,ord.subtotal,ord.tax,ord.discount,ord.total,ord.created_at,ord.updated_at from public.orders ord where ord.id=v_order.id;
end;
$$;
grant execute on function public.transition_order_status(uuid,public.order_status) to authenticated;

-- -------------------- Subscription backfill / payment gating --------------------
insert into public.organization_subscriptions(organization_id,plan_id,status,trial_started_at,trial_ends_at)
select o.id,'STARTER','TRIAL',o.created_at,o.created_at+interval '14 days'
from public.organizations o left join public.organization_subscriptions s on s.organization_id=o.id
where s.organization_id is null;

create or replace function public.get_public_payment_options(p_table_code text)
returns table(online_payment_enabled boolean,plan_id text)
language sql security definer set search_path=public as $$
  select (coalesce(s.features->>'online_payments','false')='true' and coalesce(p.enabled,false) and coalesce(os.status,'TRIAL') in ('TRIAL','ACTIVE')) as online_payment_enabled, s.id
  from public.tables t
  join public.branches b on b.id=t.branch_id
  join public.organizations o on o.id=b.organization_id
  left join public.organization_subscriptions os on os.organization_id=o.id
  left join public.saas_plans s on s.id=os.plan_id
  left join public.restaurant_payment_settings p on p.organization_id=o.id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
  limit 1;
$$;
grant execute on function public.get_public_payment_options(text) to anon,authenticated;

-- Gate PAY_NOW at the authoritative order-creation layer.
-- Recreate the function by editing the current version in-place through an early authorization guard.
-- (The full existing function remains in prior migration; this guard is added as a trigger below.)
create or replace function public.enforce_online_payment_choice()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_enabled boolean;
begin
  if NEW.payment_method='PAY_NOW' then
    select (coalesce(sp.features->>'online_payments','false')='true' and coalesce(rps.enabled,false) and coalesce(os.status,'TRIAL') in ('TRIAL','ACTIVE')) into v_enabled
    from public.branches b
    join public.organizations o on o.id=b.organization_id
    left join public.organization_subscriptions os on os.organization_id=o.id
    left join public.saas_plans sp on sp.id=os.plan_id
    left join public.restaurant_payment_settings rps on rps.organization_id=o.id
    where b.id=NEW.branch_id;
    if not coalesce(v_enabled,false) then raise exception 'Online payment is not enabled for this restaurant plan'; end if;
  end if;
  return NEW;
end;
$$;
drop trigger if exists enforce_online_payment_choice on public.orders;
create trigger enforce_online_payment_choice before insert on public.orders for each row execute function public.enforce_online_payment_choice();

-- -------------------- Authoritative table operational state --------------------
alter table public.tables add column if not exists operational_state text not null default 'AVAILABLE';
DO $$ BEGIN
  alter table public.tables add constraint tables_operational_state_chk check (operational_state in ('AVAILABLE','ORDERING','OCCUPIED','BILL_REQUESTED','CLEARING'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
create index if not exists tables_branch_operational_state_idx on public.tables(branch_id,operational_state);

create or replace function public.sync_table_operational_state(p_table_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_state text:='AVAILABLE'; v_status public.order_status; v_bill boolean;
begin
  select exists(select 1 from public.service_requests r where r.table_id=p_table_id and r.type='BILL' and r.status in ('OPEN','ACKNOWLEDGED')) into v_bill;
  if v_bill then v_state:='BILL_REQUESTED';
  else
    select o.status into v_status from public.orders o where o.table_id=p_table_id and o.status not in ('COMPLETED','CANCELLED') order by o.created_at desc limit 1;
    v_state:=case
      when v_status='NEW' then 'ORDERING'
      when v_status is not null then 'OCCUPIED'
      else 'AVAILABLE'
    end;
  end if;
  update public.tables set operational_state=v_state where id=p_table_id;
end;
$$;


-- -------------------- Platform admin read RPCs --------------------
create or replace function public.admin_overview()
returns jsonb language plpgsql security definer set search_path=public as $$
declare v jsonb;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'restaurants',(select count(*) from public.organizations),
    'active_restaurants',(select count(*) from public.organizations where status='ACTIVE'),
    'trial_restaurants',(select count(*) from public.organization_subscriptions where status='TRIAL'),
    'active_subscriptions',(select count(*) from public.organization_subscriptions where status='ACTIVE'),
    'orders_today',(select count(*) from public.orders where created_at>=date_trunc('day',now())),
    'payments_today',(select coalesce(sum(total),0) from public.orders where payment_status='PAID' and created_at>=date_trunc('day',now())),
    'mrr',(select coalesce(sum(sp.price_monthly),0) from public.organization_subscriptions os join public.saas_plans sp on sp.id=os.plan_id where os.status='ACTIVE')
  ) into v;
  return v;
end;
$$;
grant execute on function public.admin_overview() to authenticated;

create or replace function public.admin_list_organizations()
returns table(id uuid,name text,slug text,status public.account_status,created_at timestamptz,plan_id text,subscription_status text,branch_count bigint)
language sql security definer set search_path=public as $$
  select o.id,o.name,o.slug,o.status,o.created_at,coalesce(os.plan_id,'STARTER'),coalesce(os.status,'TRIAL'),(select count(*) from public.branches b where b.organization_id=o.id)
  from public.organizations o left join public.organization_subscriptions os on os.organization_id=o.id
  where public.is_platform_admin() order by o.created_at desc;
$$;
grant execute on function public.admin_list_organizations() to authenticated;

create or replace function public.admin_set_subscription(p_organization_id uuid,p_plan_id text,p_status text)
returns public.organization_subscriptions language plpgsql security definer set search_path=public as $$
declare v_row public.organization_subscriptions%rowtype; v_user uuid:=auth.uid();
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  if not exists(select 1 from public.saas_plans where id=p_plan_id and active=true) then raise exception 'Invalid plan'; end if;
  update public.organization_subscriptions set plan_id=p_plan_id,status=upper(p_status),updated_at=now() where organization_id=p_organization_id returning * into v_row;
  if v_row.id is null then insert into public.organization_subscriptions(organization_id,plan_id,status) values(p_organization_id,p_plan_id,upper(p_status)) returning * into v_row; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata) values(v_user,'SUBSCRIPTION_CHANGED','ORGANIZATION',p_organization_id,jsonb_build_object('plan_id',p_plan_id,'status',upper(p_status)));
  return v_row;
end;
$$;
grant execute on function public.admin_set_subscription(uuid,text,text) to authenticated;

-- Correct trigger wrappers (trigger arguments are constants; use NEW/OLD inside wrapper).
create or replace function public.orders_sync_table_state_trigger()
returns trigger language plpgsql security definer set search_path=public as $$
begin if TG_OP='DELETE' then perform public.sync_table_operational_state(OLD.table_id); else perform public.sync_table_operational_state(NEW.table_id); end if; return coalesce(NEW,OLD); end;
$$;
create or replace function public.service_sync_table_state_trigger()
returns trigger language plpgsql security definer set search_path=public as $$
begin if TG_OP='DELETE' then perform public.sync_table_operational_state(OLD.table_id); else perform public.sync_table_operational_state(NEW.table_id); end if; return coalesce(NEW,OLD); end;
$$;
drop trigger if exists orders_sync_table_state on public.orders;
create trigger orders_sync_table_state after insert or update of status or delete on public.orders for each row execute function public.orders_sync_table_state_trigger();
drop trigger if exists service_sync_table_state on public.service_requests;
create trigger service_sync_table_state after insert or update of status or delete on public.service_requests for each row execute function public.service_sync_table_state_trigger();

-- Secure customer cancellation requests with the opaque tracking token.
drop function if exists public.request_order_cancellation(uuid,text);
create or replace function public.request_order_cancellation(p_order_id uuid,p_tracking_token text,p_reason text default null)
returns public.order_cancellation_requests language plpgsql security definer set search_path=public as $$
declare v_order public.orders%rowtype; v_req public.order_cancellation_requests%rowtype;
begin
  select * into v_order from public.orders where id=p_order_id and tracking_token=trim(p_tracking_token);
  if v_order.id is null then raise exception 'Order not found'; end if;
  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then raise exception 'Cancellation is no longer available for this order'; end if;
  insert into public.order_cancellation_requests(order_id,branch_id,reason) values(v_order.id,v_order.branch_id,nullif(left(trim(coalesce(p_reason,'')),300),'')) returning * into v_req;
  perform public.create_staff_notification(v_order.branch_id,ARRAY['OWNER','MANAGER']::public.staff_role[],'CANCELLATION_REQUEST','Cancellation requested',format('Order #%s has a cancellation request.',coalesce(v_order.order_number::text,'—')),'ORDER_CANCELLATION',v_req.id,jsonb_build_object('order_id',v_order.id),null);
  return v_req;
end;
$$;
grant execute on function public.request_order_cancellation(uuid,text,text) to anon,authenticated;

create or replace function public.decide_order_cancellation(p_request_id uuid,p_accept boolean)
returns public.order_cancellation_requests language plpgsql security definer set search_path=public as $$
declare v_req public.order_cancellation_requests%rowtype; v_order public.orders%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select * into v_req from public.order_cancellation_requests where id=p_request_id for update;
  if v_req.id is null then raise exception 'Cancellation request not found'; end if;
  if v_req.status <> 'PENDING' then raise exception 'Cancellation request already decided'; end if;
  select * into v_order from public.orders where id=v_req.order_id for update;
  select * into v_staff from public.staff where user_id=v_user and branch_id=v_req.branch_id and active=true order by case when role='OWNER' then 0 when role='MANAGER' then 1 else 2 end,created_at limit 1;
  if v_staff.id is null or v_staff.role not in ('OWNER','MANAGER') then raise exception 'Only the owner or manager can decide cancellations' using errcode='42501'; end if;
  if v_order.status::text not in ('NEW','ACCEPTED','PREPARING') then raise exception 'Order can no longer be cancelled'; end if;
  update public.order_cancellation_requests set status=case when p_accept then 'ACCEPTED' else 'REJECTED' end,decided_at=now(),decided_by=v_user where id=v_req.id returning * into v_req;
  if p_accept then
    update public.orders set status='CANCELLED',updated_at=now() where id=v_order.id;
    insert into public.order_events(order_id,branch_id,event_type,from_status,to_status,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'CANCELLATION_ACCEPTED',v_order.status::text,'CANCELLED',v_user,jsonb_build_object('request_id',v_req.id,'reason',v_req.reason));
  else
    insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata) values(v_order.id,v_order.branch_id,'CANCELLATION_REJECTED',v_user,jsonb_build_object('request_id',v_req.id,'reason',v_req.reason));
  end if;
  return v_req;
end;
$$;
grant execute on function public.decide_order_cancellation(uuid,boolean) to authenticated;

-- Customer-safe cancellation request feedback on the same opaque tracking channel.
create or replace function public.broadcast_cancellation_update()
returns trigger language plpgsql security definer set search_path=public,realtime as $$
declare v_token text;
begin
  select o.tracking_token into v_token from public.orders o where o.id=NEW.order_id;
  if v_token is not null and length(v_token)>=16 then
    perform realtime.send(jsonb_build_object('request_id',NEW.id,'status',NEW.status,'updated_at',coalesce(NEW.decided_at,NEW.requested_at)),'CANCELLATION_STATUS','tablely:order:'||v_token,false);
  end if;
  return NEW;
end;
$$;
drop trigger if exists cancellation_broadcast on public.order_cancellation_requests;
create trigger cancellation_broadcast after insert or update of status on public.order_cancellation_requests for each row execute function public.broadcast_cancellation_update();
