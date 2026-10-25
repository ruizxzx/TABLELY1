-- TABLELY BUILD 34.1 — Inventory Foundation
-- Complete database schema for the inventory module:
--   - Ingredient master, categories, storage locations
--   - Batch tracking, stock balances, immutable movement ledger
--   - Order reservations (reserve on ACCEPTED, consume on COMPLETED)
--   - Branch inventory settings (stock mode, thresholds)
-- Extends the existing permission system — no new auth infrastructure.
-- Additive/idempotent. All prior migrations untouched.

begin;

-- ---------------------------------------------------------------------------
-- 1) Extend the existing staff permission system with 9 new inventory keys.
--    These are sensitive permissions (default OFF for non-owners), consistent
--    with the DISCOUNTS_COUPONS precedent in build18.
-- ---------------------------------------------------------------------------

-- Seed new permission rows for all existing staff.
-- Owners get all ON, non-owners get all OFF.
insert into public.staff_permissions(staff_id, permission, allowed)
select s.id, p.permission, (s.role = 'OWNER')
from public.staff s
cross join (values
  ('INVENTORY_VIEW'),
  ('INVENTORY_MANAGEMENT'),
  ('INVENTORY_PURCHASE'),
  ('INVENTORY_RECEIVE'),
  ('INVENTORY_ADJUST'),
  ('INVENTORY_WASTAGE'),
  ('INVENTORY_RECIPE_MANAGEMENT'),
  ('INVENTORY_COST_VIEW'),
  ('INVENTORY_TRANSFER')
) p(permission)
where not exists (
  select 1 from public.staff_permissions sp
  where sp.staff_id = s.id and sp.permission = p.permission
);

-- Extend the default-permissions trigger so new staff get the right defaults.
create or replace function public.ensure_default_staff_permissions()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_sensitive text[] := array[
    'BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT',
    'SUBSCRIPTION_MANAGEMENT','SETTINGS','DISCOUNTS_COUPONS',
    'INVENTORY_MANAGEMENT','INVENTORY_PURCHASE','INVENTORY_RECEIVE',
    'INVENTORY_ADJUST','INVENTORY_WASTAGE','INVENTORY_RECIPE_MANAGEMENT',
    'INVENTORY_COST_VIEW','INVENTORY_TRANSFER'
  ];
  v_operational text[] := array[
    'VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS',
    'ANALYTICS','MENU_MANAGEMENT'
  ];
  v_inventory text[] := array[
    'INVENTORY_VIEW','INVENTORY_MANAGEMENT','INVENTORY_PURCHASE',
    'INVENTORY_RECEIVE','INVENTORY_ADJUST','INVENTORY_WASTAGE',
    'INVENTORY_RECIPE_MANAGEMENT','INVENTORY_COST_VIEW','INVENTORY_TRANSFER'
  ];
begin
  if new.role = 'OWNER' then
    insert into public.staff_permissions(staff_id, permission, allowed)
    select new.id, p, true from unnest(v_sensitive || v_operational || v_inventory) p
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
drop trigger if exists staff_default_permissions on public.staff;
create trigger staff_default_permissions
  after insert on public.staff
  for each row execute function public.ensure_default_staff_permissions();

-- Extend set_staff_permission whitelist with all 9 new inventory permissions.
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
    'VIEW_ORDERS',
    'EDIT_ORDERS',
    'CANCEL_ORDERS',
    'KITCHEN_ACCESS',
    'BILLING',
    'CHARGES',
    'PAYMENTS',
    'STAFF_MANAGEMENT',
    'ANALYTICS',
    'SETTINGS',
    'MENU_MANAGEMENT',
    'BRANCH_MANAGEMENT',
    'SUBSCRIPTION_MANAGEMENT',
    'DISCOUNTS_COUPONS',
    'INVENTORY_VIEW',
    'INVENTORY_MANAGEMENT',
    'INVENTORY_PURCHASE',
    'INVENTORY_RECEIVE',
    'INVENTORY_ADJUST',
    'INVENTORY_WASTAGE',
    'INVENTORY_RECIPE_MANAGEMENT',
    'INVENTORY_COST_VIEW',
    'INVENTORY_TRANSFER'
  ) then
    raise exception 'Unsupported permission';
  end if;

  select * into v_target
  from public.staff s
  where s.id = p_staff_id
  for update;

  if v_target.id is null then
    raise exception 'Staff member not found' using errcode = 'P0002';
  end if;

  if v_target.role = 'OWNER'::public.staff_role then
    raise exception 'Owner permissions cannot be modified' using errcode = '42501';
  end if;

  if not public.can_manage_permissions(p_staff_id) then
    raise exception 'Only an authorized owner can manage advanced permissions' using errcode = '42501';
  end if;

  insert into public.staff_permissions(staff_id, permission, allowed)
  values (p_staff_id, v_permission, coalesce(p_allowed, false))
  on conflict (staff_id, permission)
  do update set allowed = excluded.allowed, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.set_staff_permission(uuid, text, boolean) to authenticated;
revoke execute on function public.set_staff_permission(uuid, text, boolean) from anon, public;

-- ---------------------------------------------------------------------------
-- 2) Inventory categories (org-scoped, editable)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id, name)
);
create index if not exists inventory_categories_org_idx
  on public.inventory_categories(organization_id);
alter table public.inventory_categories enable row level security;

create policy inventory_categories_select on public.inventory_categories
  for select to authenticated
  using (
    exists (
      select 1 from public.branches b
      where b.organization_id = inventory_categories.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_VIEW')
    )
  );

create policy inventory_categories_write on public.inventory_categories
  for all to authenticated
  using (
    public.is_org_owner(organization_id)
    or exists (
      select 1 from public.branches b
      where b.organization_id = inventory_categories.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_MANAGEMENT')
    )
  )
  with check (
    public.is_org_owner(organization_id)
    or exists (
      select 1 from public.branches b
      where b.organization_id = inventory_categories.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_MANAGEMENT')
    )
  );

grant select, insert, update, delete on public.inventory_categories to authenticated;
revoke all on public.inventory_categories from anon;

-- Seed default categories for any org that has none yet (idempotent).
-- NOTE: This only runs on-demand via the seeding function below, not for
-- existing orgs automatically, to avoid polluting organizations that never
-- use inventory. The UI will call inventory_ensure_default_categories().

-- ---------------------------------------------------------------------------
-- 3) Inventory locations (branch-scoped storage areas)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(branch_id, name)
);
create index if not exists inventory_locations_branch_idx
  on public.inventory_locations(branch_id);
create index if not exists inventory_locations_org_idx
  on public.inventory_locations(organization_id);
alter table public.inventory_locations enable row level security;

create policy inventory_locations_select on public.inventory_locations
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

create policy inventory_locations_write on public.inventory_locations
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT'));

