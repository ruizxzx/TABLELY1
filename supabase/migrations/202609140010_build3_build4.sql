-- TABLELY BUILD 3 + BUILD 4
-- Menu, tables, QR + public customer ordering.
-- Safe to run after the Build 2 database setup.

create extension if not exists pgcrypto;

-- ---------- Schema additions ----------
alter table public.menu_items add column if not exists is_spicy boolean not null default false;
alter table public.menu_items add column if not exists is_recommended boolean not null default false;
alter table public.menu_items add column if not exists preparation_minutes integer;
alter table public.menu_items add column if not exists addons jsonb not null default '[]'::jsonb;
alter table public.tables add column if not exists seats integer not null default 4 check (seats between 1 and 100);
alter table public.tables add column if not exists label text;

create sequence if not exists public.tablely_order_number_seq;
alter table public.orders add column if not exists order_number bigint;
alter table public.orders add column if not exists subtotal numeric(12,2) not null default 0 check (subtotal >= 0);
alter table public.orders add column if not exists tax numeric(12,2) not null default 0 check (tax >= 0);
alter table public.orders add column if not exists discount numeric(12,2) not null default 0 check (discount >= 0);
alter table public.orders add column if not exists tracking_token text;
alter table public.orders add column if not exists customer_note text;
alter table public.order_items add column if not exists selected_addons jsonb not null default '[]'::jsonb;
alter table public.order_items add column if not exists special_instructions text;

update public.orders
set order_number = nextval('public.tablely_order_number_seq')
where order_number is null;

alter table public.orders alter column order_number set default nextval('public.tablely_order_number_seq');
update public.orders
set tracking_token = encode(extensions.gen_random_bytes(16), 'hex')
where tracking_token is null;

select setval('public.tablely_order_number_seq', greatest(coalesce((select max(order_number) from public.orders), 0) + 1, 1), false);

alter table public.orders alter column order_number set not null;
alter table public.orders alter column tracking_token set not null;

create unique index if not exists orders_tracking_token_uidx on public.orders(tracking_token);
create unique index if not exists orders_order_number_uidx on public.orders(order_number);
create index if not exists menu_items_category_id_idx on public.menu_items(category_id);
create index if not exists menu_items_branch_available_idx on public.menu_items(branch_id, is_available);
create index if not exists tables_code_active_idx on public.tables(table_code, active);
create index if not exists orders_branch_status_idx on public.orders(branch_id, status);

-- Prevent cross-branch references if an authenticated caller tampers with IDs.
create or replace function public.validate_menu_item_category_branch()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.category_id is not null and not exists (
    select 1 from public.menu_categories c where c.id = new.category_id and c.branch_id = new.branch_id
  ) then
    raise exception 'Menu category does not belong to this branch';
  end if;
  return new;
end;
$$;

drop trigger if exists menu_item_category_branch_check on public.menu_items;
create trigger menu_item_category_branch_check
before insert or update of branch_id, category_id on public.menu_items
for each row execute function public.validate_menu_item_category_branch();

create or replace function public.validate_order_table_branch()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.tables t where t.id = new.table_id and t.branch_id = new.branch_id
  ) then
    raise exception 'Order table does not belong to this branch';
  end if;
  return new;
end;
$$;

drop trigger if exists order_table_branch_check on public.orders;
create trigger order_table_branch_check
before insert or update of branch_id, table_id on public.orders
for each row execute function public.validate_order_table_branch();

create or replace function public.validate_order_item_branch()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.orders o
    join public.menu_items m on m.id = new.menu_item_id
    where o.id = new.order_id and m.branch_id = o.branch_id
  ) then
    raise exception 'Order item does not belong to the order branch';
  end if;
  return new;
end;
$$;

drop trigger if exists order_item_branch_check on public.order_items;
create trigger order_item_branch_check
before insert or update of order_id, menu_item_id on public.order_items
for each row execute function public.validate_order_item_branch();

