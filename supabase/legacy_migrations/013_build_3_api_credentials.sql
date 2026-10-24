-- Sellora Build 3: creator-owned Razorpay API credentials (BYOK).
-- Stores only encrypted server-side secrets. Never grant the credential table to anon/authenticated.

create table if not exists public.payment_account_credentials (
  payment_account_id uuid primary key references public.payment_accounts(id) on delete cascade,
  key_id text not null,
  encrypted_key_secret text not null,
  encrypted_webhook_secret text,
  mode text not null default 'test' check (mode in ('test','live')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_account_credentials enable row level security;
revoke all on public.payment_account_credentials from anon, authenticated;
grant all on public.payment_account_credentials to service_role;

create index if not exists payment_account_credentials_key_id_idx on public.payment_account_credentials(key_id);

comment on table public.payment_account_credentials is 'Encrypted creator-provided payment provider credentials. Service role only.';
comment on column public.payment_account_credentials.encrypted_key_secret is 'AES-256-GCM encrypted Razorpay Key Secret; plaintext is never returned to clients.';
comment on column public.payment_account_credentials.encrypted_webhook_secret is 'AES-256-GCM encrypted Razorpay webhook signing secret; nullable for local/legacy setups.';

-- Mark existing creator-connected accounts according to the new connection method when known.
update public.payment_accounts
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('connection_method', 'api_credentials')
where payment_model = 'creator_connected'
  and provider = 'razorpay'
  and exists (select 1 from public.payment_account_credentials c where c.payment_account_id = payment_accounts.id);