grant select on public.inventory_locations to authenticated;
revoke all on public.inventory_locations from anon;

-- ---------------------------------------------------------------------------
-- 4) Branch inventory settings
-- ---------------------------------------------------------------------------
create table if not exists public.branch_inventory_settings (
  branch_id uuid primary key references public.branches(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- STRICT: block order acceptance on insufficient stock
  -- WARNING: allow but alert
  -- DISABLED: no stock tracking in ordering flow
  stock_mode text not null default 'WARNING'
    check (stock_mode in ('STRICT', 'WARNING', 'DISABLED')),
  -- Days before expiry to generate alerts
  expiry_alert_days_1 integer not null default 7,
  expiry_alert_days_2 integer not null default 3,
  expiry_alert_days_3 integer not null default 1,
  -- Theoretical vs actual variance threshold (% above which alert fires)
  variance_alert_threshold_pct numeric(5,2) not null default 10.00,
  -- Target food cost percentage for alerts
  target_food_cost_pct numeric(5,2),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);
create index if not exists branch_inventory_settings_org_idx
  on public.branch_inventory_settings(organization_id);
alter table public.branch_inventory_settings enable row level security;

create policy branch_inventory_settings_select on public.branch_inventory_settings
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

create policy branch_inventory_settings_write on public.branch_inventory_settings
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT'));

grant select on public.branch_inventory_settings to authenticated;
revoke all on public.branch_inventory_settings from anon;

-- ---------------------------------------------------------------------------
-- 5) Inventory items (ingredient master)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Item can be shared across branches or restricted. The owning org defines it.
  category_id uuid references public.inventory_categories(id) on delete set null,
  name text not null,
  sku text,
  description text,
  -- Canonical base unit for all inventory calculations
  -- (e.g. "g", "ml", "piece")
  base_unit text not null,
  -- Purchase unit (e.g. "kg", "L", "box")
  purchase_unit text not null,
  -- How many base_units are in 1 purchase_unit (e.g. 1 kg = 1000 g → 1000)
  purchase_unit_conversion numeric(15, 4) not null default 1
    check (purchase_unit_conversion > 0),
  -- Reorder and target thresholds (in base_unit)
  reorder_level numeric(15, 4),
  target_stock_level numeric(15, 4),
  -- Expiry and batch tracking
  track_expiry boolean not null default false,
  track_batches boolean not null default false,
  -- Preferred supplier (informational)
  preferred_supplier_id uuid, -- FK added after suppliers table
  -- Tax details (informational, for Indian GST reference)
  tax_rate_pct numeric(5, 2),
  hsn_code text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique(organization_id, name)
);
create index if not exists inventory_items_org_idx on public.inventory_items(organization_id);
create index if not exists inventory_items_category_idx on public.inventory_items(category_id);
create index if not exists inventory_items_active_idx on public.inventory_items(organization_id, is_active);
alter table public.inventory_items enable row level security;

create policy inventory_items_select on public.inventory_items
  for select to authenticated
  using (
    exists (
      select 1 from public.branches b
      where b.organization_id = inventory_items.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_VIEW')
    )
  );

create policy inventory_items_write on public.inventory_items
  for all to authenticated
  using (
    public.is_org_owner(organization_id)
    or exists (
      select 1 from public.staff s
      join public.branches b on b.organization_id = s.organization_id
      where s.user_id = auth.uid()
        and s.active = true
        and s.organization_id = inventory_items.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_MANAGEMENT')
      limit 1
    )
  )
  with check (
    public.is_org_owner(organization_id)
    or exists (
      select 1 from public.staff s
      join public.branches b on b.organization_id = s.organization_id
      where s.user_id = auth.uid()
        and s.active = true
        and s.organization_id = inventory_items.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_MANAGEMENT')
      limit 1
    )
  );

grant select on public.inventory_items to authenticated;
revoke all on public.inventory_items from anon;

-- ---------------------------------------------------------------------------
-- 6) Suppliers
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  company_name text not null,
  contact_name text,
  phone text,
  email text,
  address text,
  gstin text,
  -- Payment terms in days (e.g. 30 = Net 30)
  payment_terms_days integer,
  preferred_delivery_days text[], -- e.g. ['Monday','Wednesday','Friday']
  lead_time_days integer,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inventory_suppliers_org_idx on public.inventory_suppliers(organization_id);
alter table public.inventory_suppliers enable row level security;

create policy inventory_suppliers_select on public.inventory_suppliers
  for select to authenticated
  using (
    exists (
      select 1 from public.branches b
      where b.organization_id = inventory_suppliers.organization_id
        and (
          public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
          or public.current_user_has_permission_for_branch(b.id, 'INVENTORY_COST_VIEW')
        )
    )
  );

create policy inventory_suppliers_write on public.inventory_suppliers
  for all to authenticated
  using (
    public.is_org_owner(organization_id)
    or exists (
      select 1 from public.staff s
      join public.branches b on b.organization_id = s.organization_id
      where s.user_id = auth.uid() and s.active = true
        and s.organization_id = inventory_suppliers.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
      limit 1
    )
  )
  with check (
    public.is_org_owner(organization_id)
    or exists (
      select 1 from public.staff s
      join public.branches b on b.organization_id = s.organization_id
      where s.user_id = auth.uid() and s.active = true
        and s.organization_id = inventory_suppliers.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
      limit 1
    )
  );

grant select on public.inventory_suppliers to authenticated;
revoke all on public.inventory_suppliers from anon;