-- Browser clients use only RLS-protected authenticated access; anonymous users use the narrow RPCs.
grant select, insert, update, delete on public.tables to authenticated;
grant select, insert, update, delete on public.menu_categories to authenticated;
grant select, insert, update, delete on public.menu_items to authenticated;
grant select, update on public.orders to authenticated;
grant select on public.order_items to authenticated;
revoke all on public.tables, public.menu_categories, public.menu_items, public.orders, public.order_items from anon;

-- ---------- Authenticated helpers ----------
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

-- ---------- Authenticated RLS ----------
alter table public.tables enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists tables_select_branch_member on public.tables;
create policy tables_select_branch_member on public.tables
  for select using (public.is_branch_member(branch_id));

drop policy if exists tables_insert_manager on public.tables;
create policy tables_insert_manager on public.tables
  for insert with check (public.is_branch_manager_or_owner(branch_id));

drop policy if exists tables_update_manager on public.tables;
create policy tables_update_manager on public.tables
  for update using (public.is_branch_manager_or_owner(branch_id))
  with check (public.is_branch_manager_or_owner(branch_id));

drop policy if exists tables_delete_manager on public.tables;
create policy tables_delete_manager on public.tables
  for delete using (public.is_branch_manager_or_owner(branch_id));

drop policy if exists menu_categories_select_branch_member on public.menu_categories;
create policy menu_categories_select_branch_member on public.menu_categories
  for select using (public.is_branch_member(branch_id));

drop policy if exists menu_categories_insert_manager on public.menu_categories;
create policy menu_categories_insert_manager on public.menu_categories
  for insert with check (public.is_branch_manager_or_owner(branch_id));

drop policy if exists menu_categories_update_manager on public.menu_categories;
create policy menu_categories_update_manager on public.menu_categories
  for update using (public.is_branch_manager_or_owner(branch_id))
  with check (public.is_branch_manager_or_owner(branch_id));

drop policy if exists menu_categories_delete_manager on public.menu_categories;
create policy menu_categories_delete_manager on public.menu_categories
  for delete using (public.is_branch_manager_or_owner(branch_id));

drop policy if exists menu_items_select_branch_member on public.menu_items;
create policy menu_items_select_branch_member on public.menu_items
  for select using (public.is_branch_member(branch_id));

drop policy if exists menu_items_insert_manager on public.menu_items;
create policy menu_items_insert_manager on public.menu_items
  for insert with check (public.is_branch_manager_or_owner(branch_id));

drop policy if exists menu_items_update_manager on public.menu_items;
create policy menu_items_update_manager on public.menu_items
  for update using (public.is_branch_manager_or_owner(branch_id))
  with check (public.is_branch_manager_or_owner(branch_id));

drop policy if exists menu_items_delete_manager on public.menu_items;
create policy menu_items_delete_manager on public.menu_items
  for delete using (public.is_branch_manager_or_owner(branch_id));

drop policy if exists orders_select_branch_member on public.orders;
create policy orders_select_branch_member on public.orders
  for select using (public.is_branch_member(branch_id));

drop policy if exists orders_update_branch_member on public.orders;
create policy orders_update_branch_member on public.orders
  for update using (public.is_branch_member(branch_id))
  with check (public.is_branch_member(branch_id));

drop policy if exists order_items_select_branch_member on public.order_items;
create policy order_items_select_branch_member on public.order_items
  for select using (
    exists (
      select 1
      from public.orders o
      where o.id = order_items.order_id
        and public.is_branch_member(o.branch_id)
    )
  );

-- Direct inserts into orders/order_items remain disabled for authenticated browser clients.
-- Customer orders are created only through the SECURITY DEFINER RPC below.
revoke insert, delete on public.orders from authenticated;
revoke insert, update, delete on public.order_items from authenticated;

-- ---------- Public customer RPCs ----------
-- These RPCs expose only the minimum information needed by a customer.

