-- TABLELY BUILD 35.2 — Fulfillment Hardening, Self-Pickup & Delivery Settings Fix
-- Fixes RLS table grants on branch_ordering_settings and delivery_zones,
-- resolves PostgreSQL GROUP BY syntax error in fulfillment_list_branch_orders,
-- adds atomic save_branch_ordering_settings RPC, and widens order visibility for fulfillment staff.

begin;

-- ===========================================================================
-- 1. TABLE GRANTS & RLS HARDENING FOR SETTINGS & ZONES
-- ===========================================================================

-- Grant table write access to authenticated role
grant select, insert, update on public.branch_ordering_settings to authenticated;
grant select, insert, update, delete on public.delivery_zones to authenticated;
grant select, update on public.order_fulfillment_details to authenticated;
grant select, insert on public.order_fulfillment_events to authenticated;

-- Ensure branch_ordering_settings RLS allows org owners and branch managers
drop policy if exists branch_ordering_settings_admin on public.branch_ordering_settings;
create policy branch_ordering_settings_admin on public.branch_ordering_settings
  for all to authenticated
  using (
    public.is_branch_member(branch_id)
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(branch_id, 'SETTINGS')
  )
  with check (
    public.is_branch_member(branch_id)
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(branch_id, 'SETTINGS')
  );

-- Ensure delivery_zones RLS allows org owners and branch managers
drop policy if exists delivery_zones_staff_all on public.delivery_zones;
create policy delivery_zones_staff_all on public.delivery_zones
  for all to authenticated
  using (
    public.is_branch_member(branch_id)
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
  )
  with check (
    public.is_branch_member(branch_id)
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
  );

-- ===========================================================================
-- 2. ATOMIC SETTINGS SAVE RPC
-- ===========================================================================

create or replace function public.save_branch_ordering_settings(
  p_branch_id uuid,
  p_online_ordering_enabled boolean default true,
  p_pickup_enabled boolean default true,
  p_delivery_enabled boolean default true,
  p_default_prep_minutes integer default 25,
  p_minimum_order_amount numeric default 0,
  p_pickup_packaging_fee numeric default 0,
  p_delivery_packaging_fee numeric default 0,
  p_pickup_instructions text default null,
  p_delivery_instructions text default null,
  p_cod_enabled boolean default true,
  p_upi_on_delivery_enabled boolean default true,
  p_free_delivery_threshold numeric default null
)
returns public.branch_ordering_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.branch_ordering_settings;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not (
    public.is_branch_member(p_branch_id) or
    public.current_user_has_permission_for_branch(p_branch_id, 'MANAGE_ONLINE_ORDERING') or
    public.current_user_has_permission_for_branch(p_branch_id, 'SETTINGS')
  ) then
    raise exception 'Permission denied: MANAGE_ONLINE_ORDERING required' using errcode = '42501';
  end if;

  insert into public.branch_ordering_settings (
    branch_id,
    online_ordering_enabled,
    pickup_enabled,
    delivery_enabled,
    default_prep_minutes,
    minimum_order_amount,
    pickup_packaging_fee,
    delivery_packaging_fee,
    pickup_settings,
    delivery_settings,
    updated_at
  ) values (
    p_branch_id,
    coalesce(p_online_ordering_enabled, true),
    coalesce(p_pickup_enabled, true),
    coalesce(p_delivery_enabled, true),
    greatest(1, coalesce(p_default_prep_minutes, 25)),
    greatest(0, coalesce(p_minimum_order_amount, 0)),
    greatest(0, coalesce(p_pickup_packaging_fee, 0)),
    greatest(0, coalesce(p_delivery_packaging_fee, 0)),
    jsonb_build_object('instructions', coalesce(nullif(trim(p_pickup_instructions), ''), 'Please show your pickup code at the counter.')),
    jsonb_build_object(
      'instructions', coalesce(nullif(trim(p_delivery_instructions), ''), 'Contact-free delivery available on request.'),
      'cod_enabled', coalesce(p_cod_enabled, true),
      'upi_on_delivery_enabled', coalesce(p_upi_on_delivery_enabled, true),
      'free_delivery_threshold', p_free_delivery_threshold
    ),
    now()
  )
  on conflict (branch_id) do update set
    online_ordering_enabled = excluded.online_ordering_enabled,
    pickup_enabled = excluded.pickup_enabled,
    delivery_enabled = excluded.delivery_enabled,
    default_prep_minutes = excluded.default_prep_minutes,
    minimum_order_amount = excluded.minimum_order_amount,
    pickup_packaging_fee = excluded.pickup_packaging_fee,
    delivery_packaging_fee = excluded.delivery_packaging_fee,
    pickup_settings = excluded.pickup_settings,
    delivery_settings = excluded.delivery_settings,
    updated_at = now()
  returning * into v_settings;

  return v_settings;
end;
$$;

grant execute on function public.save_branch_ordering_settings to authenticated;