-- Now add the FK from inventory_items to inventory_suppliers
alter table public.inventory_items
  add constraint inventory_items_preferred_supplier_fk
  foreign key (preferred_supplier_id) references public.inventory_suppliers(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 7) Inventory item–supplier relationships (per-supplier prices and codes)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_item_suppliers (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  supplier_id uuid not null references public.inventory_suppliers(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Supplier's own SKU/code for this item
  supplier_item_code text,
  -- Purchase unit price in paise (integer minor units for INR arithmetic)
  unit_price_paise bigint not null check (unit_price_paise >= 0),
  -- Which unit this price applies to (should match item.purchase_unit)
  price_unit text not null,
  is_preferred boolean not null default false,
  effective_from timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(item_id, supplier_id)
);
create index if not exists inventory_item_suppliers_item_idx on public.inventory_item_suppliers(item_id);
create index if not exists inventory_item_suppliers_supplier_idx on public.inventory_item_suppliers(supplier_id);
create index if not exists inventory_item_suppliers_org_idx on public.inventory_item_suppliers(organization_id);
alter table public.inventory_item_suppliers enable row level security;

create policy inventory_item_suppliers_select on public.inventory_item_suppliers
  for select to authenticated
  using (
    exists (
      select 1 from public.branches b
      where b.organization_id = inventory_item_suppliers.organization_id
        and (
          public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
          or public.current_user_has_permission_for_branch(b.id, 'INVENTORY_COST_VIEW')
        )
    )
  );

create policy inventory_item_suppliers_write on public.inventory_item_suppliers
  for all to authenticated
  using (public.is_org_owner(organization_id) or exists (
    select 1 from public.staff s join public.branches b on b.organization_id = s.organization_id
    where s.user_id = auth.uid() and s.active = true
      and s.organization_id = inventory_item_suppliers.organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
    limit 1
  ))
  with check (public.is_org_owner(organization_id) or exists (
    select 1 from public.staff s join public.branches b on b.organization_id = s.organization_id
    where s.user_id = auth.uid() and s.active = true
      and s.organization_id = inventory_item_suppliers.organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_PURCHASE')
    limit 1
  ));

grant select on public.inventory_item_suppliers to authenticated;
revoke all on public.inventory_item_suppliers from anon;

-- ---------------------------------------------------------------------------
-- 8) Inventory batches (lot/expiry tracking per branch+location)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete cascade,
  location_id uuid references public.inventory_locations(id) on delete set null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Source GRN that created this batch (null for opening stock)
  goods_receipt_line_id uuid, -- FK added after GRN table
  batch_number text,
  -- Manufacturing and expiry dates
  manufactured_at date,
  expires_at date,
  -- Quantity tracking in base_unit
  received_qty numeric(15, 4) not null check (received_qty >= 0),
  current_qty numeric(15, 4) not null default 0 check (current_qty >= 0),
  -- Cost per base_unit in paise
  unit_cost_paise bigint not null default 0 check (unit_cost_paise >= 0),
  is_active boolean not null default true,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inventory_batches_item_branch_idx on public.inventory_batches(item_id, branch_id);
create index if not exists inventory_batches_branch_idx on public.inventory_batches(branch_id);
create index if not exists inventory_batches_location_idx on public.inventory_batches(location_id);
create index if not exists inventory_batches_expires_idx on public.inventory_batches(expires_at) where expires_at is not null;
create index if not exists inventory_batches_org_idx on public.inventory_batches(organization_id);
alter table public.inventory_batches enable row level security;

create policy inventory_batches_select on public.inventory_batches
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_COST_VIEW'));

create policy inventory_batches_write on public.inventory_batches
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_RECEIVE')
    or public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_RECEIVE')
    or public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT'));

grant select on public.inventory_batches to authenticated;
revoke all on public.inventory_batches from anon;

-- ---------------------------------------------------------------------------
-- 9) Inventory balances (per-branch, per-item snapshot cache)
--    This is a performance cache. The authoritative data is the movement ledger.
--    Never treat this as independent source of truth.
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_balances (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- All quantities in the item's base_unit
  on_hand_qty numeric(15, 4) not null default 0,
  reserved_qty numeric(15, 4) not null default 0,
  -- available = on_hand - reserved
  available_qty numeric(15, 4) not null generated always as (on_hand_qty - reserved_qty) stored,
  -- Weighted average cost per base_unit in paise
  avg_unit_cost_paise bigint not null default 0,
  -- Current valuation (on_hand_qty * avg_unit_cost_paise) in paise
  stock_value_paise bigint not null default 0,
  last_movement_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(item_id, branch_id)
);
create index if not exists inventory_balances_branch_idx on public.inventory_balances(branch_id);
create index if not exists inventory_balances_item_idx on public.inventory_balances(item_id);
create index if not exists inventory_balances_org_idx on public.inventory_balances(organization_id);
alter table public.inventory_balances enable row level security;

create policy inventory_balances_select on public.inventory_balances
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_COST_VIEW'));

-- Balances are only written by security-definer functions, not directly by clients.
-- Grant insert/update so those functions can execute without service-role.
grant select on public.inventory_balances to authenticated;
revoke all on public.inventory_balances from anon;

-- ---------------------------------------------------------------------------
-- 10) Inventory stock movements (immutable, append-only ledger)
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.inventory_movement_type as enum (
    'OPENING',        -- Initial stock entry
    'PURCHASE',       -- Stock received via GRN
    'SALE',           -- Ingredient consumed by fulfilled order
    'WASTAGE',        -- Spoilage / expiry / damage
    'ADJUSTMENT',     -- Stock count correction
    'TRANSFER_OUT',   -- Dispatched to another branch
    'TRANSFER_IN',    -- Received from another branch
    'PRODUCTION_IN',  -- Sub-recipe batch produced (increases prepared ingredient)
    'PRODUCTION_OUT', -- Raw ingredients consumed to produce sub-recipe batch
    'RETURN'          -- Goods returned to supplier
  );
exception when duplicate_object then null; end $$;

create table if not exists public.inventory_stock_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  location_id uuid references public.inventory_locations(id) on delete set null,
  batch_id uuid references public.inventory_batches(id) on delete set null,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  movement_type public.inventory_movement_type not null,
  -- Positive = stock in, Negative = stock out (in base_unit)
  qty numeric(15, 4) not null,
  unit text not null,
  -- Cost per base_unit at time of movement (in paise)
  unit_cost_paise bigint not null default 0,
  -- Total cost of this movement in paise (abs qty * unit_cost)
  total_cost_paise bigint not null default 0,
  -- Running balance after this movement (denormalized for speed)
  running_balance numeric(15, 4),
  -- Source event references (for idempotency and audit)
  source_event_type text,  -- e.g. 'ORDER', 'GRN', 'STOCK_COUNT', 'WASTAGE'
  source_event_id uuid,    -- e.g. order.id, goods_receipt.id
  -- Recipe version used for this consumption (historical costing)
  recipe_version_id uuid,  -- FK added after recipes table
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  -- Idempotency: one SALE movement per (order, item, branch)
  -- Other types use (source_event_id, item_id, movement_type) uniqueness in application logic
  unique nulls not distinct (source_event_id, item_id, branch_id, movement_type)
);

create index if not exists inventory_movements_item_branch_idx
  on public.inventory_stock_movements(item_id, branch_id, created_at desc);
create index if not exists inventory_movements_branch_idx
  on public.inventory_stock_movements(branch_id, created_at desc);
create index if not exists inventory_movements_source_idx
  on public.inventory_stock_movements(source_event_id, source_event_type);
create index if not exists inventory_movements_type_idx
  on public.inventory_stock_movements(movement_type, branch_id);
create index if not exists inventory_movements_org_idx
  on public.inventory_stock_movements(organization_id, created_at desc);

alter table public.inventory_stock_movements enable row level security;

create policy inventory_movements_select on public.inventory_stock_movements
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_COST_VIEW'));

-- Movements are NEVER updated or deleted — append-only ledger.
-- Service-role can do so only for disaster recovery with explicit DBA action.

grant select on public.inventory_stock_movements to authenticated;
revoke all on public.inventory_stock_movements from anon;

