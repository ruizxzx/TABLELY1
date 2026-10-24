-- Sellora Build 9 + 10: financial ledger, payouts, admin, moderation, refunds, disputes, audit, domains, security.
-- Additive/idempotent migration. Run after 004_build_6_7_8.sql.

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  store_id uuid references public.stores(id) on delete set null,
  creator_id uuid references public.profiles(id) on delete set null,
  entry_type text not null check (entry_type in ('sale','payment_fee','platform_fee','adjustment','refund','payout','seller_net','tax','chargeback')),
  direction text not null check (direction in ('credit','debit')),
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null default 'INR',
  description text,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_fees (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  provider text not null,
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  currency text not null default 'INR',
  provider_reference text,
  created_at timestamptz not null default now(),
  unique(order_id, provider)
);

create table if not exists public.platform_fees (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  creator_id uuid references public.profiles(id) on delete set null,
  amount_minor bigint not null default 0 check (amount_minor >= 0),
  currency text not null default 'INR',
  rate_bps integer not null default 0 check (rate_bps >= 0),
  created_at timestamptz not null default now(),
  unique(order_id)
);

create table if not exists public.adjustments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete set null,
  creator_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('tax','manual_credit','manual_debit','rounding','chargeback')),
  amount_minor bigint not null check (amount_minor >= 0),
  direction text not null check (direction in ('credit','debit')),
  reason text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  creator_id uuid references public.profiles(id) on delete set null,
  requested_amount_minor bigint not null check (requested_amount_minor > 0),
  approved_amount_minor bigint not null default 0 check (approved_amount_minor >= 0),
  currency text not null default 'INR',
  status text not null default 'requested' check (status in ('requested','approved','rejected','processing','succeeded','failed')),
  reason text,
  provider_refund_id text,
  requested_by_email text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.payouts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null default 'INR',
  status text not null default 'pending' check (status in ('pending','processing','paid','held','failed','cancelled')),
  method text not null default 'unsupported_pending_setup',
  provider text,
  provider_payout_id text,
  provider_account_id text,
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  unique(provider, provider_payout_id)
);

create table if not exists public.creator_verifications (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null unique references public.profiles(id) on delete cascade,
  status text not null default 'not_started' check (status in ('not_started','pending','verified','action_required','restricted','rejected')),
  provider text,
  provider_account_id text,
  requirements_due jsonb not null default '[]'::jsonb,
  last_provider_sync_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create table if not exists public.product_reports (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  reporter_email text,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  moderation_action text check (moderation_action in ('none','flag','hide','remove')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.creator_reports (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  reporter_email text,
  reason text not null,
  details text,
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  moderation_action text check (moderation_action in ('none','flag','suspend','ban')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.disputes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  creator_id uuid references public.profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open','investigating','evidence_submitted','won','lost','resolved')),
  provider text,
  provider_reference text,
  reason text,
  internal_notes text,
  evidence jsonb not null default '[]'::jsonb,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.custom_domains (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  domain text not null unique,
  status text not null default 'pending_dns' check (status in ('pending_dns','verified','active','failed','disabled')),
  verification_token text not null,
  verified_at timestamptz,
  ssl_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.security_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  path text,
  ip_address inet,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists account_status text not null default 'active' check (account_status in ('active','suspended','banned'));
alter table public.products add column if not exists moderation_status text not null default 'clear' check (moderation_status in ('clear','flagged','hidden','removed'));
alter table public.stores add column if not exists custom_domain_id uuid references public.custom_domains(id) on delete set null;
alter table public.orders add column if not exists refund_amount_minor bigint not null default 0;
alter table public.orders add column if not exists disputed_at timestamptz;
alter table public.orders add column if not exists last_refund_at timestamptz;

create index if not exists ledger_creator_created_idx on public.ledger_entries(creator_id, created_at desc);
create index if not exists ledger_order_idx on public.ledger_entries(order_id);
create index if not exists payouts_creator_status_idx on public.payouts(creator_id, status);
create index if not exists refunds_order_idx on public.refunds(order_id, created_at desc);
create index if not exists audit_created_idx on public.audit_logs(created_at desc);
create index if not exists product_reports_status_idx on public.product_reports(status);
create index if not exists creator_reports_status_idx on public.creator_reports(status);
create index if not exists disputes_status_idx on public.disputes(status);

alter table public.ledger_entries enable row level security;
alter table public.payment_fees enable row level security;
alter table public.platform_fees enable row level security;
alter table public.adjustments enable row level security;
alter table public.refunds enable row level security;
alter table public.payouts enable row level security;
alter table public.creator_verifications enable row level security;
alter table public.audit_logs enable row level security;
alter table public.product_reports enable row level security;
alter table public.creator_reports enable row level security;
alter table public.disputes enable row level security;
alter table public.custom_domains enable row level security;
alter table public.security_events enable row level security;

-- Creator read policies. Sensitive writes are server-only.
drop policy if exists "creator read ledger" on public.ledger_entries;
create policy "creator read ledger" on public.ledger_entries for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read fees" on public.payment_fees;
create policy "creator read fees" on public.payment_fees for select to authenticated using (exists (select 1 from public.orders o where o.id = payment_fees.order_id and o.creator_id = auth.uid()));
drop policy if exists "creator read platform fees" on public.platform_fees;
create policy "creator read platform fees" on public.platform_fees for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read payouts" on public.payouts;
create policy "creator read payouts" on public.payouts for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read verification" on public.creator_verifications;
create policy "creator read verification" on public.creator_verifications for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read refunds" on public.refunds;
create policy "creator read refunds" on public.refunds for select to authenticated using (creator_id = auth.uid());
drop policy if exists "creator read disputes" on public.disputes;
create policy "creator read disputes" on public.disputes for select to authenticated using (creator_id = auth.uid());
drop policy if exists "owner manage domains" on public.custom_domains;
create policy "owner manage domains" on public.custom_domains for all to authenticated using (exists (select 1 from public.stores s where s.id=custom_domains.store_id and s.owner_id=auth.uid())) with check (exists (select 1 from public.stores s where s.id=custom_domains.store_id and s.owner_id=auth.uid()));

-- Reporting is public-facing submission; moderation reads are server-only.
drop policy if exists "public submit product report" on public.product_reports;
create policy "public submit product report" on public.product_reports for insert to anon, authenticated with check (true);
drop policy if exists "public submit creator report" on public.creator_reports;
create policy "public submit creator report" on public.creator_reports for insert to anon, authenticated with check (true);

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.ledger_entries, public.payment_fees, public.platform_fees, public.adjustments, public.refunds, public.payouts, public.creator_verifications, public.audit_logs, public.product_reports, public.creator_reports, public.disputes, public.custom_domains, public.security_events to service_role;
