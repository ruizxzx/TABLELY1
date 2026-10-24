create table if not exists public.admin_staff (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  user_id uuid references auth.users(id) on delete set null,
  role text not null check (role in ('verification','content','support','billing')),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_staff_user_id_idx on public.admin_staff(user_id);
create index if not exists admin_staff_email_idx on public.admin_staff(lower(email));

alter table public.admin_staff enable row level security;
drop policy if exists admin_staff_service_only on public.admin_staff;
create policy admin_staff_service_only on public.admin_staff
  for all to anon, authenticated using (false) with check (false);