-- ---------------------------------------------------------------------------
-- 11) Order reservations (created on ACCEPTED, consumed on COMPLETED, released on CANCELLED)
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.inventory_reservation_status as enum (
    'ACTIVE',     -- Reserved, order still in-flight
    'CONSUMED',   -- Converted to actual stock movement on order completion
    'RELEASED'    -- Released because order was cancelled/rejected
  );
exception when duplicate_object then null; end $$;

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  status public.inventory_reservation_status not null default 'ACTIVE',
  -- Recipe version snapshot at time of reservation
  reserved_at timestamptz not null default now(),
  consumed_at timestamptz,  -- Set when status → CONSUMED
  released_at timestamptz,  -- Set when status → RELEASED
  -- Idempotency: one reservation record per order
  unique(order_id)
);
create index if not exists inventory_reservations_order_idx on public.inventory_reservations(order_id);
create index if not exists inventory_reservations_branch_idx on public.inventory_reservations(branch_id, status);
alter table public.inventory_reservations enable row level security;

create policy inventory_reservations_select on public.inventory_reservations
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

grant select on public.inventory_reservations to authenticated;
revoke all on public.inventory_reservations from anon;

create table if not exists public.inventory_reservation_lines (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.inventory_reservations(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete restrict,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  -- Quantity reserved in item's base_unit
  reserved_qty numeric(15, 4) not null check (reserved_qty > 0),
  unit text not null,
  -- Recipe version this line was computed from
  recipe_version_id uuid,
  -- Whether actual stock was available at time of reservation
  stock_available boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists inventory_reservation_lines_reservation_idx
  on public.inventory_reservation_lines(reservation_id);
create index if not exists inventory_reservation_lines_item_idx
  on public.inventory_reservation_lines(item_id, branch_id);
alter table public.inventory_reservation_lines enable row level security;

create policy inventory_reservation_lines_select on public.inventory_reservation_lines
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

grant select on public.inventory_reservation_lines to authenticated;
revoke all on public.inventory_reservation_lines from anon;

-- ---------------------------------------------------------------------------
-- 12) Recipes and versioning
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_recipes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Optional link to menu item; null for sub-recipes / base preparations
  menu_item_id uuid references public.menu_items(id) on delete set null,
  branch_id uuid references public.branches(id) on delete cascade,
  name text not null,
  description text,
  -- Number of servings this recipe produces
  output_servings numeric(10, 4) not null default 1 check (output_servings > 0),
  output_unit text not null default 'serving',
  -- Preparation time in minutes
  prep_time_minutes integer,
  cooking_time_minutes integer,
  instructions text,
  -- Whether this is a sub-recipe (base preparation) or a finished dish
  is_sub_recipe boolean not null default false,
  is_active boolean not null default true,
  current_version_id uuid, -- FK added after versions table
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists inventory_recipes_org_idx on public.inventory_recipes(organization_id);
create index if not exists inventory_recipes_menu_item_idx on public.inventory_recipes(menu_item_id);
create index if not exists inventory_recipes_branch_idx on public.inventory_recipes(branch_id);
alter table public.inventory_recipes enable row level security;

create policy inventory_recipes_select on public.inventory_recipes
  for select to authenticated
  using (
    exists (
      select 1 from public.branches b
      where b.organization_id = inventory_recipes.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_VIEW')
    )
  );

create policy inventory_recipes_write on public.inventory_recipes
  for all to authenticated
  using (public.is_org_owner(organization_id) or exists (
    select 1 from public.staff s join public.branches b on b.organization_id = s.organization_id
    where s.user_id = auth.uid() and s.active = true
      and s.organization_id = inventory_recipes.organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_RECIPE_MANAGEMENT')
    limit 1
  ))
  with check (public.is_org_owner(organization_id) or exists (
    select 1 from public.staff s join public.branches b on b.organization_id = s.organization_id
    where s.user_id = auth.uid() and s.active = true
      and s.organization_id = inventory_recipes.organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_RECIPE_MANAGEMENT')
    limit 1
  ));

grant select on public.inventory_recipes to authenticated;
revoke all on public.inventory_recipes from anon;

create table if not exists public.inventory_recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.inventory_recipes(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  version_number integer not null,
  -- Effective from this point; prior orders retain their version snapshot
  effective_from timestamptz not null default now(),
  -- Human-readable reason for the change
  change_reason text,
  -- Cached cost per serving at time of version creation (in paise)
  -- Recalculated when ingredient prices change; historical orders retain old snapshot
  cost_per_serving_paise bigint,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique(recipe_id, version_number)
);
create index if not exists inventory_recipe_versions_recipe_idx
  on public.inventory_recipe_versions(recipe_id, version_number desc);
alter table public.inventory_recipe_versions enable row level security;

create policy inventory_recipe_versions_select on public.inventory_recipe_versions
  for select to authenticated
  using (
    exists (
      select 1 from public.branches b
      where b.organization_id = inventory_recipe_versions.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_COST_VIEW')
    )
  );

create policy inventory_recipe_versions_write on public.inventory_recipe_versions
  for all to authenticated
  using (public.is_org_owner(organization_id) or exists (
    select 1 from public.staff s join public.branches b on b.organization_id = s.organization_id
    where s.user_id = auth.uid() and s.active = true
      and s.organization_id = inventory_recipe_versions.organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_RECIPE_MANAGEMENT')
    limit 1
  ))
  with check (public.is_org_owner(organization_id) or exists (
    select 1 from public.staff s join public.branches b on b.organization_id = s.organization_id
    where s.user_id = auth.uid() and s.active = true
      and s.organization_id = inventory_recipe_versions.organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_RECIPE_MANAGEMENT')
    limit 1
  ));

grant select on public.inventory_recipe_versions to authenticated;
revoke all on public.inventory_recipe_versions from anon;

create table if not exists public.inventory_recipe_lines (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.inventory_recipe_versions(id) on delete cascade,
  recipe_id uuid not null references public.inventory_recipes(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Either an ingredient item or a sub-recipe (not both)
  item_id uuid references public.inventory_items(id) on delete restrict,
  sub_recipe_id uuid references public.inventory_recipes(id) on delete restrict,
  -- Quantity per serving of the parent recipe (in item.base_unit or sub_recipe.output_unit)
  qty_per_serving numeric(15, 4) not null check (qty_per_serving > 0),
  unit text not null,
  -- Yield percentage: amount of usable ingredient after prep loss (0–100)
  -- e.g. 85 means 15% trimming/peeling loss → gross_qty = qty / 0.85
  yield_pct numeric(5, 2) not null default 100 check (yield_pct > 0 and yield_pct <= 100),
  -- Gross quantity needed from stock = qty_per_serving / (yield_pct / 100)
  gross_qty_per_serving numeric(15, 4) generated always as (
    qty_per_serving / (yield_pct / 100.0)
  ) stored,
  sort_order integer not null default 0,
  constraint recipe_line_has_one_source check (
    (item_id is not null and sub_recipe_id is null)
    or (item_id is null and sub_recipe_id is not null)
  )
);
create index if not exists inventory_recipe_lines_version_idx on public.inventory_recipe_lines(version_id);
create index if not exists inventory_recipe_lines_item_idx on public.inventory_recipe_lines(item_id);
create index if not exists inventory_recipe_lines_sub_recipe_idx on public.inventory_recipe_lines(sub_recipe_id);
alter table public.inventory_recipe_lines enable row level security;

create policy inventory_recipe_lines_select on public.inventory_recipe_lines
  for select to authenticated
  using (
    exists (
      select 1 from public.branches b
      where b.organization_id = inventory_recipe_lines.organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_VIEW')
    )
  );

create policy inventory_recipe_lines_write on public.inventory_recipe_lines
  for all to authenticated
  using (public.is_org_owner(organization_id) or exists (
    select 1 from public.staff s join public.branches b on b.organization_id = s.organization_id
    where s.user_id = auth.uid() and s.active = true
      and s.organization_id = inventory_recipe_lines.organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_RECIPE_MANAGEMENT')
    limit 1
  ))
  with check (public.is_org_owner(organization_id) or exists (
    select 1 from public.staff s join public.branches b on b.organization_id = s.organization_id
    where s.user_id = auth.uid() and s.active = true
      and s.organization_id = inventory_recipe_lines.organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_RECIPE_MANAGEMENT')
    limit 1
  ));

grant select on public.inventory_recipe_lines to authenticated;
revoke all on public.inventory_recipe_lines from anon;

-- Add back-reference from recipe versions FK
alter table public.inventory_recipes
  add constraint inventory_recipes_current_version_fk
  foreign key (current_version_id) references public.inventory_recipe_versions(id) on delete set null;

-- Add recipe_version_id FK to stock movements
alter table public.inventory_stock_movements
  add constraint inventory_movements_recipe_version_fk
  foreign key (recipe_version_id) references public.inventory_recipe_versions(id) on delete set null;

-- Add recipe_version_id FK to reservation lines
alter table public.inventory_reservation_lines
  add constraint inventory_reservation_lines_version_fk
  foreign key (recipe_version_id) references public.inventory_recipe_versions(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 13) Purchase orders and GRNs
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.inventory_po_status as enum (
    'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT',
    'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.inventory_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  supplier_id uuid not null references public.inventory_suppliers(id) on delete restrict,
  po_number text not null,
  status public.inventory_po_status not null default 'DRAFT',
  expected_delivery_date date,
  -- Costs in paise
  subtotal_paise bigint not null default 0,
  tax_paise bigint not null default 0,
  freight_paise bigint not null default 0,
  total_paise bigint not null default 0,
  currency text not null default 'INR',
  notes text,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  unique(organization_id, po_number)
);
create index if not exists inventory_po_branch_idx on public.inventory_purchase_orders(branch_id, status);
create index if not exists inventory_po_supplier_idx on public.inventory_purchase_orders(supplier_id);
create index if not exists inventory_po_org_idx on public.inventory_purchase_orders(organization_id);
alter table public.inventory_purchase_orders enable row level security;

create policy inventory_po_select on public.inventory_purchase_orders
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_PURCHASE'));

create policy inventory_po_write on public.inventory_purchase_orders
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_PURCHASE'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_PURCHASE'));

