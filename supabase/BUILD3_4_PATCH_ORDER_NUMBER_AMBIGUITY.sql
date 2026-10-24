-- Tablely Build 3/4 repair: fix ambiguous order_number in create_order_for_table().
-- Safe to run on the existing Build 3/4 database. No DROP/CASCADE.
--
-- PostgreSQL exposes RETURNS TABLE columns as PL/pgSQL output variables. If an
-- INSERT ... RETURNING clause uses an unqualified column name such as
-- `order_number`, PostgreSQL can report:
--   column reference "order_number" is ambiguous
--
-- This version obtains the generated order id first, then reads generated values
-- through an explicitly aliased orders relation. It preserves the existing RPC
-- signature and dependent RLS policies.

create extension if not exists pgcrypto with schema extensions;

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
  from public.tables as t
  join public.branches as b on b.id = t.branch_id
  join public.organizations as o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;

  if v_table.id is null then
    raise exception 'This table QR is invalid or inactive';
  end if;
  v_branch_id := v_table.branch_id;

  if v_idempotency is not null then
    select o.* into v_existing
    from public.orders as o
    where o.branch_id = v_branch_id
      and o.idempotency_key = v_idempotency
    limit 1;

    if v_existing.id is not null then
      return query
      select v_existing.id,
             v_existing.order_number,
             v_existing.tracking_token,
             v_existing.total,
             v_existing.payment_status,
             v_existing.status;
      return;
    end if;
  end if;

  if v_payment_method not in ('PAY_NOW', 'PAY_AT_COUNTER') then
    raise exception 'Unsupported payment method';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if not (v_item ? 'menu_item_id') or not (v_item ? 'quantity') then
      raise exception 'Invalid cart item';
    end if;

    begin
      v_qty := greatest(0, least(50, (v_item ->> 'quantity')::integer));
    exception when invalid_text_representation then
      raise exception 'Invalid cart quantity';
    end;

    if v_qty <= 0 then
      raise exception 'Item quantity must be positive';
    end if;

    select m.* into v_menu
    from public.menu_items as m
    where m.id = (v_item ->> 'menu_item_id')::uuid
      and m.branch_id = v_branch_id
      and m.is_available = true;

    if v_menu.id is null then
      raise exception 'One or more items are unavailable';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(coalesce(v_item -> 'addons', '[]'::jsonb)) as requested
      where not exists (
        select 1
        from jsonb_array_elements(coalesce(v_menu.addons, '[]'::jsonb)) as a
        where a ->> 'name' = requested ->> 'name'
      )
    ) then
      raise exception 'One or more selected add-ons are invalid';
    end if;

    v_line := round((v_menu.price + coalesce((
      select sum(coalesce((a ->> 'price')::numeric, 0))
      from jsonb_array_elements(coalesce(v_item -> 'addons', '[]'::jsonb)) as requested
      join jsonb_array_elements(coalesce(v_menu.addons, '[]'::jsonb)) as a
        on a ->> 'name' = requested ->> 'name'
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
    'PENDING',
    v_payment_method,
    v_subtotal,
    0,
    0,
    v_subtotal,
    coalesce(v_idempotency, encode(extensions.gen_random_bytes(16), 'hex')),
    encode(extensions.gen_random_bytes(16), 'hex'),
    nullif(trim(coalesce(p_customer_note, '')), '')
  )
  returning id into v_order_id;

  select o.order_number, o.tracking_token
  into v_order_number, v_tracking_token
  from public.orders as o
  where o.id = v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item ->> 'quantity')::integer;

    select m.* into v_menu
    from public.menu_items as m
    where m.id = (v_item ->> 'menu_item_id')::uuid
      and m.branch_id = v_branch_id;

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
        from jsonb_array_elements(coalesce(v_item -> 'addons', '[]'::jsonb)) as requested
        join jsonb_array_elements(coalesce(v_menu.addons, '[]'::jsonb)) as a
          on a ->> 'name' = requested ->> 'name'
      ), 0),
      v_qty,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', a ->> 'name',
          'price', coalesce((a ->> 'price')::numeric, 0)
        ) order by a ->> 'name')
        from jsonb_array_elements(coalesce(v_menu.addons, '[]'::jsonb)) as a
        where exists (
          select 1
          from jsonb_array_elements(coalesce(v_item -> 'addons', '[]'::jsonb)) as requested
          where requested ->> 'name' = a ->> 'name'
        )
      ), '[]'::jsonb),
      nullif(trim(coalesce(v_item ->> 'note', '')), '')
    );
  end loop;

  return query
  select v_order_id,
         o.order_number,
         o.tracking_token,
         o.total,
         o.payment_status,
         o.status
  from public.orders as o
  where o.id = v_order_id;

exception
  when unique_violation then
    if v_idempotency is not null then
      select o.* into v_existing
      from public.orders as o
      where o.branch_id = v_branch_id
        and o.idempotency_key = v_idempotency
      limit 1;

      if v_existing.id is not null then
        return query
        select v_existing.id,
               v_existing.order_number,
               v_existing.tracking_token,
               v_existing.total,
               v_existing.payment_status,
               v_existing.status;
        return;
      end if;
    end if;
    raise;
end;
$$;

grant execute on function public.create_order_for_table(text, jsonb, text, text, text) to anon, authenticated;
alter function public.create_order_for_table(text, jsonb, text, text, text) set search_path = public;
select pg_notify('pgrst', 'reload schema');
