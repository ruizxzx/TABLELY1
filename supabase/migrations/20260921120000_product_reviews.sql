-- Customer reviews are separate from product approval history.
create table if not exists public.product_reviews (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_id uuid references public.profiles(id) on delete set null,
  customer_email text not null,
  rating integer not null check (rating between 1 and 5),
  review text not null check (char_length(review) between 10 and 2000),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  creator_response text,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, customer_email)
);
create index if not exists product_reviews_public_idx on public.product_reviews(product_id, status, created_at desc);
create index if not exists product_reviews_store_idx on public.product_reviews(store_id, status, created_at desc);

alter table public.product_reviews enable row level security;
drop policy if exists "public read approved product reviews" on public.product_reviews;
create policy "public read approved product reviews" on public.product_reviews for select to anon, authenticated using (status = 'approved');
drop policy if exists "customers read own product reviews" on public.product_reviews;
create policy "customers read own product reviews" on public.product_reviews for select to authenticated using (customer_id = (select auth.uid()));
drop policy if exists "customers create own product reviews" on public.product_reviews;
create policy "customers create own product reviews" on public.product_reviews for insert to authenticated with check (customer_id = (select auth.uid()));
drop policy if exists "store owners moderate product reviews" on public.product_reviews;
create policy "store owners moderate product reviews" on public.product_reviews for update to authenticated using (exists (select 1 from public.stores s where s.id = product_reviews.store_id and s.owner_id = (select auth.uid()))) with check (exists (select 1 from public.stores s where s.id = product_reviews.store_id and s.owner_id = (select auth.uid())));
grant select on public.product_reviews to anon, authenticated;
grant insert, update, delete on public.product_reviews to service_role;