grant select on public.inventory_purchase_orders to authenticated;
revoke all on public.inventory_purchase_orders from anon;

create table if not exists public.inventory_purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.inventory_purchase_orders(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Ordered in purchase_unit
  ordered_qty numeric(15, 4) not null check (ordered_qty > 0),
  purchase_unit text not null,
  agreed_unit_price_paise bigint not null check (agreed_unit_price_paise >= 0),
  discount_pct numeric(5, 2) not null default 0,
  tax_pct numeric(5, 2) not null default 0,
  line_total_paise bigint not null default 0,
  notes text,
  sort_order integer not null default 0
);
create index if not exists inventory_po_lines_po_idx on public.inventory_purchase_order_lines(purchase_order_id);
create index if not exists inventory_po_lines_item_idx on public.inventory_purchase_order_lines(item_id);
alter table public.inventory_purchase_order_lines enable row level security;

create policy inventory_po_lines_select on public.inventory_purchase_order_lines
  for select to authenticated
  using (exists (
    select 1 from public.inventory_purchase_orders po
    where po.id = inventory_purchase_order_lines.purchase_order_id
      and public.current_user_has_permission_for_branch(po.branch_id, 'INVENTORY_PURCHASE')
  ));

create policy inventory_po_lines_write on public.inventory_purchase_order_lines
  for all to authenticated
  using (exists (
    select 1 from public.inventory_purchase_orders po
    where po.id = inventory_purchase_order_lines.purchase_order_id
      and public.current_user_has_permission_for_branch(po.branch_id, 'INVENTORY_PURCHASE')
  ))
  with check (exists (
    select 1 from public.inventory_purchase_orders po
    where po.id = inventory_purchase_order_lines.purchase_order_id
      and public.current_user_has_permission_for_branch(po.branch_id, 'INVENTORY_PURCHASE')
  ));

grant select on public.inventory_purchase_order_lines to authenticated;
revoke all on public.inventory_purchase_order_lines from anon;

-- Goods Received Notes
do $$ begin
  create type public.inventory_grn_status as enum (
    'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.inventory_goods_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  purchase_order_id uuid references public.inventory_purchase_orders(id) on delete set null,
  supplier_id uuid references public.inventory_suppliers(id) on delete set null,
  grn_number text not null,
  status public.inventory_grn_status not null default 'DRAFT',
  received_date date not null default current_date,
  supplier_invoice_number text,
  supplier_invoice_date date,
  -- Invoice attachment (stored in private Supabase storage)
  invoice_attachment_path text,
  notes text,
  -- Total value of accepted goods in paise
  total_accepted_value_paise bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  unique(organization_id, grn_number)
);
create index if not exists inventory_grn_branch_idx on public.inventory_goods_receipts(branch_id, status);
create index if not exists inventory_grn_po_idx on public.inventory_goods_receipts(purchase_order_id);
create index if not exists inventory_grn_org_idx on public.inventory_goods_receipts(organization_id);
alter table public.inventory_goods_receipts enable row level security;

create policy inventory_grn_select on public.inventory_goods_receipts
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_RECEIVE'));

create policy inventory_grn_write on public.inventory_goods_receipts
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_RECEIVE'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_RECEIVE'));

grant select on public.inventory_goods_receipts to authenticated;
revoke all on public.inventory_goods_receipts from anon;

