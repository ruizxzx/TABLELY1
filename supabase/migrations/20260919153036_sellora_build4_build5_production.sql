-- Sellora Build 4 + Build 5
-- Creator subscriptions, versioned provider plans, admin reprovisioning support,
-- subscription lifecycle persistence, entitlement reconciliation, and production hardening.

create table if not exists public.sellora_plans (
  plan_key text primary key check (plan_key in ('free','creator','pro','max')),
  name text not null,
  description text,
  price_minor bigint not null default 0 check (price_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  billing_period text not null default 'monthly' check (billing_period in ('monthly','yearly')),
  max_products bigint not null,
  max_categories bigint not null,
  features jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  grace_period_days integer not null default 3 check (grace_period_days between 0 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sellora_plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references public.sellora_plans(plan_key) on delete cascade,
  version_no integer not null check (version_no > 0),
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  billing_period text not null default 'monthly' check (billing_period in ('monthly','yearly')),
  environment text not null check (environment in ('test','live')),
  provider text not null default 'razorpay',
  provider_plan_id text,
  status text not null default 'unprovisioned' check (status in ('current','retired','unprovisioned','failed')),
  is_current boolean not null default false,
  provisioning_error text,
  provisioned_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  unique(plan_key, version_no, environment)
);
create unique index if not exists sellora_plan_versions_current_idx
  on public.sellora_plan_versions(plan_key, environment) where is_current = true;
create unique index if not exists sellora_plan_versions_provider_id_idx
  on public.sellora_plan_versions(environment, provider_plan_id)
  where provider_plan_id is not null;
create index if not exists sellora_plan_versions_plan_idx
  on public.sellora_plan_versions(plan_key, environment, created_at desc);

create table if not exists public.sellora_subscriptions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  plan_key text not null references public.sellora_plans(plan_key),
  plan_version_id uuid references public.sellora_plan_versions(id) on delete set null,
  environment text not null default 'test' check (environment in ('test','live')),
  provider text not null default 'razorpay',
  provider_subscription_id text not null unique,
  provider_plan_id text,
  provider_customer_id text,
  customer_email text,
  customer_contact text,
  status text not null default 'created' check (status in ('created','authenticated','active','pending','halted','paused','cancelled','completed','expired','failed')),
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  quantity integer not null default 1 check (quantity > 0),
  total_count integer,
  paid_count integer not null default 0,
  remaining_count integer,
  current_start timestamptz,
  current_end timestamptz,
  charge_at timestamptz,
  start_at timestamptz,
  end_at timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  pending_plan_key text references public.sellora_plans(plan_key),
  pending_plan_version_id uuid references public.sellora_plan_versions(id) on delete set null,
  pending_change_at text check (pending_change_at is null or pending_change_at in ('now','cycle_end')),
  last_provider_event_at timestamptz,
  last_synced_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  confirmation_email_sent_at timestamptz,
  failure_email_sent_at timestamptz,
  cancellation_email_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sellora_one_open_subscription_per_creator
  on public.sellora_subscriptions(creator_id)
  where status in ('created','authenticated','active','pending','paused','halted');
create index if not exists sellora_subscriptions_creator_idx
  on public.sellora_subscriptions(creator_id, created_at desc);
create index if not exists sellora_subscriptions_status_idx
  on public.sellora_subscriptions(status, current_end);
create index if not exists sellora_subscriptions_plan_idx
  on public.sellora_subscriptions(environment, plan_key, status);

create table if not exists public.sellora_subscription_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'razorpay',
  provider_event_id text not null,
  event_type text not null,
  provider_subscription_id text,
  provider_payment_id text,
  signature_verified boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error_message text,
  unique(provider, provider_event_id)
);
create index if not exists sellora_subscription_events_sub_idx
  on public.sellora_subscription_events(provider_subscription_id, received_at desc);

create table if not exists public.sellora_subscription_payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.sellora_subscriptions(id) on delete cascade,
  provider_payment_id text not null unique,
  provider_invoice_id text,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('authorized','captured','failed','refunded','partially_refunded','pending')),
  payment_method text,
  paid_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  renewal_email_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists sellora_subscription_payments_sub_idx
  on public.sellora_subscription_payments(subscription_id, created_at desc);