create or replace function public.get_public_table_context(p_table_code text)
returns table (
  restaurant_name text,
  restaurant_slug text,
  branch_id uuid,
  branch_name text,
  table_id uuid,
  table_number integer,
  table_code text,
  table_label text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.name,
    o.slug,
    b.id,
    b.name,
    t.id,
    t.table_number,
    t.table_code,
    t.label
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;
$$;

create or replace function public.get_public_menu_for_table(p_table_code text)
returns table (
  category_id uuid,
  category_name text,
  category_sort integer,
  item_id uuid,
  item_name text,
  item_description text,
  item_price numeric,
  image_url text,
  is_available boolean,
  is_veg boolean,
  is_spicy boolean,
  is_recommended boolean,
  preparation_minutes integer,
  addons jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.name,
    c.sort_order,
    i.id,
    i.name,
    i.description,
    i.price,
    i.image_url,
    i.is_available,
    i.is_veg,
    i.is_spicy,
    i.is_recommended,
    i.preparation_minutes,
    i.addons
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

create or replace function public.create_order_for_table(
  p_table_code text,
  p_items jsonb,
  p_payment_method text default 'PAY_AT_COUNTER',
  p_idempotency_key text default null,
  p_customer_note text default null
)
returns table (
  order_id uuid,
  order_number bigint,
  tracking_token text,
  total numeric,
  payment_status public.payment_status,
  status public.order_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_existing public.orders%rowtype;
  v_order_id uuid;
  v_order_number bigint;
  v_tracking_token text;
  v_subtotal numeric(12,2) := 0;
  v_payment_method text := upper(trim(coalesce(p_payment_method, 'PAY_AT_COUNTER')));
  v_idempotency text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_item jsonb;
  v_menu public.menu_items%rowtype;
  v_qty integer;
  v_line numeric(12,2);
  v_branch_id uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Cart is empty';
  end if;

  select t.*
  into v_table
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;

  if v_table.id is null then
    raise exception 'This table QR is invalid or inactive';
  end if;
  v_branch_id := v_table.branch_id;

  if v_idempotency is not null then
    select * into v_existing
    from public.orders
    where branch_id = v_branch_id and idempotency_key = v_idempotency
    limit 1;
    if v_existing.id is not null then
      return query select v_existing.id, v_existing.order_number, v_existing.tracking_token,
        v_existing.total, v_existing.payment_status, v_existing.status;
      return;
    end if;
  end if;

  if v_payment_method not in ('PAY_NOW', 'PAY_AT_COUNTER') then
    raise exception 'Unsupported payment method';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if not (v_item ? 'menu_item_id') or not (v_item ? 'quantity') then
      raise exception 'Invalid cart item';
    end if;

    v_qty := greatest(0, least(50, (v_item ->> 'quantity')::integer));
    if v_qty <= 0 then
      raise exception 'Item quantity must be positive';
    end if;

    select * into v_menu
    from public.menu_items
    where id = (v_item ->> 'menu_item_id')::uuid
      and branch_id = v_branch_id
      and is_available = true;

    if v_menu.id is null then
      raise exception 'One or more items are unavailable';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(coalesce(v_item -> 'addons', '[]'::jsonb)) requested
      where not exists (
        select 1 from jsonb_array_elements(v_menu.addons) a
        where a ->> 'name' = requested ->> 'name'
      )
    ) then
      raise exception 'One or more selected add-ons are invalid';
    end if;

    v_line := round((v_menu.price + coalesce((
      select sum(coalesce((a ->> 'price')::numeric, 0))
      from jsonb_array_elements(coalesce(v_item -> 'addons', '[]'::jsonb)) requested
      join jsonb_array_elements(v_menu.addons) a on a ->> 'name' = requested ->> 'name'
    ), 0)) * v_qty, 2);
    v_subtotal := v_subtotal + v_line;
  end loop;

  insert into public.orders (
    branch_id,
    table_id,
    status,
    payment_status,
    payment_method,
    subtotal,
    tax,
    discount,
    total,
    idempotency_key,
    tracking_token,
    customer_note
  ) values (
    v_branch_id,
    v_table.id,
    'NEW',
    case when v_payment_method = 'PAY_AT_COUNTER' then 'PENDING' else 'PENDING' end,
    v_payment_method,
    v_subtotal,
    0,
    0,
    v_subtotal,
    coalesce(v_idempotency, encode(extensions.gen_random_bytes(16), 'hex')),
    encode(extensions.gen_random_bytes(16), 'hex'),
    nullif(trim(coalesce(p_customer_note, '')), '')
  )
  returning id
  into v_order_id;

  select o.order_number, o.tracking_token
  into v_order_number, v_tracking_token
  from public.orders as o
  where o.id = v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::integer;
    select * into v_menu
    from public.menu_items
    where id = (v_item ->> 'menu_item_id')::uuid
      and branch_id = v_branch_id;

    insert into public.order_items (
      order_id,
      menu_item_id,
      item_name_snapshot,
      unit_price,
      quantity,
      selected_addons,
      special_instructions
    ) values (
      v_order_id,
      v_menu.id,
      v_menu.name,
      v_menu.price + coalesce((
        select sum(coalesce((a ->> 'price')::numeric, 0))
        from jsonb_array_elements(coalesce(v_item -> 'addons', '[]'::jsonb)) requested
        join jsonb_array_elements(v_menu.addons) a on a ->> 'name' = requested ->> 'name'
      ), 0),
      v_qty,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', a ->> 'name',
          'price', coalesce((a ->> 'price')::numeric, 0)
        ) order by a ->> 'name')
        from jsonb_array_elements(v_menu.addons) a
        where exists (
          select 1 from jsonb_array_elements(coalesce(v_item -> 'addons', '[]'::jsonb)) requested
          where requested ->> 'name' = a ->> 'name'
        )
      ), '[]'::jsonb),
      nullif(trim(coalesce(v_item ->> 'note', '')), '')
    );
  end loop;

  return query
  select v_order_id, v_order_number, v_tracking_token, v_subtotal,
    (select payment_status from public.orders where id = v_order_id),
    (select status from public.orders where id = v_order_id);