create table if not exists public.inventory_goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null references public.inventory_goods_receipts(id) on delete cascade,
  po_line_id uuid references public.inventory_purchase_order_lines(id) on delete set null,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  location_id uuid references public.inventory_locations(id) on delete set null,
  -- All quantities in purchase_unit
  ordered_qty numeric(15, 4),
  received_qty numeric(15, 4) not null check (received_qty >= 0),
  damaged_qty numeric(15, 4) not null default 0 check (damaged_qty >= 0),
  accepted_qty numeric(15, 4) not null check (accepted_qty >= 0),
  purchase_unit text not null,
  -- Actual cost paid (may differ from PO agreed price)
  actual_unit_price_paise bigint not null check (actual_unit_price_paise >= 0),
  line_total_paise bigint not null default 0,
  batch_number text,
  manufactured_at date,
  expires_at date,
  notes text,
  -- Stock was added when this GRN line was approved
  stock_movement_id uuid references public.inventory_stock_movements(id) on delete set null
);
create index if not exists inventory_grn_lines_grn_idx on public.inventory_goods_receipt_lines(goods_receipt_id);
create index if not exists inventory_grn_lines_item_idx on public.inventory_goods_receipt_lines(item_id);
alter table public.inventory_goods_receipt_lines enable row level security;

create policy inventory_grn_lines_select on public.inventory_goods_receipt_lines
  for select to authenticated
  using (exists (
    select 1 from public.inventory_goods_receipts grn
    where grn.id = inventory_goods_receipt_lines.goods_receipt_id
      and public.current_user_has_permission_for_branch(grn.branch_id, 'INVENTORY_RECEIVE')
  ));

create policy inventory_grn_lines_write on public.inventory_goods_receipt_lines
  for all to authenticated
  using (exists (
    select 1 from public.inventory_goods_receipts grn
    where grn.id = inventory_goods_receipt_lines.goods_receipt_id
      and public.current_user_has_permission_for_branch(grn.branch_id, 'INVENTORY_RECEIVE')
  ))
  with check (exists (
    select 1 from public.inventory_goods_receipts grn
    where grn.id = inventory_goods_receipt_lines.goods_receipt_id
      and public.current_user_has_permission_for_branch(grn.branch_id, 'INVENTORY_RECEIVE')
  ));

grant select on public.inventory_goods_receipt_lines to authenticated;
revoke all on public.inventory_goods_receipt_lines from anon;

-- Add GRN line FK to batches
alter table public.inventory_batches
  add constraint inventory_batches_grn_line_fk
  foreign key (goods_receipt_line_id) references public.inventory_goods_receipt_lines(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 14) Wastage
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_wastage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  batch_id uuid references public.inventory_batches(id) on delete set null,
  location_id uuid references public.inventory_locations(id) on delete set null,
  -- Quantity wasted in item's base_unit
  qty numeric(15, 4) not null check (qty > 0),
  unit text not null,
  -- Cost of wasted stock in paise
  cost_paise bigint not null default 0,
  reason text not null, -- e.g. 'EXPIRED', 'SPOILED', 'BURNT', 'SPILLED', 'DAMAGED', 'STAFF_MEAL', 'OTHER'
  notes text,
  -- Optional photograph stored in private storage
  photo_path text,
  -- Requires manager approval above a threshold
  requires_approval boolean not null default false,
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  -- Links to the resulting stock movement
  stock_movement_id uuid references public.inventory_stock_movements(id) on delete set null,
  wastage_date date not null default current_date,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists inventory_wastage_branch_idx on public.inventory_wastage(branch_id, wastage_date desc);
create index if not exists inventory_wastage_item_idx on public.inventory_wastage(item_id);
create index if not exists inventory_wastage_org_idx on public.inventory_wastage(organization_id, wastage_date desc);
alter table public.inventory_wastage enable row level security;

create policy inventory_wastage_select on public.inventory_wastage
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_COST_VIEW'));

create policy inventory_wastage_write on public.inventory_wastage
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_WASTAGE'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_WASTAGE'));

grant select on public.inventory_wastage to authenticated;
revoke all on public.inventory_wastage from anon;

-- ---------------------------------------------------------------------------
-- 15) Stock counts
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.inventory_count_status as enum (
    'OPEN', 'IN_PROGRESS', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.inventory_stock_counts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  location_id uuid references public.inventory_locations(id) on delete set null,
  status public.inventory_count_status not null default 'OPEN',
  -- Blind count: staff cannot see expected quantities
  is_blind boolean not null default true,
  notes text,
  count_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  approved_at timestamptz
);
create index if not exists inventory_counts_branch_idx on public.inventory_stock_counts(branch_id, status);
alter table public.inventory_stock_counts enable row level security;

create policy inventory_counts_select on public.inventory_stock_counts
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

create policy inventory_counts_write on public.inventory_stock_counts
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_ADJUST'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_ADJUST'));

grant select on public.inventory_stock_counts to authenticated;
revoke all on public.inventory_stock_counts from anon;

create table if not exists public.inventory_stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.inventory_stock_counts(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  -- Expected quantity from system (in base_unit) — shown only after approval when blind
  expected_qty numeric(15, 4),
  -- Counted physical quantity (in base_unit)
  counted_qty numeric(15, 4),
  unit text not null,
  -- Variance = counted - expected
  variance_qty numeric(15, 4) generated always as (
    case when counted_qty is not null and expected_qty is not null
    then counted_qty - expected_qty
    else null end
  ) stored,
  -- The adjustment movement created on approval
  stock_movement_id uuid references public.inventory_stock_movements(id) on delete set null,
  notes text,
  unique(count_id, item_id)
);
create index if not exists inventory_count_lines_count_idx on public.inventory_stock_count_lines(count_id);
create index if not exists inventory_count_lines_item_idx on public.inventory_stock_count_lines(item_id);
alter table public.inventory_stock_count_lines enable row level security;

create policy inventory_count_lines_select on public.inventory_stock_count_lines
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

create policy inventory_count_lines_write on public.inventory_stock_count_lines
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_ADJUST'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_ADJUST'));

grant select on public.inventory_stock_count_lines to authenticated;
revoke all on public.inventory_stock_count_lines from anon;

-- ---------------------------------------------------------------------------
-- 16) Inter-branch transfers
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.inventory_transfer_status as enum (
    'REQUESTED', 'APPROVED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.inventory_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_branch_id uuid not null references public.branches(id) on delete restrict,
  to_branch_id uuid not null references public.branches(id) on delete restrict,
  transfer_number text not null,
  status public.inventory_transfer_status not null default 'REQUESTED',
  notes text,
  cancellation_reason text,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  dispatched_at timestamptz,
  received_at timestamptz,
  created_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  received_by uuid references auth.users(id),
  unique(organization_id, transfer_number),
  constraint transfer_different_branches check (from_branch_id <> to_branch_id)
);
create index if not exists inventory_transfers_from_idx on public.inventory_transfers(from_branch_id, status);
create index if not exists inventory_transfers_to_idx on public.inventory_transfers(to_branch_id, status);
create index if not exists inventory_transfers_org_idx on public.inventory_transfers(organization_id);
alter table public.inventory_transfers enable row level security;

