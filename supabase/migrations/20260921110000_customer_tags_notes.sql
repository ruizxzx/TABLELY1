-- Additive creator-scoped CRM metadata keyed to the existing customer email aggregate.
create table if not exists public.customer_tags (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_email text not null,
  tag text not null check (char_length(tag) between 1 and 50),
  created_at timestamptz not null default now(),
  unique(store_id, customer_email, tag)
);
create index if not exists customer_tags_store_customer_idx on public.customer_tags(store_id, customer_email);

create table if not exists public.customer_notes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_email text not null,
  note text not null check (char_length(note) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customer_notes_store_customer_idx on public.customer_notes(store_id, customer_email, created_at desc);

alter table public.customer_tags enable row level security;
alter table public.customer_notes enable row level security;
drop policy if exists "store owners manage customer tags" on public.customer_tags;
create policy "store owners manage customer tags" on public.customer_tags for all to authenticated
using (exists (select 1 from public.stores s where s.id = customer_tags.store_id and s.owner_id = (select auth.uid())))
with check (exists (select 1 from public.stores s where s.id = customer_tags.store_id and s.owner_id = (select auth.uid())));
drop policy if exists "store owners manage customer notes" on public.customer_notes;
create policy "store owners manage customer notes" on public.customer_notes for all to authenticated
using (exists (select 1 from public.stores s where s.id = customer_notes.store_id and s.owner_id = (select auth.uid())))
with check (exists (select 1 from public.stores s where s.id = customer_notes.store_id and s.owner_id = (select auth.uid())));
