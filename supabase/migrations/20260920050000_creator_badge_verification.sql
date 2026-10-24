alter table public.creator_verifications
  add column if not exists verification_details jsonb not null default '{}'::jsonb,
  add column if not exists submitted_at timestamptz;

alter table public.stores
  add column if not exists verified_badge boolean not null default false;

create index if not exists creator_verifications_status_updated_idx
  on public.creator_verifications(status, updated_at desc);