create policy inventory_transfers_select on public.inventory_transfers
  for select to authenticated
  using (
    public.current_user_has_permission_for_branch(from_branch_id, 'INVENTORY_TRANSFER')
    or public.current_user_has_permission_for_branch(to_branch_id, 'INVENTORY_TRANSFER')
  );

create policy inventory_transfers_write on public.inventory_transfers
  for all to authenticated
  using (
    public.current_user_has_permission_for_branch(from_branch_id, 'INVENTORY_TRANSFER')
    or public.current_user_has_permission_for_branch(to_branch_id, 'INVENTORY_TRANSFER')
  )
  with check (
    public.current_user_has_permission_for_branch(from_branch_id, 'INVENTORY_TRANSFER')
    or public.current_user_has_permission_for_branch(to_branch_id, 'INVENTORY_TRANSFER')
  );

grant select on public.inventory_transfers to authenticated;
revoke all on public.inventory_transfers from anon;

create table if not exists public.inventory_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.inventory_transfers(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  from_batch_id uuid references public.inventory_batches(id) on delete set null,
  from_location_id uuid references public.inventory_locations(id) on delete set null,
  to_location_id uuid references public.inventory_locations(id) on delete set null,
  -- Quantities in item's base_unit
  requested_qty numeric(15, 4) not null check (requested_qty > 0),
  dispatched_qty numeric(15, 4),
  received_qty numeric(15, 4),
  damaged_in_transit_qty numeric(15, 4) not null default 0,
  unit text not null,
  -- Cost per base_unit at time of dispatch in paise
  unit_cost_paise bigint not null default 0,
  notes text,
  -- Movement references
  dispatch_movement_id uuid references public.inventory_stock_movements(id) on delete set null,
  receive_movement_id uuid references public.inventory_stock_movements(id) on delete set null
);
create index if not exists inventory_transfer_lines_transfer_idx on public.inventory_transfer_lines(transfer_id);
create index if not exists inventory_transfer_lines_item_idx on public.inventory_transfer_lines(item_id);
alter table public.inventory_transfer_lines enable row level security;

create policy inventory_transfer_lines_select on public.inventory_transfer_lines
  for select to authenticated
  using (exists (
    select 1 from public.inventory_transfers t
    where t.id = inventory_transfer_lines.transfer_id
      and (public.current_user_has_permission_for_branch(t.from_branch_id, 'INVENTORY_COST_VIEW')
           or public.current_user_has_permission_for_branch(t.to_branch_id, 'INVENTORY_COST_VIEW'))
  ));

create policy inventory_transfer_lines_write on public.inventory_transfer_lines
  for all to authenticated
  using (exists (
    select 1 from public.inventory_transfers t
    where t.id = inventory_transfer_lines.transfer_id
      and (public.current_user_has_permission_for_branch(t.from_branch_id, 'INVENTORY_TRANSFER')
           or public.current_user_has_permission_for_branch(t.to_branch_id, 'INVENTORY_TRANSFER'))
  ))
  with check (exists (
    select 1 from public.inventory_transfers t
    where t.id = inventory_transfer_lines.transfer_id
      and (public.current_user_has_permission_for_branch(t.from_branch_id, 'INVENTORY_TRANSFER')
           or public.current_user_has_permission_for_branch(t.to_branch_id, 'INVENTORY_TRANSFER'))
  ));

grant select on public.inventory_transfer_lines to authenticated;
revoke all on public.inventory_transfer_lines from anon;

-- ---------------------------------------------------------------------------
-- 17) Inventory alerts
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.inventory_alert_type as enum (
    'LOW_STOCK', 'CRITICAL_STOCK', 'OUT_OF_STOCK',
    'EXPIRING_SOON', 'EXPIRED', 'HIGH_FOOD_COST', 'HIGH_VARIANCE'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.inventory_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  item_id uuid references public.inventory_items(id) on delete cascade,
  batch_id uuid references public.inventory_batches(id) on delete set null,
  alert_type public.inventory_alert_type not null,
  severity text not null default 'WARNING' check (severity in ('INFO', 'WARNING', 'CRITICAL')),
  message text not null,
  -- Current value at time of alert (quantity or percentage)
  alert_value numeric(15, 4),
  threshold_value numeric(15, 4),
  is_dismissed boolean not null default false,
  dismissed_by uuid references auth.users(id),
  dismissed_at timestamptz,
  alert_date date not null default current_date,
  created_at timestamptz not null default now(),
  -- Prevent duplicate alerts of same type for same item today
  unique nulls not distinct (branch_id, item_id, alert_type, alert_date)
);
create index if not exists inventory_alerts_branch_idx on public.inventory_alerts(branch_id, is_dismissed, created_at desc);
create index if not exists inventory_alerts_item_idx on public.inventory_alerts(item_id);
alter table public.inventory_alerts enable row level security;

create policy inventory_alerts_select on public.inventory_alerts
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

create policy inventory_alerts_write on public.inventory_alerts
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

grant select on public.inventory_alerts to authenticated;
revoke all on public.inventory_alerts from anon;

