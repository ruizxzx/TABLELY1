-- TABLELY BUILD 35.1 — Restaurant-Managed Pickup & Delivery (Online Ordering & Fulfillment Foundation)
-- Decouples orders from tables, introduces branch ordering settings, delivery zones,
-- fulfillment details, audit events, staff delivery permissions, and server-authoritative checkout.

begin;

-- ===========================================================================
-- 1. ORDERS TABLE SCHEMA EXTENSIONS
-- ===========================================================================

-- Allow table_id to be null for PICKUP and DELIVERY orders
alter table public.orders alter column table_id drop not null;

-- Add fulfillment_type column
alter table public.orders
  add column if not exists fulfillment_type text not null default 'DINE_IN';

-- Ensure fulfillment_type check constraint exists
alter table public.orders drop constraint if exists orders_fulfillment_type_check;
alter table public.orders add constraint orders_fulfillment_type_check
  check (fulfillment_type in ('DINE_IN', 'PICKUP', 'DELIVERY'));

-- Enforce: DINE_IN requires table_id, while PICKUP and DELIVERY must have table_id null
alter table public.orders drop constraint if exists orders_table_fulfillment_check;
alter table public.orders add constraint orders_table_fulfillment_check
  check (
    (fulfillment_type = 'DINE_IN' and table_id is not null) or
    (fulfillment_type in ('PICKUP', 'DELIVERY') and table_id is null)
  );

-- Index orders by fulfillment_type for fast dashboard filtering
create index if not exists orders_branch_fulfillment_idx
  on public.orders(branch_id, fulfillment_type, created_at desc);

-- ===========================================================================
-- 2. TRIGGER UPDATES: SAFE TABLELESS ORDER INSERTION
-- ===========================================================================

-- Update build17_attach_order_session so it does NOT fail when table_id is null
create or replace function public.build17_attach_order_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  -- For PICKUP and DELIVERY, no dining table exists; skip table session logic
  if new.table_id is null then
    new.received_at := coalesce(new.received_at, now());
    return new;
  end if;

  if not exists(select 1 from public.tables where id = new.table_id and branch_id = new.branch_id) then
    raise exception 'Order table does not belong to the order branch';
  end if;

  perform 1 from public.tables where id = new.table_id for update;

  select id into v_session_id
  from public.table_sessions
  where table_id = new.table_id and status = 'ACTIVE'
  order by opened_at desc
  limit 1;

  if v_session_id is null then
    insert into public.table_sessions(branch_id, table_id, status, occupancy_count)
    values(new.branch_id, new.table_id, 'ACTIVE', 0)
    returning id into v_session_id;
  end if;

  new.table_session_id := v_session_id;
  new.received_at := coalesce(new.received_at, now());
  return new;
end;
$$;

-- Update build17_orders_sync_table_trigger so it safely handles null table_id
create or replace function public.build17_orders_sync_table_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    if old.table_id is not null then
      perform public.build17_sync_table_operational_state(old.table_id);
    end if;
  elsif old.table_id is distinct from new.table_id then
    if old.table_id is not null then
      perform public.build17_sync_table_operational_state(old.table_id);
    end if;
    if new.table_id is not null then
      perform public.build17_sync_table_operational_state(new.table_id);
    end if;
  else
    if new.table_id is not null then
      perform public.build17_sync_table_operational_state(new.table_id);
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

-- ===========================================================================
-- 3. PAYMENT ATTEMPTS EXTENSIONS
-- ===========================================================================

alter table public.payment_attempts alter column table_id drop not null;

alter table public.payment_attempts
  add column if not exists fulfillment_type text not null default 'DINE_IN',
  add column if not exists delivery_fee numeric(12,2) not null default 0 check (delivery_fee >= 0),
  add column if not exists packaging_fee numeric(12,2) not null default 0 check (packaging_fee >= 0),
  add column if not exists customer_address jsonb default null,
  add column if not exists fulfillment_metadata jsonb default null;

alter table public.payment_attempts drop constraint if exists payment_attempts_fulfillment_type_check;
alter table public.payment_attempts add constraint payment_attempts_fulfillment_type_check
  check (fulfillment_type in ('DINE_IN', 'PICKUP', 'DELIVERY'));

alter table public.payment_attempts drop constraint if exists payment_attempts_table_fulfillment_check;
alter table public.payment_attempts add constraint payment_attempts_table_fulfillment_check
  check (
    (fulfillment_type = 'DINE_IN' and table_id is not null) or
    (fulfillment_type in ('PICKUP', 'DELIVERY') and table_id is null)
  );

-- ===========================================================================
-- 4. BRANCH ORDERING SETTINGS TABLE
-- ===========================================================================

create table if not exists public.branch_ordering_settings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null unique references public.branches(id) on delete cascade,
  online_ordering_enabled boolean not null default true,
  pickup_enabled boolean not null default true,
  delivery_enabled boolean not null default true,
  manual_acceptance boolean not null default true,
  auto_accept_enabled boolean not null default false,
  default_prep_minutes integer not null default 25 check (default_prep_minutes between 5 and 180),
  minimum_order_amount numeric(12,2) not null default 0 check (minimum_order_amount >= 0),
  maximum_order_amount numeric(12,2) not null default 50000 check (maximum_order_amount >= minimum_order_amount),
  schedule_ahead_days integer not null default 3 check (schedule_ahead_days between 0 and 14),
  pickup_packaging_fee numeric(12,2) not null default 0 check (pickup_packaging_fee >= 0),
  delivery_packaging_fee numeric(12,2) not null default 0 check (delivery_packaging_fee >= 0),
  pickup_settings jsonb not null default '{"instructions":"Please show your pickup code at the counter.","slot_interval_minutes":15,"max_orders_per_slot":8}'::jsonb,
  delivery_settings jsonb not null default '{"instructions":"Contact-free delivery available on request.","cod_enabled":true,"upi_on_delivery_enabled":true,"free_delivery_threshold":null}'::jsonb,
  notification_settings jsonb not null default '{"email":true,"whatsapp":false}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.branch_ordering_settings enable row level security;
revoke all on public.branch_ordering_settings from anon, authenticated, public;

drop policy if exists branch_ordering_settings_select on public.branch_ordering_settings;
create policy branch_ordering_settings_select on public.branch_ordering_settings
  for select to authenticated
  using (public.is_branch_member(branch_id));

drop policy if exists branch_ordering_settings_admin on public.branch_ordering_settings;
create policy branch_ordering_settings_admin on public.branch_ordering_settings
  for all to authenticated
  using (
    exists (
      select 1 from public.staff s
      where s.user_id = auth.uid()
        and s.branch_id = branch_ordering_settings.branch_id
        and s.role in ('OWNER', 'MANAGER')
    )
  )
  with check (
    exists (
      select 1 from public.staff s
      where s.user_id = auth.uid()
        and s.branch_id = branch_ordering_settings.branch_id
        and s.role in ('OWNER', 'MANAGER')
    )
  );

grant select on public.branch_ordering_settings to authenticated;

-- Helper to ensure branch settings exist
create or replace function public.ensure_branch_ordering_settings(p_branch_id uuid)
returns public.branch_ordering_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.branch_ordering_settings;
begin
  select * into v_settings from public.branch_ordering_settings where branch_id = p_branch_id;
  if v_settings.id is null then
    insert into public.branch_ordering_settings(branch_id)
    values(p_branch_id)
    on conflict (branch_id) do update set updated_at = now()
    returning * into v_settings;
  end if;
  return v_settings;
