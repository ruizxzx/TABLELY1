-- Build 28.6: server-managed AI providers, models, routing and usage.
begin;

create table if not exists public.platform_ai_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  provider_type text not null check (provider_type in ('openrouter','openai','gemini','anthropic','deepseek','groq','mistral','together','fireworks','custom')),
  protocol text not null check (protocol in ('openai','gemini','anthropic')),
  base_url text not null,
  api_version text,
  organization_id text,
  credential_encrypted text,
  credential_last_four text,
  credential_status text not null default 'missing' check (credential_status in ('missing','configured','invalid')),
  enabled boolean not null default false,
  priority integer not null default 100 check (priority between 1 and 10000),
  timeout_ms integer not null default 45000 check (timeout_ms between 1000 and 120000),
  retry_limit integer not null default 0 check (retry_limit between 0 and 3),
  max_requests_per_minute integer not null default 60 check (max_requests_per_minute between 1 and 10000),
  last_tested_at timestamptz,
  last_test_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_ai_models (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.platform_ai_providers(id) on delete cascade,
  model_key text not null,
  display_name text not null,
  capabilities jsonb not null default '{"text":true}'::jsonb,
  context_window integer check (context_window is null or context_window > 0),
  max_output_tokens integer check (max_output_tokens is null or max_output_tokens > 0),
  input_price_per_million numeric(14,6),
  output_price_per_million numeric(14,6),
  enabled boolean not null default true,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider_id, model_key)
);

create table if not exists public.platform_ai_routes (
  id uuid primary key default gen_random_uuid(),
  feature_key text not null unique,
  display_name text not null,
  primary_model_id uuid references public.platform_ai_models(id) on delete set null,
  fallback_model_ids uuid[] not null default '{}',
  enabled boolean not null default false,
  max_tokens integer not null default 4096 check (max_tokens between 1 and 200000),
  daily_request_limit integer check (daily_request_limit is null or daily_request_limit > 0),
  max_file_bytes integer not null default 15728640 check (max_file_bytes between 1 and 104857600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.platform_ai_settings (
  id boolean primary key default true check (id),
  monthly_budget numeric(14,6),
  max_daily_requests integer check (max_daily_requests is null or max_daily_requests > 0),
  max_tokens_per_request integer not null default 4096 check (max_tokens_per_request between 1 and 200000),
  max_file_bytes integer not null default 15728640 check (max_file_bytes between 1 and 104857600),
  updated_at timestamptz not null default now()
);
insert into public.platform_ai_settings(id) values(true) on conflict(id) do nothing;

create table if not exists public.platform_ai_usage_logs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  feature_key text not null,
  provider_id uuid references public.platform_ai_providers(id) on delete set null,
  model_id uuid references public.platform_ai_models(id) on delete set null,
  fallback_index integer not null default 0,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  estimated_cost numeric(14,8),
  latency_ms integer,
  succeeded boolean not null,
  error_category text,
  created_at timestamptz not null default now()
);
create index if not exists platform_ai_usage_created_idx on public.platform_ai_usage_logs(created_at desc);
create index if not exists platform_ai_usage_feature_idx on public.platform_ai_usage_logs(feature_key, created_at desc);
create index if not exists platform_ai_usage_provider_idx on public.platform_ai_usage_logs(provider_id, created_at desc);

insert into public.platform_ai_routes(feature_key, display_name, enabled)
values ('menu_extraction','Menu extraction',false), ('menu_description','Menu description generation',false),
       ('menu_translation','Menu translation',false), ('business_assistant','Business assistant',false),
       ('restaurant_analytics','Restaurant analytics',false)
on conflict(feature_key) do nothing;

alter table public.platform_ai_providers enable row level security;
alter table public.platform_ai_models enable row level security;
alter table public.platform_ai_routes enable row level security;
alter table public.platform_ai_settings enable row level security;
alter table public.platform_ai_usage_logs enable row level security;
revoke all on public.platform_ai_providers, public.platform_ai_models, public.platform_ai_routes,
  public.platform_ai_settings, public.platform_ai_usage_logs from anon, authenticated;
grant all on public.platform_ai_providers, public.platform_ai_models, public.platform_ai_routes,
  public.platform_ai_settings, public.platform_ai_usage_logs to service_role;

commit;