-- ---------------------------------------------------------------------------
-- 18) Production batches (sub-recipe outputs)
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.inventory_production_status as enum (
    'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.inventory_production_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  -- The sub-recipe being produced
  recipe_id uuid not null references public.inventory_recipes(id) on delete restrict,
  recipe_version_id uuid references public.inventory_recipe_versions(id) on delete set null,
  location_id uuid references public.inventory_locations(id) on delete set null,
  status public.inventory_production_status not null default 'PLANNED',
  -- How many servings/units of the sub-recipe are being made
  batch_qty numeric(15, 4) not null check (batch_qty > 0),
  batch_unit text not null,
  -- Total cost of raw ingredients consumed in paise
  total_cost_paise bigint not null default 0,
  -- Cost per output unit in paise
  cost_per_unit_paise bigint not null default 0,
  production_date date not null default current_date,
  expiry_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists inventory_production_batches_branch_idx
  on public.inventory_production_batches(branch_id, production_date desc);
create index if not exists inventory_production_batches_recipe_idx
  on public.inventory_production_batches(recipe_id);
alter table public.inventory_production_batches enable row level security;

create policy inventory_production_batches_select on public.inventory_production_batches
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_VIEW'));

create policy inventory_production_batches_write on public.inventory_production_batches
  for all to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT'))
  with check (public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT'));

grant select on public.inventory_production_batches to authenticated;
revoke all on public.inventory_production_batches from anon;

-- ---------------------------------------------------------------------------
-- 19) Updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.inventory_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

do $$ declare t text; begin
  foreach t in array array[
    'inventory_categories','inventory_locations','branch_inventory_settings',
    'inventory_items','inventory_suppliers','inventory_item_suppliers',
    'inventory_batches','inventory_recipes','inventory_goods_receipts',
    'inventory_purchase_orders','inventory_stock_counts','inventory_transfers',
    'inventory_production_batches'
  ] loop
    execute format(
      'drop trigger if exists %I_updated_at on public.%I;
       create trigger %I_updated_at before update on public.%I
       for each row execute function public.inventory_set_updated_at();',
      t, t, t, t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 20) Balance update function (called by movement RPCs to keep cache consistent)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_update_balance(
  p_item_id uuid,
  p_branch_id uuid,
  p_qty_delta numeric,       -- positive = stock in, negative = stock out
  p_cost_delta_paise bigint, -- cost change for weighted-average recalculation
  p_movement_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_current public.inventory_balances%rowtype;
  v_new_on_hand numeric;
  v_new_avg_cost bigint;
  v_new_value bigint;
begin
  select organization_id into v_org from public.inventory_items where id = p_item_id;
  if v_org is null then raise exception 'Inventory item not found'; end if;

  -- Upsert the balance row
  insert into public.inventory_balances(item_id, branch_id, organization_id, on_hand_qty, avg_unit_cost_paise, stock_value_paise, last_movement_at)
  values (p_item_id, p_branch_id, v_org, greatest(0, p_qty_delta), 0, 0, p_movement_at)
  on conflict (item_id, branch_id) do nothing;

  select * into v_current from public.inventory_balances where item_id = p_item_id and branch_id = p_branch_id for update;

  v_new_on_hand := v_current.on_hand_qty + p_qty_delta;

  -- Weighted average cost: only update when adding stock (receiving)
  if p_qty_delta > 0 and p_cost_delta_paise > 0 then
    -- New avg = (current_value + new_cost) / new_qty
    v_new_avg_cost := case when v_new_on_hand > 0
      then ((v_current.stock_value_paise + p_cost_delta_paise)::numeric / v_new_on_hand)::bigint
      else 0 end;
  else
    v_new_avg_cost := v_current.avg_unit_cost_paise;
  end if;

  v_new_value := (v_new_on_hand * v_new_avg_cost)::bigint;

  update public.inventory_balances
  set on_hand_qty = v_new_on_hand,
      avg_unit_cost_paise = v_new_avg_cost,
      stock_value_paise = v_new_value,
      last_movement_at = greatest(coalesce(last_movement_at, p_movement_at), p_movement_at),
      updated_at = now()
  where item_id = p_item_id and branch_id = p_branch_id;
end;
$$;
revoke all on function public.inventory_update_balance(uuid, uuid, numeric, bigint, timestamptz)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 21) Balance reservation update (called when reservations change)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_update_reservation(
  p_item_id uuid,
  p_branch_id uuid,
  p_reserved_qty_delta numeric  -- positive = more reserved, negative = released
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.inventory_items where id = p_item_id;
  if v_org is null then raise exception 'Inventory item not found'; end if;

  insert into public.inventory_balances(item_id, branch_id, organization_id, reserved_qty)
  values (p_item_id, p_branch_id, v_org, greatest(0, p_reserved_qty_delta))
  on conflict (item_id, branch_id) do nothing;

  update public.inventory_balances
  set reserved_qty = greatest(0, reserved_qty + p_reserved_qty_delta),
      updated_at = now()
  where item_id = p_item_id and branch_id = p_branch_id;
end;
$$;
revoke all on function public.inventory_update_reservation(uuid, uuid, numeric)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 22) Helper: seed default categories for a new organization
-- ---------------------------------------------------------------------------
create or replace function public.inventory_ensure_default_categories(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.organization_has_feature(p_organization_id, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this organization' using errcode = '42501';
  end if;
  if not (
    public.is_org_owner(p_organization_id)
    or exists (
      select 1 from public.branches b
      where b.organization_id = p_organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_MANAGEMENT')
    )
  ) then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  insert into public.inventory_categories(organization_id, name, sort_order)
  values
    (p_organization_id, 'Vegetables & Fruits', 1),
    (p_organization_id, 'Dairy & Cheese', 2),
    (p_organization_id, 'Meat & Poultry', 3),
    (p_organization_id, 'Fish & Seafood', 4),
    (p_organization_id, 'Grains & Rice', 5),
    (p_organization_id, 'Flour & Bakery', 6),
    (p_organization_id, 'Spices & Seasonings', 7),
    (p_organization_id, 'Oils & Cooking Fats', 8),
    (p_organization_id, 'Beverages', 9),
    (p_organization_id, 'Sauces & Condiments', 10),
    (p_organization_id, 'Packaging', 11),
    (p_organization_id, 'Cleaning Materials', 12),
    (p_organization_id, 'Other Supplies', 13)
  on conflict (organization_id, name) do nothing;
end;
$$;
grant execute on function public.inventory_ensure_default_categories(uuid) to authenticated;
revoke execute on function public.inventory_ensure_default_categories(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- 23) Helper: seed default locations for a new branch
-- ---------------------------------------------------------------------------
create or replace function public.inventory_ensure_default_locations(p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then raise exception 'Branch not found' using errcode = 'P0002'; end if;
  if auth.uid() is null
     or not public.organization_has_feature(v_org, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  insert into public.inventory_locations(branch_id, organization_id, name, sort_order)
  values
    (p_branch_id, v_org, 'Main Storeroom', 1),
    (p_branch_id, v_org, 'Cold Storage', 2),
    (p_branch_id, v_org, 'Freezer', 3),
    (p_branch_id, v_org, 'Kitchen', 4),
    (p_branch_id, v_org, 'Bar', 5)
  on conflict (branch_id, name) do nothing;
end;
$$;
grant execute on function public.inventory_ensure_default_locations(uuid) to authenticated;
revoke execute on function public.inventory_ensure_default_locations(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- 24) Helper: seed default branch inventory settings
-- ---------------------------------------------------------------------------
create or replace function public.inventory_ensure_branch_settings(p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.branches where id = p_branch_id;
  if v_org is null then raise exception 'Branch not found' using errcode = 'P0002'; end if;
  if auth.uid() is null
     or not public.organization_has_feature(v_org, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  insert into public.branch_inventory_settings(branch_id, organization_id)
  values (p_branch_id, v_org)
  on conflict (branch_id) do nothing;
end;
$$;
grant execute on function public.inventory_ensure_branch_settings(uuid) to authenticated;
revoke execute on function public.inventory_ensure_branch_settings(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- 25) Check migration version integrity
-- ---------------------------------------------------------------------------
select pg_notify('pgrst', 'reload schema');

commit;