end;
$$;

-- ===========================================================================
-- 5. DELIVERY ZONES TABLE
-- ===========================================================================

create table if not exists public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  supported_pin_codes text[] not null check (cardinality(supported_pin_codes) > 0),
  delivery_fee numeric(12,2) not null check (delivery_fee >= 0),
  minimum_order_amount numeric(12,2) not null default 0 check (minimum_order_amount >= 0),
  free_delivery_threshold numeric(12,2) default null check (free_delivery_threshold is null or free_delivery_threshold >= 0),
  estimated_min_minutes integer not null default 30 check (estimated_min_minutes > 0),
  estimated_max_minutes integer not null default 45 check (estimated_max_minutes >= estimated_min_minutes),
  is_active boolean not null default true,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (branch_id, name)
);

create index if not exists delivery_zones_branch_idx
  on public.delivery_zones(branch_id, is_active, priority desc);

alter table public.delivery_zones enable row level security;
revoke all on public.delivery_zones from anon, authenticated, public;

drop policy if exists delivery_zones_anon_select on public.delivery_zones;
create policy delivery_zones_anon_select on public.delivery_zones
  for select to anon, authenticated
  using (is_active = true);

drop policy if exists delivery_zones_staff_all on public.delivery_zones;
create policy delivery_zones_staff_all on public.delivery_zones
  for all to authenticated
  using (public.is_branch_member(branch_id))
  with check (
    exists (
      select 1 from public.staff s
      where s.user_id = auth.uid()
        and s.branch_id = delivery_zones.branch_id
        and s.role in ('OWNER', 'MANAGER')
    )
  );

grant select on public.delivery_zones to anon, authenticated;

-- ===========================================================================
-- 6. ORDER FULFILLMENT DETAILS TABLE
-- ===========================================================================

