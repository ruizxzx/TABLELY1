-- TABLELY: Platform-admin subscription trial invites and expiry controls.
-- Additive migration. No refund functionality.

create table if not exists public.admin_subscription_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  plan_id text not null references public.saas_plans(id),
  status text not null default 'PENDING' check (status in ('PENDING','REDEEMED','CANCELLED','EXPIRED')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  redeemed_organization_id uuid references public.organizations(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists admin_subscription_invites_email_idx on public.admin_subscription_invites(lower(email), created_at desc);
create index if not exists admin_subscription_invites_status_idx on public.admin_subscription_invites(status, ends_at);
create unique index if not exists admin_subscription_invites_one_pending_email_idx
  on public.admin_subscription_invites(lower(email)) where status='PENDING';

alter table public.admin_subscription_invites enable row level security;
revoke all on public.admin_subscription_invites from anon, authenticated;

create or replace function public.admin_create_subscription_invite(
  p_email text,
  p_plan_id text,
  p_days integer,
  p_start_at timestamptz default now()
)
returns public.admin_subscription_invites
language plpgsql
security definer
set search_path=public
as $$
declare
  v_row public.admin_subscription_invites%rowtype;
  v_email text := lower(trim(coalesce(p_email,'')));
  v_start timestamptz := coalesce(p_start_at, now());
  v_user uuid := auth.uid();
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode='42501';
  end if;
  if position('@' in v_email) < 2 or position('.' in split_part(v_email,'@',2)) < 2 then
    raise exception 'Enter a valid email address';
  end if;
  if p_days < 1 or p_days > 3650 then
    raise exception 'Trial length must be between 1 and 3650 days';
  end if;
  if not exists(select 1 from public.saas_plans where id=p_plan_id and active=true) then
    raise exception 'Invalid plan';
  end if;

  update public.admin_subscription_invites
    set status='EXPIRED', updated_at=now()
  where lower(email)=v_email and status='PENDING' and ends_at <= now();

  insert into public.admin_subscription_invites(email,plan_id,status,starts_at,ends_at,created_by)
  values(v_email,p_plan_id,'PENDING',v_start,v_start + make_interval(days=>p_days),v_user)
  on conflict ((lower(email))) where status='PENDING'
  do update set plan_id=excluded.plan_id, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
                status='PENDING', updated_at=now(), created_by=excluded.created_by,
                redeemed_at=null, redeemed_organization_id=null
  returning * into v_row;

  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(v_user,'SUBSCRIPTION_TRIAL_INVITE_CREATED','SUBSCRIPTION_INVITE',v_row.id,
         jsonb_build_object('email',v_email,'plan_id',p_plan_id,'days',p_days,'starts_at',v_start,'ends_at',v_row.ends_at));
  return v_row;
end;
$$;
grant execute on function public.admin_create_subscription_invite(text,text,integer,timestamptz) to authenticated;

create or replace function public.admin_list_subscription_invites()
returns table(id uuid,email text,plan_id text,status text,starts_at timestamptz,ends_at timestamptz,created_at timestamptz,redeemed_at timestamptz,redeemed_organization_id uuid)
language plpgsql
security definer
set search_path=public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode='42501';
  end if;
  update public.admin_subscription_invites
    set status='EXPIRED', updated_at=now()
  where status='PENDING' and ends_at <= now();
  return query
  select i.id,i.email,i.plan_id,i.status,i.starts_at,i.ends_at,i.created_at,i.redeemed_at,i.redeemed_organization_id
  from public.admin_subscription_invites i
  order by i.created_at desc;
end;
$$;
grant execute on function public.admin_list_subscription_invites() to authenticated;

create or replace function public.admin_cancel_subscription_invite(p_invite_id uuid)
returns public.admin_subscription_invites
language plpgsql
security definer
set search_path=public
as $$
declare v_row public.admin_subscription_invites%rowtype; v_user uuid:=auth.uid();
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  update public.admin_subscription_invites
    set status='CANCELLED', updated_at=now()
  where id=p_invite_id and status='PENDING'
  returning * into v_row;
  if v_row.id is null then raise exception 'Invitation is no longer pending'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(v_user,'SUBSCRIPTION_TRIAL_INVITE_CANCELLED','SUBSCRIPTION_INVITE',p_invite_id,'{}'::jsonb);
  return v_row;
end;
$$;
grant execute on function public.admin_cancel_subscription_invite(uuid) to authenticated;

create or replace function public.admin_update_subscription(
  p_organization_id uuid,
  p_plan_id text,
  p_status text,
  p_start_at timestamptz default null,
  p_end_at timestamptz default null
)
returns public.organization_subscriptions
language plpgsql
security definer
set search_path=public
as $$
declare v_row public.organization_subscriptions%rowtype; v_user uuid:=auth.uid(); v_status text:=upper(trim(p_status));
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  if not exists(select 1 from public.saas_plans where id=p_plan_id and active=true) then raise exception 'Invalid plan'; end if;
  if v_status not in ('TRIAL','ACTIVE','PAST_DUE','CANCELLED','SUSPENDED','EXPIRED') then raise exception 'Invalid subscription status'; end if;
  if p_end_at is not null and p_start_at is not null and p_end_at <= p_start_at then raise exception 'End time must be after start time'; end if;

  update public.organization_subscriptions
  set plan_id=p_plan_id,
      status=v_status,
      trial_started_at=case when v_status='TRIAL' then coalesce(p_start_at, trial_started_at, now()) else trial_started_at end,
      trial_ends_at=case when v_status='TRIAL' then p_end_at else trial_ends_at end,
      current_period_start=case when v_status='ACTIVE' then coalesce(p_start_at,current_period_start,now()) else current_period_start end,
      current_period_end=case when v_status='ACTIVE' then p_end_at else current_period_end end,
      updated_at=now()
  where organization_id=p_organization_id
  returning * into v_row;

  if v_row.id is null then
    insert into public.organization_subscriptions(organization_id,plan_id,status,
      trial_started_at,trial_ends_at,current_period_start,current_period_end)
    values(p_organization_id,p_plan_id,v_status,
      case when v_status='TRIAL' then coalesce(p_start_at,now()) else null end,
      case when v_status='TRIAL' then p_end_at else null end,
      case when v_status='ACTIVE' then coalesce(p_start_at,now()) else null end,
      case when v_status='ACTIVE' then p_end_at else null end)
    returning * into v_row;
  end if;

  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(v_user,'SUBSCRIPTION_UPDATED','ORGANIZATION',p_organization_id,
    jsonb_build_object('plan_id',p_plan_id,'status',v_status,'start_at',p_start_at,'end_at',p_end_at));
  return v_row;
end;
$$;
grant execute on function public.admin_update_subscription(uuid,text,text,timestamptz,timestamptz) to authenticated;

-- Apply a pending invite when the target authenticated user creates their first restaurant.
create or replace function public.claim_subscription_invite_for_current_user(p_organization_id uuid)
returns public.organization_subscriptions
language plpgsql
security definer
set search_path=public
as $$
declare
  v_email text;
  v_inv public.admin_subscription_invites%rowtype;
  v_sub public.organization_subscriptions%rowtype;
  v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select lower(email) into v_email from auth.users where id=v_user;
  if v_email is null then raise exception 'Account email could not be resolved'; end if;

  update public.admin_subscription_invites set status='EXPIRED',updated_at=now()
  where lower(email)=v_email and status='PENDING' and ends_at<=now();

  select * into v_inv
  from public.admin_subscription_invites
  where lower(email)=v_email and status='PENDING' and starts_at<=now() and ends_at>now()
  order by created_at desc limit 1;

  if v_inv.id is null then
    select * into v_sub from public.organization_subscriptions where organization_id=p_organization_id;
    return v_sub;
  end if;

  insert into public.organization_subscriptions(organization_id,plan_id,status,trial_started_at,trial_ends_at)
  values(p_organization_id,v_inv.plan_id,'TRIAL',v_inv.starts_at,v_inv.ends_at)
  on conflict (organization_id) do update set plan_id=excluded.plan_id,status='TRIAL',
    trial_started_at=excluded.trial_started_at,trial_ends_at=excluded.trial_ends_at,updated_at=now()
  returning * into v_sub;

  update public.admin_subscription_invites
  set status='REDEEMED',redeemed_at=now(),redeemed_organization_id=p_organization_id,updated_at=now()
  where id=v_inv.id;

  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(v_user,'SUBSCRIPTION_TRIAL_INVITE_REDEEMED','SUBSCRIPTION_INVITE',v_inv.id,jsonb_build_object('organization_id',p_organization_id));
  return v_sub;
end;
$$;
grant execute on function public.claim_subscription_invite_for_current_user(uuid) to authenticated;

-- Existing organizations: a platform admin invite can immediately become the subscription.
create or replace function public.admin_apply_invite_to_existing_owner(p_email text)
returns public.organization_subscriptions
language plpgsql
security definer
set search_path=public
as $$
declare
  v_email text:=lower(trim(p_email));
  v_user uuid;
  v_org uuid;
  v_inv public.admin_subscription_invites%rowtype;
  v_sub public.organization_subscriptions%rowtype;
  v_admin uuid:=auth.uid();
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  select id into v_user from auth.users where lower(email)=v_email limit 1;
  if v_user is null then return null; end if;
  select organization_id into v_org from public.staff where user_id=v_user and role='OWNER' and active=true order by organization_id limit 1;
  if v_org is null then return null; end if;
  update public.admin_subscription_invites set status='EXPIRED',updated_at=now() where lower(email)=v_email and status='PENDING' and ends_at<=now();
  select * into v_inv from public.admin_subscription_invites where lower(email)=v_email and status='PENDING' and ends_at>now() order by created_at desc limit 1;
  if v_inv.id is null then return null; end if;
  insert into public.organization_subscriptions(organization_id,plan_id,status,trial_started_at,trial_ends_at)
  values(v_org,v_inv.plan_id,'TRIAL',v_inv.starts_at,v_inv.ends_at)
  on conflict (organization_id) do update set plan_id=excluded.plan_id,status='TRIAL',trial_started_at=excluded.trial_started_at,trial_ends_at=excluded.trial_ends_at,updated_at=now()
  returning * into v_sub;
  update public.admin_subscription_invites set status='REDEEMED',redeemed_at=now(),redeemed_organization_id=v_org,updated_at=now() where id=v_inv.id;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(v_admin,'SUBSCRIPTION_TRIAL_INVITE_REDEEMED','SUBSCRIPTION_INVITE',v_inv.id,jsonb_build_object('organization_id',v_org,'existing_account',true));
  return v_sub;
end;
$$;
grant execute on function public.admin_apply_invite_to_existing_owner(text) to authenticated;

notify pgrst, 'reload schema';

-- Apply pending subscription invite during first restaurant onboarding.
create or replace function public.create_restaurant_for_current_user(
  p_name text,
  p_address text,
  p_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_branch_id uuid;
  v_base_slug text;
  v_final_slug text;
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'Restaurant name must be at least 2 characters';
  end if;
  if char_length(trim(coalesce(p_address, ''))) < 2 then
    raise exception 'Restaurant address must be at least 2 characters';
  end if;
  if exists (select 1 from public.organizations where owner_id = v_user_id) then
    raise exception 'Restaurant workspace already exists for this account';
  end if;

  v_base_slug := lower(trim(regexp_replace(coalesce(p_name, 'restaurant'), '[^a-zA-Z0-9]+', '-', 'g')));
  v_base_slug := trim(both '-' from v_base_slug);
  if v_base_slug = '' then v_base_slug := 'restaurant'; end if;
  v_base_slug := left(v_base_slug, 60);
  v_final_slug := v_base_slug || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

  insert into public.organizations (owner_id, name, slug)
  values (v_user_id, trim(p_name), v_final_slug)
  returning id into v_org_id;

  insert into public.branches (organization_id, name, address, phone)
  values (v_org_id, 'Main Branch', trim(p_address), nullif(trim(coalesce(p_phone, '')), ''))
  returning id into v_branch_id;

  insert into public.staff (user_id, organization_id, branch_id, role)
  values (v_user_id, v_org_id, v_branch_id, 'OWNER');

  perform public.claim_subscription_invite_for_current_user(v_org_id);
  return v_org_id;
exception
  when unique_violation then
    raise exception 'A restaurant workspace already exists for this account or a unique value conflicted';
end;
$$;
grant execute on function public.create_restaurant_for_current_user(text,text,text) to authenticated;

create or replace function public.admin_list_subscription_controls()
returns table(
  organization_id uuid,
  organization_name text,
  plan_id text,
  status text,
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz
)
language plpgsql
security definer
set search_path=public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode='42501'; end if;
  return query
  select o.id,o.name,coalesce(s.plan_id,'STARTER'),coalesce(s.status,'TRIAL'),s.trial_started_at,s.trial_ends_at,s.current_period_start,s.current_period_end
  from public.organizations o
  left join public.organization_subscriptions s on s.organization_id=o.id
  order by o.created_at desc;
end;
$$;
grant execute on function public.admin_list_subscription_controls() to authenticated;