create table if not exists public.sellora_billing_audits (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  plan_key text,
  subscription_id uuid references public.sellora_subscriptions(id) on delete set null,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists sellora_billing_audits_created_idx
  on public.sellora_billing_audits(created_at desc);

alter table public.creator_access_grants add column if not exists expiration_notice_sent_at timestamptz;

insert into public.sellora_plans(plan_key,name,description,price_minor,currency,billing_period,max_products,max_categories,features)
values
 ('free','Free','A simple starting plan.',0,'INR','monthly',1,1,'{"branding":true,"analytics":"basic","custom_domain":false}'::jsonb),
 ('creator','Creator','For growing independent creators.',19900,'INR','monthly',10,2,'{"branding":false,"analytics":"standard","custom_domain":false}'::jsonb),
 ('pro','Pro','For established creators with larger catalogs.',49900,'INR','monthly',9223372036854775807,10,'{"branding":false,"analytics":"advanced","custom_domain":false}'::jsonb),
 ('max','Max','Maximum Sellora storefront capacity.',99900,'INR','monthly',9223372036854775807,9223372036854775807,'{"branding":false,"analytics":"advanced","custom_domain":true}'::jsonb)
on conflict (plan_key) do nothing;

insert into public.sellora_plan_versions(plan_key,version_no,amount_minor,currency,billing_period,environment,status,is_current)
select p.plan_key, 1, p.price_minor, p.currency, p.billing_period,
       env.environment,
       case when p.plan_key='free' then 'current' else 'unprovisioned' end,
       case when p.plan_key='free' then true else false end
from public.sellora_plans p
cross join (values ('test'),('live')) env(environment)
where not exists (
  select 1 from public.sellora_plan_versions v
  where v.plan_key=p.plan_key and v.version_no=1 and v.environment=env.environment
);

alter table public.sellora_plans enable row level security;
alter table public.sellora_plan_versions enable row level security;
alter table public.sellora_subscriptions enable row level security;
alter table public.sellora_subscription_events enable row level security;
alter table public.sellora_subscription_payments enable row level security;
alter table public.sellora_billing_audits enable row level security;

drop policy if exists "public read active sellora plans" on public.sellora_plans;
create policy "public read active sellora plans" on public.sellora_plans
for select to anon, authenticated using (active = true);

drop policy if exists "sellora plan versions service only" on public.sellora_plan_versions;
create policy "sellora plan versions service only" on public.sellora_plan_versions
for all to anon, authenticated using (false) with check (false);

drop policy if exists "creators read own subscriptions" on public.sellora_subscriptions;
create policy "creators read own subscriptions" on public.sellora_subscriptions
for select to authenticated using ((select auth.uid()) = creator_id);

drop policy if exists "sellora subscription events service only" on public.sellora_subscription_events;
create policy "sellora subscription events service only" on public.sellora_subscription_events
for all to anon, authenticated using (false) with check (false);

drop policy if exists "creators read own subscription payments" on public.sellora_subscription_payments;
create policy "creators read own subscription payments" on public.sellora_subscription_payments
for select to authenticated using (
  exists (
    select 1 from public.sellora_subscriptions s
    where s.id = sellora_subscription_payments.subscription_id
      and s.creator_id = (select auth.uid())
  )
);

drop policy if exists "sellora billing audits service only" on public.sellora_billing_audits;
create policy "sellora billing audits service only" on public.sellora_billing_audits
for all to anon, authenticated using (false) with check (false);

-- Explicit deny policies for service-only tables suppress accidental exposure while
-- preserving service-role access (service role bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['adjustments','audit_logs','creator_access_grants','payment_account_credentials','payment_account_secrets','payment_oauth_states','security_events','platform_settings'] loop
    execute format('drop policy if exists %I on public.%I', 'service-only deny public roles', t);
    execute format('create policy %I on public.%I for all to anon, authenticated using (false) with check (false)', 'service-only deny public roles', t);
  end loop;
end$$;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to postgres, service_role;

-- Preserve admin grants as the highest-priority entitlement source. A subscription
-- must not silently overwrite a complimentary/permanent/trial grant.
create or replace function private.sellora_reconcile_creator_plan(p_creator_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_grant public.creator_access_grants%rowtype;
  v_sub public.sellora_subscriptions%rowtype;
  v_plan text := 'free';
  v_expiry timestamptz := null;
  v_source text := 'subscription';
  v_grant_id uuid := null;
begin
  update public.creator_access_grants
  set status='expired', updated_at=now()
  where creator_id=p_creator_id and status in ('pending','active')
    and expires_at is not null and expires_at <= now();

  select * into v_grant
  from public.creator_access_grants g
  where g.creator_id=p_creator_id
    and g.status='active'
    and g.starts_at <= now()
    and (g.expires_at is null or g.expires_at > now())
  order by case when g.access_type='permanent' then 0 else 1 end, g.created_at desc
  limit 1;

  if found then
    v_plan := v_grant.plan;
    v_expiry := v_grant.expires_at;
    v_source := v_grant.access_type;
    v_grant_id := v_grant.id;
  else
    select * into v_sub
    from public.sellora_subscriptions s
    where s.creator_id=p_creator_id
    order by case when s.status in ('active','authenticated','pending','paused','halted') then 0 else 1 end,
             s.updated_at desc
    limit 1;

    if found then
      if v_sub.status in ('active','authenticated','pending','paused') then
        v_plan := v_sub.plan_key;
        v_expiry := coalesce(v_sub.current_end, v_sub.end_at);
      elsif v_sub.status='halted' then
        v_plan := v_sub.plan_key;
        select (coalesce(v_sub.current_end, v_sub.end_at) + make_interval(days => coalesce(p.grace_period_days,0)))
          into v_expiry
        from public.sellora_plans p where p.plan_key=v_sub.plan_key;
      else
        v_plan := 'free';
        v_expiry := null;
      end if;
    end if;
  end if;

  insert into public.creator_plans(creator_id,plan,access_source,access_starts_at,access_expires_at,access_grant_id,updated_at)
  values (p_creator_id,v_plan,v_source,now(),v_expiry,v_grant_id,now())
  on conflict (creator_id) do update set
    plan=excluded.plan,
    access_source=excluded.access_source,
    access_starts_at=now(),
    access_expires_at=excluded.access_expires_at,
    access_grant_id=excluded.access_grant_id,
    updated_at=now();
end;
$$;
revoke all on function private.sellora_reconcile_creator_plan(uuid) from public, anon, authenticated;
grant execute on function private.sellora_reconcile_creator_plan(uuid) to postgres, service_role;

create or replace function public.sellora_sync_subscription_entitlement(p_creator_id uuid)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
begin
  if not exists (select 1 from public.profiles where id=p_creator_id) then raise exception 'Creator not found'; end if;
  perform private.sellora_reconcile_creator_plan(p_creator_id);
end;
$$;
revoke all on function public.sellora_sync_subscription_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.sellora_sync_subscription_entitlement(uuid) to service_role;

create or replace function public.sellora_subscription_entitlement_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
begin
  perform private.sellora_reconcile_creator_plan(coalesce(new.creator_id,old.creator_id));
  return new;
end;
$$;
revoke all on function public.sellora_subscription_entitlement_trigger() from public, anon, authenticated;
drop trigger if exists trg_sellora_subscription_entitlement on public.sellora_subscriptions;
create trigger trg_sellora_subscription_entitlement
after update of plan_key, status, current_end, end_at
on public.sellora_subscriptions
for each row execute function public.sellora_subscription_entitlement_trigger();

create or replace function public.sellora_reconcile_my_plan()
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if (select auth.uid()) is null then
    raise exception using errcode='42501', message='UNAUTHORIZED';
  end if;
  -- Backwards-compatible RPC surface. Privileged reconciliation is handled
  -- by the trusted subscription/grant synchronization path.
  perform public.sellora_effective_plan((select auth.uid()));
end;
$$;
revoke all on function public.sellora_reconcile_my_plan() from public, anon;
grant execute on function public.sellora_reconcile_my_plan() to authenticated;

create or replace function public.sellora_plan_limits(p_plan text)
returns table(max_products bigint, max_categories bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select p.max_products, p.max_categories
  from public.sellora_plans p
  where p.plan_key=coalesce(p_plan,'free') and p.active=true
  union all
  select 1::bigint,1::bigint
  where not exists (
    select 1 from public.sellora_plans p
    where p.plan_key=coalesce(p_plan,'free') and p.active=true
  )
  limit 1;
$$;
revoke all on function public.sellora_plan_limits(text) from public, anon;
grant execute on function public.sellora_plan_limits(text) to authenticated, service_role;

-- Updated timestamps for mutable catalog rows.
create or replace function public.sellora_touch_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at=now();
  return new;
end;
$$;
drop trigger if exists trg_sellora_plans_updated_at on public.sellora_plans;
create trigger trg_sellora_plans_updated_at before update on public.sellora_plans for each row execute function public.sellora_touch_updated_at();

comment on table public.sellora_plans is 'Sellora subscription catalog. Admin-editable customer-facing SaaS prices and limits.';
comment on table public.sellora_plan_versions is 'Versioned provider plan records. Every pricing reprovision creates a new provider plan version.';
comment on table public.sellora_subscriptions is 'Canonical Sellora creator subscriptions synchronized with the billing provider.';
comment on table public.sellora_subscription_events is 'Idempotent, verified provider subscription webhooks.';
comment on table public.sellora_billing_audits is 'Admin/operator audit history for pricing, reprovisioning and subscription actions.';