-- ===========================================================================
-- 3. REPAIRED FULFILLMENT LIST ORDERS RPC (FIXES GROUP BY SYNTAX ERROR)
-- ===========================================================================

create or replace function public.fulfillment_list_branch_orders(
  p_branch_id uuid,
  p_type text default null
)
returns table (
  order_id uuid,
  order_number bigint,
  customer_name text,
  customer_phone text,
  fulfillment_type text,
  fulfillment_status text,
  order_status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  total numeric,
  delivery_fee numeric,
  address_snapshot jsonb,
  delivery_instructions text,
  pickup_code text,
  delivery_otp text,
  assigned_staff_id uuid,
  assigned_staff_name text,
  promised_ready_at timestamptz,
  promised_delivery_at timestamptz,
  created_at timestamptz,
  items_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not (
    public.is_branch_member(p_branch_id) or
    public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_DELIVERY') or
    public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_ONLINE_ORDERS') or
    public.current_user_has_permission_for_branch(p_branch_id, 'MANAGE_PICKUP')
  ) then
    raise exception 'Branch access denied' using errcode = '42501';
  end if;

  return query
  select
    o.id as order_id,
    o.order_number,
    coalesce(nullif(trim(ofd.customer_name_snapshot), ''), nullif(trim(o.customer_name), ''), 'Customer') as customer_name,
    coalesce(nullif(trim(ofd.customer_phone_snapshot), ''), nullif(trim(o.customer_phone), ''), '—') as customer_phone,
    coalesce(ofd.fulfillment_type, o.fulfillment_type, 'DINE_IN') as fulfillment_type,
    coalesce(ofd.fulfillment_status, case when o.fulfillment_type = 'PICKUP' then 'WAITING_FOR_PICKUP' when o.fulfillment_type = 'DELIVERY' then 'WAITING_FOR_DRIVER' else 'NOT_STARTED' end) as fulfillment_status,
    o.status as order_status,
    o.payment_status,
    o.payment_method,
    o.total,
    coalesce(ofd.delivery_fee_snapshot, 0)::numeric as delivery_fee,
    ofd.address_snapshot,
    ofd.delivery_instructions,
    ofd.pickup_code_display as pickup_code,
    ofd.delivery_otp_display as delivery_otp,
    ofd.assigned_staff_id,
    coalesce(s.display_name, (select pr.full_name from public.profiles pr where pr.id = s.user_id), 'Staff') as assigned_staff_name,
    ofd.promised_ready_at,
    ofd.promised_delivery_at,
    o.created_at,
    (select count(*)::bigint from public.order_items oi where oi.order_id = o.id) as items_count
  from public.orders o
  left join public.order_fulfillment_details ofd on ofd.order_id = o.id
  left join public.staff s on s.id = ofd.assigned_staff_id
  where o.branch_id = p_branch_id
    and (
      (p_type is null and o.fulfillment_type in ('PICKUP', 'DELIVERY')) or
      (p_type is not null and o.fulfillment_type = upper(trim(p_type)))
    )
  order by o.created_at desc
  limit 200;
end;
$$;

grant execute on function public.fulfillment_list_branch_orders(uuid, text) to authenticated;

-- ===========================================================================
-- 4. WIDEN ORDERS SELECT PERMISSION FOR FULFILLMENT STAFF
-- ===========================================================================

drop policy if exists orders_select_branch_member on public.orders;
create policy orders_select_branch_member on public.orders
for select to authenticated
using (
  public.is_branch_member(branch_id)
  and (
    public.current_user_has_permission_for_branch(branch_id, 'VIEW_ORDERS')
    or public.current_user_has_permission_for_branch(branch_id, 'KITCHEN_ACCESS')
    or public.current_user_has_permission_for_branch(branch_id, 'VIEW_ONLINE_ORDERS')
    or public.current_user_has_permission_for_branch(branch_id, 'VIEW_DELIVERY')
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_PICKUP')
  )
);

drop policy if exists order_items_select_branch_member on public.order_items;
create policy order_items_select_branch_member on public.order_items
for select to authenticated
using (
  exists (
    select 1 from public.orders o
    where o.id = order_items.order_id
      and public.is_branch_member(o.branch_id)
      and (
        public.current_user_has_permission_for_branch(o.branch_id, 'VIEW_ORDERS')
        or public.current_user_has_permission_for_branch(o.branch_id, 'KITCHEN_ACCESS')
        or public.current_user_has_permission_for_branch(o.branch_id, 'VIEW_ONLINE_ORDERS')
        or public.current_user_has_permission_for_branch(o.branch_id, 'VIEW_DELIVERY')
        or public.current_user_has_permission_for_branch(o.branch_id, 'MANAGE_PICKUP')
      )
  )
);

-- Ensure Realtime publication includes fulfillment tables
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.order_fulfillment_details;
    exception when others then
      -- table already in publication
      null;
    end;
  end if;
end;
$$;

commit;

select pg_notify('pgrst', 'reload schema');
