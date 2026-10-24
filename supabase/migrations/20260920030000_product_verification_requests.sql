-- Product approval queue. Creator account verification and product review are separate workflows.
create table if not exists public.product_verification_requests (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  creator_id uuid not null references public.profiles(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','verified','rejected','action_required')),
  product_snapshot jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, status)
);

create index if not exists product_verification_requests_status_idx
  on public.product_verification_requests(status, submitted_at desc);
create index if not exists product_verification_requests_creator_idx
  on public.product_verification_requests(creator_id, submitted_at desc);

alter table public.product_verification_requests enable row level security;
drop policy if exists "creators read own product verification requests" on public.product_verification_requests;
create policy "creators read own product verification requests"
  on public.product_verification_requests for select to authenticated
  using (creator_id = auth.uid());

grant select on public.product_verification_requests to authenticated;
grant select, insert, update, delete on public.product_verification_requests to service_role;