create table if not exists public.order_fulfillment_details (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  fulfillment_type text not null check (fulfillment_type in ('PICKUP', 'DELIVERY')),
  fulfillment_status text not null default 'NOT_STARTED' check (
    fulfillment_status in (
      'NOT_STARTED',
      'WAITING_FOR_PICKUP',
      'PICKED_UP',
      'WAITING_FOR_DRIVER',
      'ASSIGNED',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'DELIVERY_FAILED',
      'RETURNED_TO_RESTAURANT'
    )
  ),
  scheduled_for timestamptz default null,
  promised_ready_at timestamptz default null,
  promised_delivery_at timestamptz default null,
  customer_name_snapshot text not null,
  customer_phone_snapshot text not null,
  customer_email_snapshot text default null,
  address_snapshot jsonb default null,
  delivery_zone_id uuid references public.delivery_zones(id) on delete set null,
  delivery_fee_snapshot numeric(12,2) not null default 0 check (delivery_fee_snapshot >= 0),
  packaging_fee_snapshot numeric(12,2) not null default 0 check (packaging_fee_snapshot >= 0),
  delivery_instructions text default null,
  pickup_code_display text default null,
  delivery_otp_display text default null,
  assigned_staff_id uuid references public.staff(id) on delete set null,
  accepted_at timestamptz default null,
  ready_at timestamptz default null,
  assigned_at timestamptz default null,
  dispatched_at timestamptz default null,
  picked_up_at timestamptz default null,
  delivered_at timestamptz default null,
  failed_at timestamptz default null,
  failure_reason text default null,
  payment_collected_at timestamptz default null,
  payment_collected_by uuid references public.staff(id) on delete set null,
  payment_collection_method text default null check (payment_collection_method is null or payment_collection_method in ('CASH', 'UPI')),
  payment_collected_amount numeric(12,2) default null check (payment_collected_amount is null or payment_collected_amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists order_fulfillment_branch_status_idx
  on public.order_fulfillment_details(branch_id, fulfillment_status, created_at desc);

create index if not exists order_fulfillment_rider_idx
  on public.order_fulfillment_details(assigned_staff_id, fulfillment_status)
  where assigned_staff_id is not null;

alter table public.order_fulfillment_details enable row level security;
revoke all on public.order_fulfillment_details from anon, authenticated, public;

drop policy if exists order_fulfillment_select on public.order_fulfillment_details;
create policy order_fulfillment_select on public.order_fulfillment_details
  for select to authenticated
  using (
    public.is_branch_member(branch_id) or
    assigned_staff_id in (select id from public.staff where user_id = auth.uid())
  );

grant select on public.order_fulfillment_details to authenticated;

-- ===========================================================================
-- 7. ORDER FULFILLMENT EVENTS (AUDIT TRAIL)
-- ===========================================================================

create table if not exists public.order_fulfillment_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  event_type text not null,
  from_status text default null,
  to_status text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_staff_id uuid references public.staff(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists order_fulfillment_events_order_idx
  on public.order_fulfillment_events(order_id, created_at asc);

alter table public.order_fulfillment_events enable row level security;
revoke all on public.order_fulfillment_events from anon, authenticated, public;

drop policy if exists order_fulfillment_events_select on public.order_fulfillment_events;
create policy order_fulfillment_events_select on public.order_fulfillment_events
  for select to authenticated
  using (public.is_branch_member(branch_id));

grant select on public.order_fulfillment_events to authenticated;

-- ===========================================================================
-- 8. STAFF PERMISSIONS SEED & UPDATES FOR ONLINE ORDERING & DELIVERY
-- ===========================================================================

insert into public.staff_permissions(staff_id, permission, allowed)
select s.id, p.permission, (s.role = 'OWNER')
from public.staff s
cross join (values
  ('VIEW_ONLINE_ORDERS'),
  ('MANAGE_ONLINE_ORDERING'),
  ('MANAGE_PICKUP'),
  ('VIEW_DELIVERY'),
  ('MANAGE_DELIVERY'),
  ('ASSIGN_DELIVERY'),
  ('UPDATE_DELIVERY_STATUS'),
  ('COLLECT_DELIVERY_PAYMENT'),
  ('VIEW_DELIVERY_REPORTS')
) p(permission)
where not exists (
  select 1 from public.staff_permissions sp
  where sp.staff_id = s.id and sp.permission = p.permission
);

create or replace function public.ensure_default_staff_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sensitive text[] := array[
    'BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT',
    'SUBSCRIPTION_MANAGEMENT','SETTINGS','DISCOUNTS_COUPONS',
    'INVENTORY_MANAGEMENT','INVENTORY_PURCHASE','INVENTORY_RECEIVE',
    'INVENTORY_ADJUST','INVENTORY_WASTAGE','INVENTORY_RECIPE_MANAGEMENT',
    'INVENTORY_COST_VIEW','INVENTORY_TRANSFER',
    'MANAGE_ONLINE_ORDERING','MANAGE_DELIVERY','ASSIGN_DELIVERY',
    'COLLECT_DELIVERY_PAYMENT','VIEW_DELIVERY_REPORTS'
  ];
  v_operational text[] := array[
    'VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS',
    'ANALYTICS','MENU_MANAGEMENT',
    'VIEW_ONLINE_ORDERS','MANAGE_PICKUP','VIEW_DELIVERY','UPDATE_DELIVERY_STATUS'
  ];
  v_inventory text[] := array[
    'INVENTORY_VIEW','INVENTORY_MANAGEMENT','INVENTORY_PURCHASE',
    'INVENTORY_RECEIVE','INVENTORY_ADJUST','INVENTORY_WASTAGE',
    'INVENTORY_RECIPE_MANAGEMENT','INVENTORY_COST_VIEW','INVENTORY_TRANSFER'
  ];
  v_fulfillment text[] := array[
    'VIEW_ONLINE_ORDERS','MANAGE_ONLINE_ORDERING','MANAGE_PICKUP',
    'VIEW_DELIVERY','MANAGE_DELIVERY','ASSIGN_DELIVERY',
    'UPDATE_DELIVERY_STATUS','COLLECT_DELIVERY_PAYMENT','VIEW_DELIVERY_REPORTS'
  ];
begin
  if new.role = 'OWNER' then
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, true from unnest(v_sensitive || v_operational || v_inventory || v_fulfillment) p
    on conflict (staff_id, permission) do nothing;
  else
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, true from unnest(v_operational) p
    on conflict (staff_id, permission) do nothing;
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, false from unnest(v_sensitive || v_inventory) p
    on conflict (staff_id, permission) do nothing;
  end if;
  return new;
end;
$$;

create or replace function public.set_staff_permission(
  p_staff_id uuid,
  p_permission text,
  p_allowed boolean
)
returns public.staff_permissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.staff_permissions;
  v_target public.staff%rowtype;
  v_permission text := upper(trim(coalesce(p_permission, '')));
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if v_permission not in (
    'BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT',
    'SUBSCRIPTION_MANAGEMENT','SETTINGS','DISCOUNTS_COUPONS',
    'VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS',
    'ANALYTICS','MENU_MANAGEMENT',
    'INVENTORY_VIEW','INVENTORY_MANAGEMENT','INVENTORY_PURCHASE',
    'INVENTORY_RECEIVE','INVENTORY_ADJUST','INVENTORY_WASTAGE',
    'INVENTORY_RECIPE_MANAGEMENT','INVENTORY_COST_VIEW','INVENTORY_TRANSFER',
    'VIEW_ONLINE_ORDERS','MANAGE_ONLINE_ORDERING','MANAGE_PICKUP',
    'VIEW_DELIVERY','MANAGE_DELIVERY','ASSIGN_DELIVERY',
    'UPDATE_DELIVERY_STATUS','COLLECT_DELIVERY_PAYMENT','VIEW_DELIVERY_REPORTS'
  ) then
    raise exception 'Invalid permission name: %', p_permission;
  end if;

  select * into v_target from public.staff where id = p_staff_id;
  if v_target.id is null then
    raise exception 'Staff record not found';
  end if;

  if not exists (
    select 1 from public.staff s
    where s.user_id = auth.uid()
      and s.branch_id = v_target.branch_id
      and s.role = 'OWNER'
  ) then
    raise exception 'Only the branch owner can modify staff permissions' using errcode = '42501';
  end if;

  insert into public.staff_permissions(staff_id, permission, allowed)
  values (p_staff_id, v_permission, coalesce(p_allowed, false))
  on conflict (staff_id, permission)
  do update set allowed = excluded.allowed, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- ===========================================================================
-- 9. PUBLIC STOREFRONT & CHECKOUT RPCS
-- ===========================================================================

-- 9.1 Storefront Context
create or replace function public.get_public_storefront_context(
  p_restaurant_slug text,
  p_branch_id uuid default null
)
returns table (
  restaurant_id uuid,
  restaurant_name text,
  restaurant_slug text,
  logo_url text,
  cover_url text,
  branch_id uuid,
  branch_name text,
  branch_address text,
  branch_phone text,
  online_ordering_enabled boolean,
  pickup_enabled boolean,
  delivery_enabled boolean,
  default_prep_minutes integer,
  minimum_order_amount numeric,
  pickup_packaging_fee numeric,
  delivery_packaging_fee numeric,
  pickup_settings jsonb,
  delivery_settings jsonb,
  branches jsonb,
  delivery_zones jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org public.organizations%rowtype;
  v_branch public.branches%rowtype;
  v_settings public.branch_ordering_settings;
  v_branches_json jsonb;
  v_zones_json jsonb;
begin
  select * into v_org
  from public.organizations
  where slug = trim(lower(p_restaurant_slug)) and status = 'ACTIVE'
  limit 1;

  if v_org.id is null then
    raise exception 'Restaurant not found or inactive';
  end if;

  -- Select requested branch or primary branch of the organization
  if p_branch_id is not null then
    select * into v_branch from public.branches where id = p_branch_id and organization_id = v_org.id and active = true limit 1;
  end if;
  if v_branch.id is null then
    select * into v_branch from public.branches where organization_id = v_org.id and active = true order by created_at asc limit 1;
  end if;
  if v_branch.id is null then
    raise exception 'No active branches available for online ordering';
  end if;

  v_settings := public.ensure_branch_ordering_settings(v_branch.id);

  select jsonb_agg(jsonb_build_object(
    'id', b.id,
    'name', b.name,
    'address', b.address,
    'phone', b.phone
  )) into v_branches_json
  from public.branches b
  where b.organization_id = v_org.id and b.active = true;

  select jsonb_agg(jsonb_build_object(
    'id', dz.id,
    'name', dz.name,
    'pin_codes', dz.supported_pin_codes,
    'delivery_fee', dz.delivery_fee,
    'minimum_order_amount', dz.minimum_order_amount,
    'free_delivery_threshold', dz.free_delivery_threshold,
    'estimated_min_minutes', dz.estimated_min_minutes,
    'estimated_max_minutes', dz.estimated_max_minutes
  )) into v_zones_json
  from public.delivery_zones dz
  where dz.branch_id = v_branch.id and dz.is_active = true
  order by dz.priority desc, dz.delivery_fee asc;

  return query select
    v_org.id,
    v_org.name,
    v_org.slug,
    v_org.logo_url,
    v_org.cover_image_url,
    v_branch.id,
    v_branch.name,
    v_branch.address,
    v_branch.phone,
    v_settings.online_ordering_enabled,
    v_settings.pickup_enabled,
    v_settings.delivery_enabled,
    v_settings.default_prep_minutes,
    v_settings.minimum_order_amount,
    v_settings.pickup_packaging_fee,
    v_settings.delivery_packaging_fee,
    v_settings.pickup_settings,
    v_settings.delivery_settings,
    coalesce(v_branches_json, '[]'::jsonb),
    coalesce(v_zones_json, '[]'::jsonb);
end;
$$;

grant execute on function public.get_public_storefront_context(text, uuid) to anon, authenticated;

-- 9.2 Public Menu For Branch (without requiring table QR)
create or replace function public.get_public_menu_for_branch(p_branch_id uuid)
returns table (
  category_id uuid,
  category_name text,
  category_sort integer,
  subcategory_id uuid,
  subcategory_name text,
  subcategory_sort integer,
  meal_section text,
  item_id uuid,
  item_name text,
  item_description text,
  item_price numeric,
  image_url text,
  is_available boolean,
  is_veg boolean,
  is_spicy boolean,
  is_recommended boolean,
  is_featured boolean,
  is_popular boolean,
  preparation_minutes integer,
  dietary_tags text[],
  allergens text[],
  addons jsonb,
  variants jsonb,
  modifier_groups jsonb,
  category_translations jsonb,
  subcategory_translations jsonb,
  item_translations jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    c.id as category_id,
    c.name as category_name,
    c.sort_order as category_sort,
    sc.id as subcategory_id,
    sc.name as subcategory_name,
    sc.sort_order as subcategory_sort,
    mi.meal_section,
    mi.id as item_id,
    mi.name as item_name,
    mi.description as item_description,
    mi.price as item_price,
    mi.image_url,
    mi.is_available,
    mi.is_veg,
    mi.is_spicy,
    mi.is_recommended,
    mi.is_featured,
    mi.is_popular,
    mi.preparation_minutes,
    mi.dietary_tags,
    mi.allergens,
    mi.addons,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'id', v.id,
          'name', v.name,
          'description', v.description,
          'price_delta', v.price_delta,
          'is_default', v.is_default,
          'is_available', v.is_available,
          'sort_order', v.sort_order,
          'translations', '[]'::jsonb
        ) order by v.sort_order)
        from public.menu_item_variants v
        where v.menu_item_id = mi.id and v.is_available = true
      ),
      '[]'::jsonb
    ) as variants,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'id', mg.id,
          'name', mg.name,
          'description', mg.description,
          'is_required', mg.is_required,
          'selection_mode', mg.selection_mode,
          'min_select', mg.min_select,
          'max_select', mg.max_select,
          'sort_order', mg.sort_order,
          'modifiers', coalesce(
            (
              select jsonb_agg(jsonb_build_object(
                'id', m.id,
                'name', m.name,
                'description', m.description,
                'price_delta', m.price_delta,
                'is_available', m.is_available,
                'sort_order', m.sort_order
              ) order by m.sort_order)
              from public.menu_modifiers m
              where m.group_id = mg.id and m.is_available = true
            ),
            '[]'::jsonb
          )
        ) order by mg.sort_order)
        from public.menu_modifier_groups mg
        where mg.menu_item_id = mi.id
      ),
      '[]'::jsonb
    ) as modifier_groups,
    '[]'::jsonb as category_translations,
    '[]'::jsonb as subcategory_translations,
    '[]'::jsonb as item_translations
  from public.menu_items mi
  join public.menu_categories c on c.id = mi.category_id
  left join public.menu_subcategories sc on sc.id = mi.subcategory_id
  where mi.branch_id = p_branch_id
    and mi.is_draft = false
    and mi.is_available = true
  order by c.sort_order asc, sc.sort_order asc nulls first, mi.name asc;
