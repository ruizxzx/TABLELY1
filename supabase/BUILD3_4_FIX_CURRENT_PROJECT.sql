-- TABLELY BUILD 3 + 4 CURRENT-PROJECT REPAIR / UPGRADE
-- Run this AFTER the Build 2 database is working.
-- Safe to re-run. Do NOT drop functions or use CASCADE.

create extension if not exists pgcrypto;

-- Core V3/V4 columns.
alter table public.menu_items add column if not exists is_spicy boolean not null default false;
alter table public.menu_items add column if not exists is_recommended boolean not null default false;
alter table public.menu_items add column if not exists preparation_minutes integer;
alter table public.menu_items add column if not exists addons jsonb not null default '[]'::jsonb;
alter table public.menu_items add column if not exists image_path text;
alter table public.tables add column if not exists seats integer not null default 4;
alter table public.tables add column if not exists label text;

-- Ensure safe table seat values even if the column pre-existed without a constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tables'::regclass
      and conname = 'tables_seats_check'
  ) then
    alter table public.tables add constraint tables_seats_check check (seats between 1 and 100);
  end if;
end $$;

-- Add V4 order metadata where missing.
create sequence if not exists public.tablely_order_number_seq;
alter table public.orders add column if not exists order_number bigint;
alter table public.orders add column if not exists subtotal numeric(12,2) not null default 0;
alter table public.orders add column if not exists tax numeric(12,2) not null default 0;
alter table public.orders add column if not exists discount numeric(12,2) not null default 0;
alter table public.orders add column if not exists tracking_token text;
alter table public.orders add column if not exists customer_note text;
alter table public.order_items add column if not exists selected_addons jsonb not null default '[]'::jsonb;
alter table public.order_items add column if not exists special_instructions text;

update public.orders set order_number = nextval('public.tablely_order_number_seq') where order_number is null;
update public.orders set tracking_token = encode(extensions.gen_random_bytes(16), 'hex') where tracking_token is null;
select setval('public.tablely_order_number_seq', greatest(coalesce((select max(order_number) from public.orders), 0) + 1, 1), false);
alter table public.orders alter column order_number set default nextval('public.tablely_order_number_seq');
alter table public.orders alter column order_number set not null;
alter table public.orders alter column tracking_token set not null;

create unique index if not exists orders_tracking_token_uidx on public.orders(tracking_token);
create unique index if not exists orders_order_number_uidx on public.orders(order_number);
create index if not exists menu_items_category_id_idx on public.menu_items(category_id);
create index if not exists menu_items_branch_available_idx on public.menu_items(branch_id, is_available);
create index if not exists tables_code_active_idx on public.tables(table_code, active);
create index if not exists orders_branch_status_idx on public.orders(branch_id, status);

-- Preserve dependent policies: helper signatures/parameter names are intentionally stable.
create or replace function public.is_branch_manager_or_owner(target_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff s
    where s.branch_id = target_branch
      and s.user_id = auth.uid()
      and s.role in ('OWNER'::public.staff_role, 'MANAGER'::public.staff_role)
  );
$$;

grant execute on function public.is_branch_manager_or_owner(uuid) to authenticated;

-- Authenticated RLS for restaurant data.
alter table public.tables enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists tables_select_branch_member on public.tables;
create policy tables_select_branch_member on public.tables for select using (public.is_branch_member(branch_id));
drop policy if exists tables_insert_manager on public.tables;
create policy tables_insert_manager on public.tables for insert with check (public.is_branch_manager_or_owner(branch_id));
drop policy if exists tables_update_manager on public.tables;
create policy tables_update_manager on public.tables for update using (public.is_branch_manager_or_owner(branch_id)) with check (public.is_branch_manager_or_owner(branch_id));
drop policy if exists tables_delete_manager on public.tables;
create policy tables_delete_manager on public.tables for delete using (public.is_branch_manager_or_owner(branch_id));

drop policy if exists menu_categories_select_branch_member on public.menu_categories;
create policy menu_categories_select_branch_member on public.menu_categories for select using (public.is_branch_member(branch_id));
drop policy if exists menu_categories_insert_manager on public.menu_categories;
create policy menu_categories_insert_manager on public.menu_categories for insert with check (public.is_branch_manager_or_owner(branch_id));
drop policy if exists menu_categories_update_manager on public.menu_categories;
create policy menu_categories_update_manager on public.menu_categories for update using (public.is_branch_manager_or_owner(branch_id)) with check (public.is_branch_manager_or_owner(branch_id));
drop policy if exists menu_categories_delete_manager on public.menu_categories;
create policy menu_categories_delete_manager on public.menu_categories for delete using (public.is_branch_manager_or_owner(branch_id));

drop policy if exists menu_items_select_branch_member on public.menu_items;
create policy menu_items_select_branch_member on public.menu_items for select using (public.is_branch_member(branch_id));
drop policy if exists menu_items_insert_manager on public.menu_items;
create policy menu_items_insert_manager on public.menu_items for insert with check (public.is_branch_manager_or_owner(branch_id));
drop policy if exists menu_items_update_manager on public.menu_items;
create policy menu_items_update_manager on public.menu_items for update using (public.is_branch_manager_or_owner(branch_id)) with check (public.is_branch_manager_or_owner(branch_id));
drop policy if exists menu_items_delete_manager on public.menu_items;
create policy menu_items_delete_manager on public.menu_items for delete using (public.is_branch_manager_or_owner(branch_id));