exception
  when unique_violation then
    if v_idempotency is not null then
      select * into v_existing from public.orders where branch_id = v_branch_id and idempotency_key = v_idempotency limit 1;
      if v_existing.id is not null then
        return query select v_existing.id, v_existing.order_number, v_existing.tracking_token,
          v_existing.total, v_existing.payment_status, v_existing.status;
        return;
      end if;
    end if;
    raise;
end;
$$;

create or replace function public.get_public_order(p_tracking_token text)
returns table (
  order_id uuid,
  order_number bigint,
  restaurant_name text,
  table_number integer,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  subtotal numeric,
  tax numeric,
  discount numeric,
  total numeric,
  created_at timestamptz,
  item_id uuid,
  item_name text,
  quantity integer,
  unit_price numeric,
  line_total numeric,
  selected_addons jsonb,
  special_instructions text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.order_number,
    org.name,
    t.table_number,
    o.status,
    o.payment_status,
    o.payment_method,
    o.subtotal,
    o.tax,
    o.discount,
    o.total,
    o.created_at,
    oi.id,
    oi.item_name_snapshot,
    oi.quantity,
    oi.unit_price,
    oi.line_total,
    oi.selected_addons,
    oi.special_instructions
  from public.orders o
  join public.tables t on t.id = o.table_id
  join public.branches b on b.id = o.branch_id
  join public.organizations org on org.id = b.organization_id
  left join public.order_items oi on oi.order_id = o.id
  where o.tracking_token = trim(p_tracking_token)
  order by oi.id asc;
$$;

grant execute on function public.get_public_table_context(text) to anon, authenticated;
grant execute on function public.get_public_menu_for_table(text) to anon, authenticated;
grant execute on function public.create_order_for_table(text, jsonb, text, text, text) to anon, authenticated;
grant execute on function public.get_public_order(text) to anon, authenticated;

-- Security-definer functions must never run with a caller-controlled search path.
alter function public.get_public_table_context(text) set search_path = public;
alter function public.get_public_menu_for_table(text) set search_path = public;
alter function public.create_order_for_table(text, jsonb, text, text, text) set search_path = public;
alter function public.get_public_order(text) set search_path = public;

select pg_notify('pgrst', 'reload schema');