end;
$$;

grant execute on function public.get_public_menu_for_branch(uuid) to anon, authenticated;

-- 9.3 Fulfillment-Aware Checkout Preview
create or replace function public.preview_public_fulfillment_checkout(
  p_branch_id uuid,
  p_fulfillment_type text,
  p_items jsonb,
  p_delivery_pin_code text default null,
  p_coupon_code text default null,
  p_customer_phone text default null
)
returns table (
  subtotal numeric,
  discount numeric,
  discounted_subtotal numeric,
  tax numeric,
  additional_charges numeric,
  packaging_fee numeric,
  delivery_fee numeric,
  total numeric,
  charge_breakdown jsonb,
  coupon_id uuid,
  coupon_code text,
  discount_type text,
  discount_value numeric,
  delivery_zone_id uuid,
  delivery_zone_name text,
  estimated_min_minutes integer,
  estimated_max_minutes integer,
  is_serviceable boolean,
  serviceability_message text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.branch_ordering_settings;
  v_snapshot jsonb;
  v_subtotal numeric(12,2) := 0;
  v_discount numeric(12,2) := 0;
  v_tax numeric(12,2) := 0;
  v_additional numeric(12,2) := 0;
  v_packaging numeric(12,2) := 0;
  v_delivery numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_breakdown jsonb := '[]'::jsonb;
  v_charge record;
  v_amt numeric(12,2);
  v_coupon record;
  v_coupon_id uuid := null;
  v_coupon_code text := null;
  v_discount_type text := null;
  v_discount_value numeric := null;
  v_zone public.delivery_zones%rowtype;
  v_pin text := trim(coalesce(p_delivery_pin_code, ''));
  v_type text := upper(trim(coalesce(p_fulfillment_type, 'PICKUP')));
  v_serviceable boolean := true;
  v_message text := 'Serviceable';
  v_est_min integer := 25;
  v_est_max integer := 40;
begin
  if v_type not in ('PICKUP', 'DELIVERY') then
    raise exception 'Invalid fulfillment type: %', p_fulfillment_type;
  end if;

  v_settings := public.ensure_branch_ordering_settings(p_branch_id);

  if not v_settings.online_ordering_enabled then
    raise exception 'Online ordering is currently closed for this restaurant branch';
  end if;

  if v_type = 'PICKUP' and not v_settings.pickup_enabled then
    raise exception 'Pickup ordering is not currently offered at this branch';
  end if;

  if v_type = 'DELIVERY' and not v_settings.delivery_enabled then
    raise exception 'Delivery ordering is not currently offered at this branch';
  end if;

  -- Calculate cart items server-side using existing calculation engine
  v_snapshot := public.build16_calculate_cart(p_branch_id, p_items);
  v_subtotal := round(coalesce((select sum((x->>'line_total')::numeric) from jsonb_array_elements(v_snapshot) x), 0), 2);
  if v_subtotal <= 0 then
    raise exception 'Cart is empty';
  end if;

  -- Minimum order check from branch settings
  if v_subtotal < v_settings.minimum_order_amount then
    raise exception 'Minimum order amount is ₹%', v_settings.minimum_order_amount;
  end if;

  -- Validate coupon if provided
  if nullif(trim(coalesce(p_coupon_code, '')), '') is not null then
    begin
      select x.coupon_id, x.coupon_code, x.discount_type, x.discount_value, x.discount_amount
      into v_coupon_id, v_coupon_code, v_discount_type, v_discount_value, v_discount
      from public.build18_validate_coupon(p_branch_id, v_subtotal, v_snapshot, p_coupon_code, p_customer_phone, false) x;
    exception when others then
      v_coupon_id := null;
      v_discount := 0;
    end;
  end if;

  -- Packaging Fee
  if v_type = 'PICKUP' then
    v_packaging := coalesce(v_settings.pickup_packaging_fee, 0);
  elsif v_type = 'DELIVERY' then
    v_packaging := coalesce(v_settings.delivery_packaging_fee, 0);
  end if;

  if v_packaging > 0 then
    v_breakdown := v_breakdown || jsonb_build_object(
      'name', 'Packaging charge',
      'charge_type', 'FEE',
      'calculation_type', 'FIXED',
      'value', v_packaging,
      'amount', v_packaging
    );
  end if;

  -- Delivery Zone & Fee
  if v_type = 'DELIVERY' then
    if length(v_pin) = 0 then
      v_serviceable := false;
      v_message := 'PIN code is required for delivery validation';
    else
      select * into v_zone
      from public.delivery_zones dz
      where dz.branch_id = p_branch_id
        and dz.is_active = true
        and v_pin = any(dz.supported_pin_codes)
      order by dz.priority desc, dz.delivery_fee asc
      limit 1;

      if v_zone.id is null then
        v_serviceable := false;
        v_message := 'Delivery is not available in PIN code ' || v_pin || '. Please select Pickup.';
      else
        v_est_min := v_zone.estimated_min_minutes;
        v_est_max := v_zone.estimated_max_minutes;

        if v_zone.minimum_order_amount > 0 and v_subtotal < v_zone.minimum_order_amount then
          v_serviceable := false;
          v_message := format('Minimum delivery order for %s is ₹%s', v_zone.name, v_zone.minimum_order_amount);
        elsif v_zone.free_delivery_threshold is not null and v_subtotal >= v_zone.free_delivery_threshold then
          v_delivery := 0;
          v_breakdown := v_breakdown || jsonb_build_object(
            'name', 'Free Delivery applied',
            'charge_type', 'FEE',
            'calculation_type', 'FIXED',
            'value', 0,
            'amount', 0
          );
        else
          v_delivery := v_zone.delivery_fee;
          v_breakdown := v_breakdown || jsonb_build_object(
            'name', 'Delivery fee (' || v_zone.name || ')',
            'charge_type', 'FEE',
            'calculation_type', 'FIXED',
            'value', v_delivery,
            'amount', v_delivery
          );
        end if;
      end if;
    end if;
  else
    v_est_min := coalesce(v_settings.default_prep_minutes, 20);
    v_est_max := v_est_min + 15;
  end if;

  -- Restaurant standard charges (tax & service)
  for v_charge in
    select c.name, c.charge_type, c.calculation_type, c.value
    from public.restaurant_charge_settings c
    where c.enabled = true
      and (c.branch_id = p_branch_id or (c.branch_id is null and not exists(
        select 1 from public.restaurant_charge_settings cb
        where cb.organization_id = c.organization_id and cb.branch_id = p_branch_id
      )))
    order by c.sort_order, c.created_at
  loop
    if v_charge.calculation_type = 'PERCENT' then
      v_amt := round((v_subtotal - v_discount) * v_charge.value / 100.0, 2);
    else
      v_amt := round(v_charge.value, 2);
    end if;
    v_amt := greatest(0, v_amt);
    if v_charge.charge_type = 'TAX' then
      v_tax := v_tax + v_amt;
    else
      v_additional := v_additional + v_amt;
    end if;
    v_breakdown := v_breakdown || jsonb_build_object(
      'name', v_charge.name,
      'charge_type', v_charge.charge_type,
      'calculation_type', v_charge.calculation_type,
      'value', v_charge.value,
      'amount', v_amt
    );
  end loop;

  v_total := round(v_subtotal - v_discount + v_tax + v_additional + v_packaging + v_delivery, 2);

  return query select
    v_subtotal,
    v_discount,
    round(v_subtotal - v_discount, 2),
    round(v_tax, 2),
    round(v_additional, 2),
    round(v_packaging, 2),
    round(v_delivery, 2),
    v_total,
    v_breakdown,
    v_coupon_id,
    v_coupon_code,
    v_discount_type,
    v_discount_value,
    v_zone.id,
    v_zone.name,
    v_est_min,
    v_est_max,
    v_serviceable,
    v_message;
end;
$$;

grant execute on function public.preview_public_fulfillment_checkout(uuid, text, jsonb, text, text, text) to anon, authenticated;

-- 9.4 Create Public Fulfillment Order (Pickup or Delivery)
create or replace function public.create_public_fulfillment_order(
  p_branch_id uuid,
  p_fulfillment_type text,
  p_items jsonb,
  p_payment_method text,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_customer_address jsonb default null,
  p_delivery_pin_code text default null,
  p_delivery_instructions text default null,
  p_scheduled_for timestamptz default null,
  p_coupon_code text default null,
  p_customer_note text default null,
  p_idempotency_key text default null
)
returns table (
  order_id uuid,
  order_number bigint,
  tracking_token text,
  fulfillment_type text,
  fulfillment_status text,
  subtotal numeric,
  tax numeric,
  additional_charges numeric,
  packaging_fee numeric,
  delivery_fee numeric,
  discount numeric,
  total numeric,
  charge_breakdown jsonb,
  payment_status public.payment_status,
  status public.order_status,
  pickup_code text,
  delivery_otp text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.orders%rowtype;
  v_order public.orders%rowtype;
  v_preview record;
  v_idem text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_phone text := nullif(regexp_replace(trim(coalesce(p_customer_phone, '')), '[^0-9]', '', 'g'), '');
  v_name text := nullif(left(trim(coalesce(p_customer_name, '')), 120), '');
  v_email text := nullif(lower(trim(coalesce(p_customer_email, ''))), '');
  v_method text := upper(trim(coalesce(p_payment_method, 'PAY_AT_COUNTER')));
  v_type text := upper(trim(coalesce(p_fulfillment_type, 'PICKUP')));
  v_snapshot jsonb;
  v_item jsonb;
  v_pickup_code text := null;
  v_delivery_otp text := null;
  v_promised_ready timestamptz;
  v_promised_delivery timestamptz;
begin
  if v_name is null then
    raise exception 'Customer name is required';
  end if;
  if v_phone is null then
    raise exception 'Valid customer phone is required';
  end if;
  if length(v_phone) = 12 and left(v_phone, 2) = '91' then
    v_phone := right(v_phone, 10);
  end if;
  if length(v_phone) <> 10 or left(v_phone, 1) not in ('6','7','8','9') then
    raise exception 'Valid 10-digit Indian mobile number is required';
  end if;

  if v_type not in ('PICKUP', 'DELIVERY') then
    raise exception 'Fulfillment type must be PICKUP or DELIVERY';
  end if;

  -- Idempotency check
  if v_idem is not null then
    select * into v_existing
    from public.orders
    where branch_id = p_branch_id and idempotency_key = v_idem
    limit 1;

    if v_existing.id is not null then
      return query
      select
        v_existing.id,
        v_existing.order_number,
        v_existing.tracking_token,
        v_existing.fulfillment_type,
        ofd.fulfillment_status,
        v_existing.subtotal,
        v_existing.tax,
        v_existing.additional_charges,
        coalesce(ofd.packaging_fee_snapshot, 0),
        coalesce(ofd.delivery_fee_snapshot, 0),
        v_existing.discount,
        v_existing.total,
        v_existing.charge_breakdown,
        v_existing.payment_status,
        v_existing.status,
        ofd.pickup_code_display,
        ofd.delivery_otp_display
      from public.order_fulfillment_details ofd
      where ofd.order_id = v_existing.id;
      return;
    end if;
  end if;

  -- Calculate entire checkout server-side
  select * into v_preview
  from public.preview_public_fulfillment_checkout(
    p_branch_id,
    v_type,
    p_items,
    p_delivery_pin_code,
    p_coupon_code,
    v_phone
  );

  if not v_preview.is_serviceable then
    raise exception '%', v_preview.serviceability_message;
  end if;

  -- Generate short verification codes
  if v_type = 'PICKUP' then
    v_pickup_code := lpad(floor(random() * 9000 + 1000)::text, 4, '0');
    v_promised_ready := now() + (v_preview.estimated_min_minutes || ' minutes')::interval;
  else
    v_delivery_otp := lpad(floor(random() * 9000 + 1000)::text, 4, '0');
    v_promised_ready := now() + (greatest(15, v_preview.estimated_min_minutes - 15) || ' minutes')::interval;
    v_promised_delivery := now() + (v_preview.estimated_max_minutes || ' minutes')::interval;
  end if;

  if p_scheduled_for is not null and p_scheduled_for > now() then
    v_promised_ready := p_scheduled_for;
    if v_type = 'DELIVERY' then
      v_promised_delivery := p_scheduled_for + '30 minutes'::interval;
    end if;
  end if;

  -- Insert Order with table_id = null and correct fulfillment_type
  insert into public.orders (
    branch_id,
    table_id,
    table_session_id,
    fulfillment_type,
    status,
    payment_status,
    payment_method,
    subtotal,
    tax,
    discount,
    additional_charges,
    total,
    charge_breakdown,
    idempotency_key,
    tracking_token,
    customer_note,
    customer_name,
    customer_phone,
    coupon_id,
    coupon_code_snapshot,
    discount_type_snapshot,
    discount_value_snapshot
  ) values (
    p_branch_id,
    null,
    null,
    v_type,
    'NEW',
    'PENDING',
    v_method,
    v_preview.subtotal,
    v_preview.tax,
    v_preview.discount,
    round(v_preview.additional_charges + v_preview.packaging_fee + v_preview.delivery_fee, 2),
    v_preview.total,
    v_preview.charge_breakdown,
    coalesce(v_idem, encode(extensions.gen_random_bytes(16), 'hex')),
    encode(extensions.gen_random_bytes(16), 'hex'),
    nullif(trim(coalesce(p_customer_note, '')), ''),
    v_name,
    v_phone,
    v_preview.coupon_id,
    v_preview.coupon_code,
    v_preview.discount_type,
    v_preview.discount_value
  )
  returning * into v_order;

  -- Insert Fulfillment Details
  insert into public.order_fulfillment_details (
    order_id,
    branch_id,
    fulfillment_type,
    fulfillment_status,
    scheduled_for,
    promised_ready_at,
    promised_delivery_at,
    customer_name_snapshot,
    customer_phone_snapshot,
    customer_email_snapshot,
    address_snapshot,
    delivery_zone_id,
    delivery_fee_snapshot,
    packaging_fee_snapshot,
    delivery_instructions,
    pickup_code_display,
    delivery_otp_display
  ) values (
    v_order.id,
    p_branch_id,
    v_type,
    case when v_type = 'PICKUP' then 'WAITING_FOR_PICKUP' else 'WAITING_FOR_DRIVER' end,
    p_scheduled_for,
    v_promised_ready,
    v_promised_delivery,
    v_name,
    v_phone,
    v_email,
    p_customer_address,
    v_preview.delivery_zone_id,
    v_preview.delivery_fee,
    v_preview.packaging_fee,
    nullif(trim(coalesce(p_delivery_instructions, '')), ''),
    v_pickup_code,
    v_delivery_otp
  );

  -- Insert Initial Fulfillment Event
  insert into public.order_fulfillment_events (
    order_id,
    branch_id,
    event_type,
    from_status,
    to_status,
    metadata
  ) values (
    v_order.id,
    p_branch_id,
    'ORDER_CREATED',
    'NOT_STARTED',
    case when v_type = 'PICKUP' then 'WAITING_FOR_PICKUP' else 'WAITING_FOR_DRIVER' end,
    jsonb_build_object(
      'fulfillment_type', v_type,
      'payment_method', v_method,
      'total', v_preview.total
    )
  );

  -- Insert order items
  v_snapshot := public.build16_calculate_cart(p_branch_id, p_items);
  for v_item in select value from jsonb_array_elements(v_snapshot) loop
    insert into public.order_items (
      order_id,
      menu_item_id,
      item_name_snapshot,
      unit_price,
      quantity,
      selected_addons,
      special_instructions,
      selected_options,
      configuration_snapshot
    ) values (
      v_order.id,
      (v_item->>'menu_item_id')::uuid,
      v_item->>'item_name_snapshot',
      (v_item->>'unit_price')::numeric,
      (v_item->>'quantity')::integer,
      coalesce(v_item->'selected_addons', '[]'::jsonb),
      nullif(v_item->>'special_instructions', ''),
      coalesce(v_item->'selected_options', '[]'::jsonb),
      v_item
    );
  end loop;

  return query select
    v_order.id,
    v_order.order_number,
    v_order.tracking_token,
    v_order.fulfillment_type,
    case when v_type = 'PICKUP' then 'WAITING_FOR_PICKUP' else 'WAITING_FOR_DRIVER' end,
    v_preview.subtotal,
    v_preview.tax,
    v_preview.additional_charges,
    v_preview.packaging_fee,
    v_preview.delivery_fee,
    v_preview.discount,
    v_preview.total,
    v_preview.charge_breakdown,
    v_order.payment_status,
    v_order.status,
    v_pickup_code,
    v_delivery_otp;
end;
$$;

grant execute on function public.create_public_fulfillment_order(uuid, text, jsonb, text, text, text, text, jsonb, text, text, timestamptz, text, text, text) to anon, authenticated;

-- 9.5 Customer Order Tracking RPC (Handles Tableless Orders)
create or replace function public.get_public_fulfillment_order(p_tracking_token text)
returns table (
  order_id uuid,
  order_number bigint,
  restaurant_name text,
  branch_name text,
  branch_address text,
  branch_phone text,
  fulfillment_type text,
  fulfillment_status text,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  subtotal numeric,
  tax numeric,
  additional_charges numeric,
  discount numeric,
  total numeric,
  charge_breakdown jsonb,
  created_at timestamptz,
  scheduled_for timestamptz,
  promised_ready_at timestamptz,
  promised_delivery_at timestamptz,
  pickup_code text,
  delivery_otp text,
  delivery_address jsonb,
  delivery_instructions text,
  rejection_reason text,
  items jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_ofd public.order_fulfillment_details%rowtype;
  v_branch public.branches%rowtype;
  v_org public.organizations%rowtype;
  v_items jsonb;
begin
  select * into v_order from public.orders where tracking_token = trim(p_tracking_token) limit 1;
  if v_order.id is null then return; end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = v_order.id limit 1;
  select * into v_branch from public.branches where id = v_order.branch_id limit 1;
  select * into v_org from public.organizations where id = v_branch.organization_id limit 1;

  select jsonb_agg(jsonb_build_object(
    'id', oi.id,
    'name', oi.item_name_snapshot,
    'quantity', oi.quantity,
    'unit_price', oi.unit_price,
    'line_total', oi.line_total,
    'selected_addons', oi.selected_addons,
    'selected_options', oi.selected_options,
    'special_instructions', oi.special_instructions
  ) order by oi.id asc) into v_items
  from public.order_items oi
  where oi.order_id = v_order.id;

  return query select
    v_order.id,
    v_order.order_number,
    v_org.name,
    v_branch.name,
    v_branch.address,
    v_branch.phone,
    v_order.fulfillment_type,
    coalesce(v_ofd.fulfillment_status, 'NOT_STARTED'),
    v_order.status,
    v_order.payment_status,
    v_order.payment_method,
    v_order.subtotal,
    v_order.tax,
    v_order.additional_charges,
    v_order.discount,
    v_order.total,
    v_order.charge_breakdown,
    v_order.created_at,
    v_ofd.scheduled_for,
    v_ofd.promised_ready_at,
    v_ofd.promised_delivery_at,
    v_ofd.pickup_code_display,
    v_ofd.delivery_otp_display,
    v_ofd.address_snapshot,
    v_ofd.delivery_instructions,
    v_order.rejection_reason,
    coalesce(v_items, '[]'::jsonb);
end;
$$;

grant execute on function public.get_public_fulfillment_order(text) to anon, authenticated;

-- ===========================================================================
-- 10. RESTAURANT FULFILLMENT & DISPATCH OPERATIONS RPCS
-- ===========================================================================

-- 10.1 Assign Rider
create or replace function public.fulfillment_assign_rider(
  p_order_id uuid,
  p_staff_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_staff public.staff%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;

  if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'ASSIGN_DELIVERY') then
    raise exception 'Permission denied: ASSIGN_DELIVERY required' using errcode = '42501';
  end if;

  select * into v_staff from public.staff where id = p_staff_id and branch_id = v_ofd.branch_id;
  if v_staff.id is null then raise exception 'Staff member not found in this branch'; end if;

  update public.order_fulfillment_details
  set assigned_staff_id = p_staff_id,
      assigned_at = now(),
      fulfillment_status = 'ASSIGNED',
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata
  ) values (
    p_order_id, v_ofd.branch_id, 'RIDER_ASSIGNED', v_ofd.fulfillment_status, 'ASSIGNED',
    auth.uid(), p_staff_id, jsonb_build_object('rider_name', coalesce(v_staff.display_name, (select pr.full_name from public.profiles pr where pr.id = v_staff.user_id), 'Staff'))
  );

  return true;
end;
$$;

grant execute on function public.fulfillment_assign_rider(uuid, uuid) to authenticated;

-- 10.2 Dispatch Delivery (Out for Delivery)
create or replace function public.fulfillment_dispatch_delivery(
  p_order_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;

  if not (
    public.current_user_has_permission_for_branch(v_ofd.branch_id, 'UPDATE_DELIVERY_STATUS') or
    v_ofd.assigned_staff_id in (select id from public.staff where user_id = auth.uid())
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  update public.order_fulfillment_details
  set fulfillment_status = 'OUT_FOR_DELIVERY',
      dispatched_at = now(),
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata
  ) values (
    p_order_id, v_ofd.branch_id, 'OUT_FOR_DELIVERY', v_ofd.fulfillment_status, 'OUT_FOR_DELIVERY',
    auth.uid(), '{}'::jsonb
  );

  return true;
end;
$$;

grant execute on function public.fulfillment_dispatch_delivery(uuid) to authenticated;

-- 10.3 Confirm Delivered (with OTP or Manager Override)
create or replace function public.fulfillment_confirm_delivered(
  p_order_id uuid,
  p_delivery_otp text default null,
  p_manager_override boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;

  if p_manager_override then
    if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_DELIVERY') then
      raise exception 'Manager override requires MANAGE_DELIVERY permission' using errcode = '42501';
    end if;
  else
    if trim(coalesce(p_delivery_otp, '')) <> coalesce(v_ofd.delivery_otp_display, '') then
      raise exception 'Invalid delivery OTP entered';
    end if;
  end if;

  update public.order_fulfillment_details
  set fulfillment_status = 'DELIVERED',
      delivered_at = now(),
      updated_at = now()
  where id = v_ofd.id;

  -- If payment was already completed, complete order
  if v_order.payment_status = 'PAID' then
    perform public.transition_order_status(p_order_id, 'COMPLETED');
  end if;

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata
  ) values (
    p_order_id, v_ofd.branch_id, 'DELIVERED', v_ofd.fulfillment_status, 'DELIVERED',
    auth.uid(), jsonb_build_object('manager_override', p_manager_override)
  );

  return true;
end;
$$;

grant execute on function public.fulfillment_confirm_delivered(uuid, text, boolean) to authenticated;

-- 10.4 Confirm Pickup (with code or Manager Override)
create or replace function public.fulfillment_confirm_pickup(
  p_order_id uuid,
  p_pickup_code text default null,
  p_manager_override boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;

  if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_PICKUP') then
    raise exception 'Permission denied: MANAGE_PICKUP required' using errcode = '42501';
  end if;

  if not p_manager_override then
    if trim(coalesce(p_pickup_code, '')) <> coalesce(v_ofd.pickup_code_display, '') then
      raise exception 'Invalid pickup code entered';
    end if;
  end if;

  update public.order_fulfillment_details
  set fulfillment_status = 'PICKED_UP',
      picked_up_at = now(),
      updated_at = now()
  where id = v_ofd.id;

  -- If payment is settled, complete order
  if v_order.payment_status = 'PAID' then
    perform public.transition_order_status(p_order_id, 'COMPLETED');
  end if;

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata
  ) values (
    p_order_id, v_ofd.branch_id, 'PICKED_UP', v_ofd.fulfillment_status, 'PICKED_UP',
    auth.uid(), jsonb_build_object('manager_override', p_manager_override)
  );

  return true;
end;
$$;

grant execute on function public.fulfillment_confirm_pickup(uuid, text, boolean) to authenticated;

-- 10.5 Record Failed Delivery
create or replace function public.fulfillment_record_failed_delivery(
  p_order_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;

  if not (
    public.current_user_has_permission_for_branch(v_ofd.branch_id, 'UPDATE_DELIVERY_STATUS') or
    v_ofd.assigned_staff_id in (select id from public.staff where user_id = auth.uid())
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  update public.order_fulfillment_details
  set fulfillment_status = 'DELIVERY_FAILED',
      failed_at = now(),
      failure_reason = trim(p_reason),
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status, actor_user_id, metadata
  ) values (
    p_order_id, v_ofd.branch_id, 'DELIVERY_FAILED', v_ofd.fulfillment_status, 'DELIVERY_FAILED',
    auth.uid(), jsonb_build_object('reason', p_reason)
  );

  return true;
end;
$$;

grant execute on function public.fulfillment_record_failed_delivery(uuid, text) to authenticated;

-- 10.6 Collect COD / Pickup Payment
create or replace function public.fulfillment_collect_payment(
  p_order_id uuid,
  p_method text,
  p_amount numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_method text := upper(trim(coalesce(p_method, 'CASH')));
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if v_method not in ('CASH', 'UPI') then
    raise exception 'Payment method must be CASH or UPI';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;

  select * into v_staff from public.staff where user_id = auth.uid() and branch_id = v_order.branch_id limit 1;

  if not (
    public.current_user_has_permission_for_branch(v_order.branch_id, 'COLLECT_DELIVERY_PAYMENT') or
    public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS') or
    v_ofd.assigned_staff_id = v_staff.id
  ) then
    raise exception 'Permission denied to collect payment' using errcode = '42501';
  end if;

  if v_order.payment_status = 'PAID' then
    raise exception 'Order payment has already been settled';
  end if;

  if p_amount < v_order.total then
    raise exception 'Collected amount (₹%) cannot be less than order total (₹%)', p_amount, v_order.total;
  end if;

  update public.orders
  set payment_status = 'PAID',
      payment_method = v_method || '_ON_' || v_order.fulfillment_type,
      paid_at = now(),
      status = case when v_ofd.fulfillment_status in ('DELIVERED', 'PICKED_UP') then 'COMPLETED'::public.order_status else status end,
      updated_at = now()
  where id = p_order_id;

  update public.order_fulfillment_details
  set payment_collected_at = now(),
      payment_collected_by = v_staff.id,
      payment_collection_method = v_method,
      payment_collected_amount = p_amount,
      updated_at = now()
  where id = v_ofd.id;

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata
  ) values (
    p_order_id, v_order.branch_id, 'PAYMENT_COLLECTED', v_order.payment_status::text, 'PAID',
    auth.uid(), v_staff.id, jsonb_build_object('method', v_method, 'amount', p_amount)
  );

  return true;
end;
$$;

grant execute on function public.fulfillment_collect_payment(uuid, text, numeric) to authenticated;

-- 10.7 List My Deliveries (For Logged-In Rider)
create or replace function public.fulfillment_list_my_deliveries()
returns table (
  order_id uuid,
  order_number bigint,
  customer_name text,
  customer_phone text,
  address_snapshot jsonb,
  delivery_instructions text,
  fulfillment_status text,
  payment_status public.payment_status,
  payment_method text,
  total numeric,
  delivery_fee numeric,
  promised_delivery_at timestamptz,
  created_at timestamptz,
  items jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select s.id into v_staff_id
  from public.staff s
  where s.user_id = auth.uid()
  limit 1;

  if v_staff_id is null then return; end if;

  return query
  select
    o.id,
    o.order_number,
    ofd.customer_name_snapshot,
    ofd.customer_phone_snapshot,
    ofd.address_snapshot,
    ofd.delivery_instructions,
    ofd.fulfillment_status,
    o.payment_status,
    o.payment_method,
    o.total,
    ofd.delivery_fee_snapshot,
    ofd.promised_delivery_at,
    o.created_at,
    coalesce(
      (
        select jsonb_agg(jsonb_build_object(
          'id', oi.id,
          'name', oi.item_name_snapshot,
          'quantity', oi.quantity,
          'unit_price', oi.unit_price,
          'special_instructions', oi.special_instructions
        ))
        from public.order_items oi
        where oi.order_id = o.id
      ),
      '[]'::jsonb
    ) as items
  from public.order_fulfillment_details ofd
  join public.orders o on o.id = ofd.order_id
  where ofd.assigned_staff_id = v_staff_id
    and ofd.fulfillment_status in ('ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_FAILED')
  order by ofd.created_at desc;
end;
$$;

grant execute on function public.fulfillment_list_my_deliveries() to authenticated;

-- 10.8 List Branch Orders for Dispatch Management
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

  if not public.is_branch_member(p_branch_id) then
    raise exception 'Branch access denied' using errcode = '42501';
  end if;

  return query
  select
    o.id,
    o.order_number,
    ofd.customer_name_snapshot,
    ofd.customer_phone_snapshot,
    ofd.fulfillment_type,
    ofd.fulfillment_status,
    o.status,
    o.payment_status,
    o.payment_method,
    o.total,
    ofd.delivery_fee_snapshot,
    ofd.address_snapshot,
    ofd.delivery_instructions,
    ofd.pickup_code_display,
    ofd.delivery_otp_display,
    ofd.assigned_staff_id,
    coalesce(s.display_name, (select pr.full_name from public.profiles pr where pr.id = s.user_id), 'Staff') as assigned_staff_name,
    ofd.promised_ready_at,
    ofd.promised_delivery_at,
    o.created_at,
    count(oi.id)
  from public.order_fulfillment_details ofd
  join public.orders o on o.id = ofd.order_id
  left join public.staff s on s.id = ofd.assigned_staff_id
  left join public.order_items oi on oi.order_id = o.id
  where ofd.branch_id = p_branch_id
    and (p_type is null or ofd.fulfillment_type = upper(trim(p_type)))
  group by o.id, ofd.id, s.id
  order by o.created_at desc
  limit 200;
end;
$$;

grant execute on function public.fulfillment_list_branch_orders(uuid, text) to authenticated;

-- 10.9 Fulfillment Analytics & Performance Reports
create or replace function public.fulfillment_get_reports(
  p_branch_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  total_pickup_orders bigint,
  total_delivery_orders bigint,
  pickup_revenue numeric,
  delivery_revenue numeric,
  delivery_fees_collected numeric,
  packaging_fees_collected numeric,
  cod_collected numeric,
  upi_collected numeric,
  online_prepaid numeric,
  pending_collection numeric,
  failed_deliveries bigint,
  avg_prep_minutes numeric,
  avg_delivery_minutes numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - '30 days'::interval);
  v_to timestamptz := coalesce(p_to, now());
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  if not (
    public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_DELIVERY_REPORTS') or
    public.current_user_has_permission_for_branch(p_branch_id, 'ANALYTICS')
  ) then
    raise exception 'Permission denied: VIEW_DELIVERY_REPORTS required' using errcode = '42501';
  end if;

  return query
  select
    count(*) filter (where ofd.fulfillment_type = 'PICKUP')::bigint,
    count(*) filter (where ofd.fulfillment_type = 'DELIVERY')::bigint,
    coalesce(sum(o.total) filter (where ofd.fulfillment_type = 'PICKUP' and o.status = 'COMPLETED'), 0)::numeric,
    coalesce(sum(o.total) filter (where ofd.fulfillment_type = 'DELIVERY' and o.status = 'COMPLETED'), 0)::numeric,
    coalesce(sum(ofd.delivery_fee_snapshot) filter (where o.status = 'COMPLETED'), 0)::numeric,
    coalesce(sum(ofd.packaging_fee_snapshot) filter (where o.status = 'COMPLETED'), 0)::numeric,
    coalesce(sum(ofd.payment_collected_amount) filter (where ofd.payment_collection_method = 'CASH'), 0)::numeric,
    coalesce(sum(ofd.payment_collected_amount) filter (where ofd.payment_collection_method = 'UPI'), 0)::numeric,
    coalesce(sum(o.total) filter (where o.payment_status = 'PAID' and ofd.payment_collected_at is null), 0)::numeric,
    coalesce(sum(o.total) filter (where o.payment_status = 'PENDING' and o.status <> 'CANCELLED'), 0)::numeric,
    count(*) filter (where ofd.fulfillment_status = 'DELIVERY_FAILED')::bigint,
    round(coalesce(avg(extract(epoch from (ofd.ready_at - o.created_at)) / 60.0) filter (where ofd.ready_at is not null), 0), 1)::numeric,
    round(coalesce(avg(extract(epoch from (ofd.delivered_at - ofd.dispatched_at)) / 60.0) filter (where ofd.delivered_at is not null and ofd.dispatched_at is not null), 0), 1)::numeric
  from public.order_fulfillment_details ofd
  join public.orders o on o.id = ofd.order_id
  where ofd.branch_id = p_branch_id
    and o.created_at >= v_from
    and o.created_at <= v_to;
end;
$$;

grant execute on function public.fulfillment_get_reports(uuid, timestamptz, timestamptz) to authenticated;

commit;

select pg_notify('pgrst', 'reload schema');