drop policy if exists orders_select_branch_member on public.orders;
create policy orders_select_branch_member on public.orders for select using (public.is_branch_member(branch_id));
drop policy if exists orders_update_branch_member on public.orders;
create policy orders_update_branch_member on public.orders for update using (public.is_branch_member(branch_id)) with check (public.is_branch_member(branch_id));
drop policy if exists order_items_select_branch_member on public.order_items;
create policy order_items_select_branch_member on public.order_items for select using (exists (select 1 from public.orders o where o.id = order_items.order_id and public.is_branch_member(o.branch_id)));

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.tables to authenticated;
grant select, insert, update, delete on public.menu_categories to authenticated;
grant select, insert, update, delete on public.menu_items to authenticated;
grant select, update on public.orders to authenticated;
grant select on public.order_items to authenticated;
revoke insert, delete on public.orders from authenticated;
revoke insert, update, delete on public.order_items from authenticated;
revoke all on public.tables, public.menu_categories, public.menu_items, public.orders, public.order_items from anon;

-- Reliable category creation for the Studio, plus default categories for existing Build 2 restaurants.
create or replace function public.create_menu_category(p_branch_id uuid, p_name text)
returns public.menu_categories
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category public.menu_categories;
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_order integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.is_branch_manager_or_owner(p_branch_id) then raise exception 'You do not have permission to manage this menu' using errcode = '42501'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then raise exception 'Category name must be between 1 and 80 characters'; end if;

  select c.* into v_category
  from public.menu_categories c
  where c.branch_id = p_branch_id and lower(c.name) = lower(v_name)
  limit 1;
  if v_category.id is not null then return v_category; end if;

  select coalesce(max(sort_order), -1) + 1 into v_order from public.menu_categories where branch_id = p_branch_id;
  insert into public.menu_categories(branch_id, name, sort_order)
  values (p_branch_id, v_name, v_order)
  returning * into v_category;
  return v_category;
end;
$$;

grant execute on function public.create_menu_category(uuid, text) to authenticated;

create or replace function public.ensure_default_menu_categories(p_branch_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_count integer := 0;
  v_defaults text[] := array['Starters','Main Course','Drinks','Desserts'];
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.is_branch_manager_or_owner(p_branch_id) then raise exception 'You do not have permission to manage this menu' using errcode = '42501'; end if;
  foreach v_name in array v_defaults loop
    perform public.create_menu_category(p_branch_id, v_name);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.ensure_default_menu_categories(uuid) to authenticated;

-- Public customer access remains narrow and does not expose tenant tables directly.
create or replace function public.get_public_table_context(p_table_code text)
returns table (restaurant_name text, restaurant_slug text, branch_id uuid, branch_name text, table_id uuid, table_number integer, table_code text, table_label text)
language sql stable security definer set search_path = public
as $$
  select o.name, o.slug, b.id, b.name, t.id, t.table_number, t.table_code, t.label
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code) and t.active = true and o.status = 'ACTIVE'::public.account_status
  limit 1;
$$;

grant execute on function public.get_public_table_context(text) to anon, authenticated;

-- Storage for menu images. Public read is intentional because customer browsers are anonymous.
insert into storage.buckets (id, name, public)
values ('menu-images', 'menu-images', true)
on conflict (id) do update set public = true;

drop policy if exists menu_images_insert_manager on storage.objects;
create policy menu_images_insert_manager on storage.objects
for insert to authenticated
with check (
  bucket_id = 'menu-images'
  and (storage.foldername(name))[1] is not null
  and public.is_branch_manager_or_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists menu_images_update_manager on storage.objects;
create policy menu_images_update_manager on storage.objects
for update to authenticated
using (
  bucket_id = 'menu-images'
  and public.is_branch_manager_or_owner(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'menu-images'
  and public.is_branch_manager_or_owner(((storage.foldername(name))[1])::uuid)
);

drop policy if exists menu_images_delete_manager on storage.objects;
create policy menu_images_delete_manager on storage.objects
for delete to authenticated
using (
  bucket_id = 'menu-images'
  and public.is_branch_manager_or_owner(((storage.foldername(name))[1])::uuid)
);

-- Fix / refresh the public menu RPC so categories are returned even when they contain zero items.
create or replace function public.get_public_menu_for_table(p_table_code text)
returns table (
  category_id uuid, category_name text, category_sort integer,
  item_id uuid, item_name text, item_description text, item_price numeric,
  image_url text, is_available boolean, is_veg boolean, is_spicy boolean,
  is_recommended boolean, preparation_minutes integer, addons jsonb
)
language sql stable security definer set search_path = public
as $$
  select c.id, c.name, c.sort_order,
    i.id, i.name, i.description, i.price, i.image_url, i.is_available,
    i.is_veg, i.is_spicy, i.is_recommended, i.preparation_minutes, i.addons
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  join public.menu_categories c on c.branch_id = b.id
  left join public.menu_items i on i.category_id = c.id and i.branch_id = b.id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  order by c.sort_order asc, c.name asc, i.name asc;
$$;

grant execute on function public.get_public_menu_for_table(text) to anon, authenticated;

-- Reapply the order/customer RPC grants from V4.
grant execute on function public.create_order_for_table(text, jsonb, text, text, text) to anon, authenticated;
grant execute on function public.get_public_order(text) to anon, authenticated;

select pg_notify('pgrst', 'reload schema');
