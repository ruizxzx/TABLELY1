create extension if not exists pgcrypto;

do $$ begin
  create type staff_role as enum ('OWNER','MANAGER','WAITER','KITCHEN');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status as enum ('NEW','ACCEPTED','PREPARING','READY','SERVED','COMPLETED','CANCELLED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('PENDING','PAID','FAILED','REFUNDED');
exception when duplicate_object then null; end $$;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  address text,
  created_at timestamptz not null default now()
);

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  branch_id uuid references branches(id) on delete cascade,
  role staff_role not null default 'WAITER',
  created_at timestamptz not null default now(),
  unique(user_id, organization_id, branch_id)
);

create table if not exists tables (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  table_number integer not null,
  table_code text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(branch_id, table_number)
);

create table if not exists menu_categories (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique(branch_id, name)
);

create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  category_id uuid references menu_categories(id) on delete set null,
  name text not null,
  description text,
  price numeric(12,2) not null check(price >= 0),
  image_url text,
  is_available boolean not null default true,
  is_veg boolean,
  preparation_minutes integer,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete restrict,
  table_id uuid not null references tables(id) on delete restrict,
  status order_status not null default 'NEW',
  payment_status payment_status not null default 'PENDING',
  payment_method text,
  total numeric(12,2) not null default 0 check(total >= 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique(branch_id, idempotency_key)
);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid not null references menu_items(id) on delete restrict,
  item_name_snapshot text not null,
  unit_price numeric(12,2) not null check(unit_price >= 0),
  quantity integer not null check(quantity > 0 and quantity <= 50),
  line_total numeric(12,2) generated always as (unit_price * quantity) stored
);

create index if not exists idx_branches_org on branches(organization_id);
create index if not exists idx_staff_org on staff(organization_id);
create index if not exists idx_tables_branch on tables(branch_id);
create index if not exists idx_menu_items_branch on menu_items(branch_id);
create index if not exists idx_orders_branch_created on orders(branch_id, created_at desc);
create index if not exists idx_order_items_order on order_items(order_id);

alter table organizations enable row level security;
alter table branches enable row level security;
alter table staff enable row level security;
alter table tables enable row level security;
alter table menu_categories enable row level security;
alter table menu_items enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;

create or replace function public.is_org_member(org_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from staff s where s.organization_id = org_id and s.user_id = auth.uid())
  or exists(select 1 from organizations o where o.id = org_id and o.owner_id = auth.uid());
$$;

create or replace function public.can_access_branch(target_branch uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from branches b where b.id = target_branch and public.is_org_member(b.organization_id));
$$;

create policy org_owner_select on organizations for select using (owner_id = auth.uid() or public.is_org_member(id));
create policy org_owner_insert on organizations for insert with check (owner_id = auth.uid());
create policy org_owner_update on organizations for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy branch_access on branches for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy staff_access on staff for all using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
create policy table_access on tables for all using (public.can_access_branch(branch_id)) with check (public.can_access_branch(branch_id));
create policy category_access on menu_categories for all using (public.can_access_branch(branch_id)) with check (public.can_access_branch(branch_id));
create policy item_access on menu_items for all using (public.can_access_branch(branch_id)) with check (public.can_access_branch(branch_id));
create policy order_staff_access on orders for select using (public.can_access_branch(branch_id));
create policy order_staff_update on orders for update using (public.can_access_branch(branch_id)) with check (public.can_access_branch(branch_id));
create policy order_public_insert on orders for insert with check (exists(select 1 from tables t where t.id = table_id and t.branch_id = branch_id and t.active));
create policy order_items_access on order_items for select using (exists(select 1 from orders o where o.id = order_id and public.can_access_branch(o.branch_id)));
create policy order_items_insert on order_items for insert with check (exists(select 1 from orders o where o.id = order_id));
