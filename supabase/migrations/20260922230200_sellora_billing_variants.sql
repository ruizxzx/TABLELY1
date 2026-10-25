-- Monthly/yearly billing variants while preserving plan_key as the entitlement identity.
create table if not exists public.sellora_plan_variants (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references public.sellora_plans(plan_key) on delete cascade,
  billing_period text not null check (billing_period in ('monthly','yearly')),
  price_minor bigint not null default 0 check (price_minor >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  annual_discount_percent numeric(5,2) not null default 0 check (annual_discount_percent between 0 and 100),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(plan_key, billing_period)
);

grant select, insert, update, delete on public.sellora_plans, public.sellora_plan_versions, public.sellora_plan_variants, public.sellora_subscriptions, public.sellora_subscription_events, public.sellora_subscription_payments, public.sellora_billing_audits to service_role;

insert into public.sellora_plan_variants (plan_key, billing_period, price_minor, currency, annual_discount_percent)
select plan_key, 'monthly', price_minor, currency, 0
from public.sellora_plans
on conflict (plan_key, billing_period) do update set price_minor = excluded.price_minor, currency = excluded.currency, updated_at = now();

insert into public.sellora_plan_variants (plan_key, billing_period, price_minor, currency, annual_discount_percent)
select plan_key, 'yearly', case when price_minor > 0 then price_minor * 10 else 0 end, currency,
  case when price_minor > 0 then 16.67 else 0 end
from public.sellora_plans
on conflict (plan_key, billing_period) do nothing;

alter table public.sellora_plan_versions add column if not exists variant_id uuid references public.sellora_plan_variants(id) on delete cascade;
alter table public.sellora_subscriptions add column if not exists variant_id uuid references public.sellora_plan_variants(id) on delete set null;
alter table public.sellora_subscriptions add column if not exists billing_period text check (billing_period in ('monthly','yearly'));
alter table public.sellora_subscriptions add column if not exists pending_variant_id uuid references public.sellora_plan_variants(id) on delete set null;
alter table public.sellora_subscriptions add column if not exists pending_billing_period text check (pending_billing_period in ('monthly','yearly'));

update public.sellora_plan_versions v
set variant_id = pv.id
from public.sellora_plan_variants pv
where v.variant_id is null and pv.plan_key = v.plan_key and pv.billing_period = coalesce(v.billing_period, 'monthly');

update public.sellora_subscriptions s
set variant_id = v.variant_id,
    billing_period = coalesce(v.billing_period, 'monthly')
from public.sellora_plan_versions v
where s.plan_version_id = v.id and s.variant_id is null;

update public.sellora_subscriptions s
set variant_id = pv.id,
    billing_period = 'monthly'
from public.sellora_plan_variants pv
where s.variant_id is null and pv.plan_key = s.plan_key and pv.billing_period = 'monthly';

alter table public.sellora_plan_versions alter column variant_id set not null;
drop index if exists public.sellora_plan_versions_current_idx;
alter table public.sellora_plan_versions drop constraint if exists sellora_plan_versions_plan_key_version_no_environment_key;
create unique index if not exists sellora_plan_versions_variant_version_idx
  on public.sellora_plan_versions(variant_id, version_no, environment);
create unique index if not exists sellora_plan_versions_current_variant_idx
  on public.sellora_plan_versions(variant_id, environment) where is_current = true;
create index if not exists sellora_plan_versions_variant_idx
  on public.sellora_plan_versions(variant_id, environment, created_at desc);
create index if not exists sellora_subscriptions_variant_idx
  on public.sellora_subscriptions(environment, variant_id, status);

update public.sellora_plans p
set billing_period = 'monthly',
    price_minor = pv.price_minor,
    currency = pv.currency,
    updated_at = now()
from public.sellora_plan_variants pv
where pv.plan_key = p.plan_key and pv.billing_period = 'monthly';
