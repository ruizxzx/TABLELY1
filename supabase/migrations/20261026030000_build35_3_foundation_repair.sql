-- TABLELY BUILD 35.3 — Foundation repair and fulfillment security hardening
-- Forward-only repair. Historical migrations are deliberately not modified.
-- This migration keeps the existing order, payment, coupon and inventory engines.

begin;

-- ---------------------------------------------------------------------------
-- 1. Safe defaults, persisted configuration shape, audit and OTP storage
-- ---------------------------------------------------------------------------

alter table public.branch_ordering_settings
  alter column online_ordering_enabled set default false,
  alter column pickup_enabled set default false,
  alter column delivery_enabled set default false,
  alter column auto_accept_enabled set default false,
  alter column pickup_settings set default '{"instructions":"Please show your pickup code at the counter.","slot_interval_minutes":15,"max_orders_per_slot":8}'::jsonb,
  alter column delivery_settings set default '{"instructions":"Contact-free delivery available on request.","cod_enabled":false,"upi_on_delivery_enabled":false,"free_delivery_threshold":null}'::jsonb;

-- The previous defaults were permissive. Disable previously auto-enabled
-- branches and cash/UPI-on-delivery until an authorized operator opts in.
update public.branch_ordering_settings
set online_ordering_enabled = false,
    pickup_enabled = false,
    delivery_enabled = false,
    auto_accept_enabled = false,
    pickup_settings = coalesce(pickup_settings, '{}'::jsonb)
      || jsonb_build_object(
        'slot_interval_minutes', case when jsonb_typeof(pickup_settings->'slot_interval_minutes') = 'number'
          and (pickup_settings->>'slot_interval_minutes')::numeric between 5 and 120
          then (pickup_settings->'slot_interval_minutes') else '15'::jsonb end,
        'max_orders_per_slot', case when jsonb_typeof(pickup_settings->'max_orders_per_slot') = 'number'
          and (pickup_settings->>'max_orders_per_slot')::numeric between 1 and 100
          then (pickup_settings->'max_orders_per_slot') else '8'::jsonb end
      ),
    delivery_settings = coalesce(delivery_settings, '{}'::jsonb)
      || jsonb_build_object(
        'cod_enabled', false, 'upi_on_delivery_enabled', false,
        'free_delivery_threshold', case
          when delivery_settings ? 'free_delivery_threshold' then delivery_settings->'free_delivery_threshold'
          else 'null'::jsonb end
      ),
    updated_at = now();

alter table public.branch_ordering_settings
  drop constraint if exists branch_ordering_pickup_settings_object_check,
  drop constraint if exists branch_ordering_delivery_settings_object_check;
alter table public.branch_ordering_settings
  add constraint branch_ordering_pickup_settings_object_check
    check (jsonb_typeof(pickup_settings) = 'object'),
  add constraint branch_ordering_delivery_settings_object_check
    check (jsonb_typeof(delivery_settings) = 'object'),
  add constraint branch_ordering_pickup_slot_interval_check
    check (not (pickup_settings ? 'slot_interval_minutes') or
      (jsonb_typeof(pickup_settings->'slot_interval_minutes') = 'number' and
       (pickup_settings->>'slot_interval_minutes')::numeric between 5 and 120)),
  add constraint branch_ordering_pickup_slot_capacity_check
    check (not (pickup_settings ? 'max_orders_per_slot') or
      (jsonb_typeof(pickup_settings->'max_orders_per_slot') = 'number' and
       (pickup_settings->>'max_orders_per_slot')::numeric between 1 and 100)),
  add constraint branch_ordering_delivery_flags_check
    check ((not (delivery_settings ? 'cod_enabled') or jsonb_typeof(delivery_settings->'cod_enabled') = 'boolean') and
      (not (delivery_settings ? 'upi_on_delivery_enabled') or jsonb_typeof(delivery_settings->'upi_on_delivery_enabled') = 'boolean'));

alter table public.orders
  add column if not exists idempotency_fingerprint text,
  add column if not exists checkout_snapshot jsonb;

alter table public.order_fulfillment_details
  add column if not exists pickup_code_hash text,
  add column if not exists delivery_otp_hash text,
  add column if not exists pickup_code_expires_at timestamptz,
  add column if not exists delivery_otp_expires_at timestamptz,
  add column if not exists pickup_code_used_at timestamptz,
  add column if not exists delivery_otp_used_at timestamptz,
  add column if not exists pickup_verification_attempts integer not null default 0,
  add column if not exists delivery_verification_attempts integer not null default 0;

alter table public.order_fulfillment_details
  drop constraint if exists fulfillment_pickup_attempts_check,
  drop constraint if exists fulfillment_delivery_attempts_check;
alter table public.order_fulfillment_details
  add constraint fulfillment_pickup_attempts_check
    check (pickup_verification_attempts between 0 and 5),
  add constraint fulfillment_delivery_attempts_check
    check (delivery_verification_attempts between 0 and 5);

-- Complete the state vocabulary without conflating order or payment status.
alter table public.order_fulfillment_details
  drop constraint if exists order_fulfillment_details_fulfillment_status_check;
alter table public.order_fulfillment_details
  add constraint order_fulfillment_details_fulfillment_status_check
    check (fulfillment_status in (
      'NOT_STARTED', 'WAITING_FOR_PICKUP', 'READY_FOR_PICKUP', 'PICKED_UP',
      'WAITING_FOR_DRIVER', 'ASSIGNED', 'READY_FOR_DISPATCH', 'OUT_FOR_DELIVERY',
      'DELIVERED', 'DELIVERY_FAILED', 'RETURNED_TO_RESTAURANT', 'CANCELLED'
    ));

-- Never keep existing short codes in plaintext. Legacy in-flight handoffs must
-- use an audited manager override because their original codes cannot be hashed
-- retroactively without exposing them again.
update public.order_fulfillment_details
set pickup_code_display = null,
    delivery_otp_display = null,
    pickup_code_expires_at = case when fulfillment_type = 'PICKUP' and picked_up_at is null then now() else pickup_code_expires_at end,
    delivery_otp_expires_at = case when fulfillment_type = 'DELIVERY' and delivered_at is null then now() else delivery_otp_expires_at end
where pickup_code_display is not null or delivery_otp_display is not null;

update public.order_fulfillment_details ofd
set fulfillment_status = case
  when ofd.fulfillment_type = 'PICKUP' then 'READY_FOR_PICKUP'
  when ofd.fulfillment_type = 'DELIVERY' then 'READY_FOR_DISPATCH'
  else ofd.fulfillment_status end,
  updated_at = now()
from public.orders o
where o.id = ofd.order_id and o.status = 'READY'
  and ofd.fulfillment_status in ('WAITING_FOR_PICKUP', 'WAITING_FOR_DRIVER', 'ASSIGNED');

update public.order_fulfillment_details ofd
set fulfillment_status = 'CANCELLED', updated_at = now()
from public.orders o
where o.id = ofd.order_id and o.status in ('CANCELLED', 'REJECTED')
  and ofd.fulfillment_status not in ('PICKED_UP', 'DELIVERED', 'CANCELLED');

create index if not exists orders_branch_idempotency_idx
  on public.orders(branch_id, idempotency_key);
create index if not exists payment_attempts_branch_fulfillment_idx
  on public.payment_attempts(branch_id, fulfillment_type, created_at desc);

create table if not exists public.branch_ordering_settings_audit (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  before_state jsonb not null,
  after_state jsonb not null,
  changed_at timestamptz not null default now()
);
create index if not exists branch_ordering_settings_audit_branch_idx
  on public.branch_ordering_settings_audit(branch_id, changed_at desc);
alter table public.branch_ordering_settings_audit enable row level security;
revoke all on public.branch_ordering_settings_audit from anon, authenticated, public;
create policy branch_ordering_settings_audit_select on public.branch_ordering_settings_audit
  for select to authenticated
  using (
    public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(branch_id, 'SETTINGS')
  );
grant select on public.branch_ordering_settings_audit to authenticated;

-- The legacy Build 3 validator assumes every order has a table. Replace it
-- so DINE_IN still requires a same-branch table while PICKUP/DELIVERY must
-- remain tableless. This closes the actual trigger-level blocker, not only the
-- table CHECK constraint added by Build 35.1.
create or replace function public.validate_order_table_branch()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.fulfillment_type = 'DINE_IN' then
    if new.table_id is null then
      raise exception 'Dine-in orders require a dining table';
    end if;
    if not exists (
      select 1 from public.tables t
      where t.id = new.table_id and t.branch_id = new.branch_id
    ) then
      raise exception 'Order table does not belong to this branch';
    end if;
  elsif new.fulfillment_type in ('PICKUP', 'DELIVERY') then
    if new.table_id is not null then
      raise exception 'Pickup and delivery orders cannot be assigned a dining table';
    end if;
  else
    raise exception 'Unsupported order fulfillment type';
  end if;
  return new;
end;
$$;
drop trigger if exists order_table_branch_check on public.orders;
create trigger order_table_branch_check
before insert or update of branch_id, table_id, fulfillment_type on public.orders
for each row execute function public.validate_order_table_branch();

-- ---------------------------------------------------------------------------
-- 2. Tighten branch ordering settings and delivery-zone RLS
-- ---------------------------------------------------------------------------

revoke all on public.branch_ordering_settings from anon, authenticated, public;
drop policy if exists branch_ordering_settings_select on public.branch_ordering_settings;
drop policy if exists branch_ordering_settings_admin on public.branch_ordering_settings;
create policy branch_ordering_settings_select on public.branch_ordering_settings
  for select to authenticated
  using (
    public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(branch_id, 'SETTINGS')
  );
create policy branch_ordering_settings_admin on public.branch_ordering_settings
  for all to authenticated
  using (
    public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(branch_id, 'SETTINGS')
  )
  with check (
    public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(branch_id, 'SETTINGS')
  );
grant select on public.branch_ordering_settings to authenticated;

revoke all on public.delivery_zones from anon, authenticated, public;
drop policy if exists delivery_zones_anon_select on public.delivery_zones;
drop policy if exists delivery_zones_staff_all on public.delivery_zones;
create policy delivery_zones_public_active_select on public.delivery_zones
  for select to anon, authenticated
  using (
    is_active = true
    or (auth.uid() is not null and (
      public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
      or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_DELIVERY')
    ))
  );
create policy delivery_zones_staff_manage on public.delivery_zones
  for all to authenticated
  using (
    public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_DELIVERY')
  )
  with check (
    public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_DELIVERY')
  );
grant select on public.delivery_zones to anon, authenticated;
grant insert, update, delete on public.delivery_zones to authenticated;

-- Only fulfillment managers and the rider assigned to a delivery may read the
-- private fulfillment row. Kitchen staff get order items through the existing
-- kitchen/order APIs, not delivery addresses or verification metadata.
revoke all on public.order_fulfillment_details from anon, authenticated, public;
drop policy if exists order_fulfillment_select on public.order_fulfillment_details;
create policy order_fulfillment_details_authorized_read on public.order_fulfillment_details
  for select to authenticated
  using (
    public.current_user_has_permission_for_branch(branch_id, 'MANAGE_PICKUP')
    or public.current_user_has_permission_for_branch(branch_id, 'VIEW_DELIVERY')
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_DELIVERY')
    or public.current_user_has_permission_for_branch(branch_id, 'VIEW_ONLINE_ORDERS')
    or (
      assigned_staff_id in (
        select s.id from public.staff s
        where s.user_id = auth.uid() and s.active = true and s.branch_id = order_fulfillment_details.branch_id
          and exists (
            select 1 from public.staff_permissions sp
            where sp.staff_id = s.id and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true
          )
      )
    )
  );
-- Column grants exclude hashes, raw legacy codes and internal attempt counters.
grant select (
  id, order_id, branch_id, fulfillment_type, fulfillment_status, scheduled_for,
  promised_ready_at, promised_delivery_at, delivery_zone_id,
  delivery_fee_snapshot, packaging_fee_snapshot, assigned_staff_id,
  accepted_at, ready_at, assigned_at, dispatched_at,
  picked_up_at, delivered_at, failed_at, failure_reason,
  payment_collected_at, payment_collected_by, payment_collection_method,
  payment_collected_amount, created_at, updated_at
) on public.order_fulfillment_details to authenticated;
revoke insert, update, delete on public.order_fulfillment_details from authenticated;

revoke all on public.order_fulfillment_events from anon, authenticated, public;
drop policy if exists order_fulfillment_events_select on public.order_fulfillment_events;
create policy order_fulfillment_events_authorized_read on public.order_fulfillment_events
  for select to authenticated
  using (
    public.current_user_has_permission_for_branch(branch_id, 'MANAGE_PICKUP')
    or public.current_user_has_permission_for_branch(branch_id, 'MANAGE_DELIVERY')
    or public.current_user_has_permission_for_branch(branch_id, 'VIEW_FULFILLMENT_REPORTS')
  );
grant select on public.order_fulfillment_events to authenticated;

-- Remove blanket orders SELECT privileges. Restaurant clients receive only
-- operational/order-financial columns; customer identity and notes are returned
-- by the permission-checked RPC below. Marketplace order fields remain granted
-- to preserve the existing creator order workspace.
revoke all on public.orders from anon, authenticated, public;
grant select (
  id, order_number, table_id, table_session_id, branch_id, status,
  payment_status, payment_method, subtotal, tax, discount, additional_charges,
  total, coupon_code_snapshot, order_business_date,
  created_at, updated_at, cancellation_reason, cancelled_by, cancelled_at,
  payment_started_at, payment_expires_at, priority, fulfillment_type,
  legacy_payment_reconciliation_required, buyer_email, gross_amount,
  currency, payment_fee, platform_fee, seller_net, delivery_status,
  paid_at, product_id, store_id, creator_id
) on public.orders to authenticated;

create or replace function public.get_branch_order_customer_details(
  p_branch_id uuid, p_order_ids uuid[]
)
returns table (
  order_id uuid, customer_name text, customer_phone text, customer_note text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_can_view_customer boolean;
  v_can_view_notes boolean;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_branch_id is null or coalesce(array_length(p_order_ids, 1), 0) = 0
    or array_length(p_order_ids, 1) > 500 then
    raise exception 'A branch and between 1 and 500 order IDs are required';
  end if;
  if not (
    public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_ORDERS')
    or public.current_user_has_permission_for_branch(p_branch_id, 'KITCHEN_ACCESS')
    or public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_ONLINE_ORDERS')
    or public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_CUSTOMER_DETAILS')
  ) then raise exception 'Order access denied' using errcode = '42501'; end if;
  v_can_view_customer := public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_CUSTOMER_DETAILS');
  v_can_view_notes := v_can_view_customer or public.current_user_has_permission_for_branch(p_branch_id, 'KITCHEN_ACCESS');

  return query
  select o.id,
    case when v_can_view_customer then o.customer_name else null end,
    case when v_can_view_customer then o.customer_phone else null end,
    case when v_can_view_notes then o.customer_note else null end
  from public.orders o
  where o.branch_id = p_branch_id and o.id = any(p_order_ids);
end;
$$;
revoke all on function public.get_branch_order_customer_details(uuid,uuid[]) from public, anon;
grant execute on function public.get_branch_order_customer_details(uuid,uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Internal settings ensure + partial update RPC with validation and audit
-- ---------------------------------------------------------------------------

create or replace function public.ensure_branch_ordering_settings(p_branch_id uuid)
returns public.branch_ordering_settings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_settings public.branch_ordering_settings;
begin
  if not exists (
    select 1 from public.branches b
    join public.organizations o on o.id = b.organization_id
    where b.id = p_branch_id and b.active = true and o.status = 'ACTIVE'::public.account_status
  ) then
    raise exception 'Branch not found or inactive';
  end if;

  insert into public.branch_ordering_settings(branch_id)
  values (p_branch_id)
  on conflict (branch_id) do nothing;

  select * into v_settings
  from public.branch_ordering_settings
  where branch_id = p_branch_id;
  return v_settings;
end;
$$;
revoke all on function public.ensure_branch_ordering_settings(uuid) from public, anon, authenticated;

drop function if exists public.save_branch_ordering_settings(uuid,boolean,boolean,boolean,integer,numeric,numeric,numeric,text,text,boolean,boolean,numeric);
create function public.save_branch_ordering_settings(
  p_branch_id uuid,
  p_online_ordering_enabled boolean default null,
  p_pickup_enabled boolean default null,
  p_delivery_enabled boolean default null,
  p_default_prep_minutes integer default null,
  p_minimum_order_amount numeric default null,
  p_pickup_packaging_fee numeric default null,
  p_delivery_packaging_fee numeric default null,
  p_pickup_instructions text default null,
  p_delivery_instructions text default null,
  p_cod_enabled boolean default null,
  p_upi_on_delivery_enabled boolean default null,
  p_free_delivery_threshold numeric default null,
  p_clear_free_delivery_threshold boolean default false
)
returns public.branch_ordering_settings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_before public.branch_ordering_settings%rowtype;
  v_after public.branch_ordering_settings%rowtype;
  v_pickup jsonb;
  v_delivery jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.branches b
    join public.organizations o on o.id = b.organization_id
    where b.id = p_branch_id and b.active = true and o.status = 'ACTIVE'::public.account_status
  ) then
    raise exception 'Branch not found or inactive';
  end if;
  if not (
    public.current_user_has_permission_for_branch(p_branch_id, 'MANAGE_ONLINE_ORDERING')
    or public.current_user_has_permission_for_branch(p_branch_id, 'SETTINGS')
  ) then
    raise exception 'Permission denied: online ordering settings permission required' using errcode = '42501';
  end if;

  if p_default_prep_minutes is not null and p_default_prep_minutes not between 5 and 180 then
    raise exception 'Preparation time must be between 5 and 180 minutes';
  end if;
  if p_minimum_order_amount is not null and p_minimum_order_amount not between 0 and 1000000 then
    raise exception 'Minimum order amount must be between 0 and 1000000';
  end if;
  if p_pickup_packaging_fee is not null and p_pickup_packaging_fee not between 0 and 100000 then
    raise exception 'Pickup packaging fee is outside the allowed range';
  end if;
  if p_delivery_packaging_fee is not null and p_delivery_packaging_fee not between 0 and 100000 then
    raise exception 'Delivery packaging fee is outside the allowed range';
  end if;
  if p_free_delivery_threshold is not null and p_free_delivery_threshold not between 0 and 1000000 then
    raise exception 'Free delivery threshold is outside the allowed range';
  end if;
  if p_pickup_instructions is not null and length(p_pickup_instructions) > 1000 then
    raise exception 'Pickup instructions must be 1000 characters or fewer';
  end if;
  if p_delivery_instructions is not null and length(p_delivery_instructions) > 1000 then
    raise exception 'Delivery instructions must be 1000 characters or fewer';
  end if;

  perform public.ensure_branch_ordering_settings(p_branch_id);
  select * into v_before from public.branch_ordering_settings where branch_id = p_branch_id for update;
  v_pickup := coalesce(v_before.pickup_settings, '{}'::jsonb);
  v_delivery := coalesce(v_before.delivery_settings, '{}'::jsonb);
  if p_pickup_instructions is not null then
    v_pickup := v_pickup || jsonb_build_object('instructions', left(trim(p_pickup_instructions), 1000));
  end if;
  if p_delivery_instructions is not null then
    v_delivery := v_delivery || jsonb_build_object('instructions', left(trim(p_delivery_instructions), 1000));
  end if;
  if p_cod_enabled is not null then
    v_delivery := v_delivery || jsonb_build_object('cod_enabled', p_cod_enabled);
  end if;
  if p_upi_on_delivery_enabled is not null then
    v_delivery := v_delivery || jsonb_build_object('upi_on_delivery_enabled', p_upi_on_delivery_enabled);
  end if;
  if p_free_delivery_threshold is not null or coalesce(p_clear_free_delivery_threshold, false) then
    v_delivery := v_delivery || jsonb_build_object('free_delivery_threshold', p_free_delivery_threshold);
  end if;

  update public.branch_ordering_settings
  set online_ordering_enabled = coalesce(p_online_ordering_enabled, online_ordering_enabled),
      pickup_enabled = coalesce(p_pickup_enabled, pickup_enabled),
      delivery_enabled = coalesce(p_delivery_enabled, delivery_enabled),
      auto_accept_enabled = false,
      manual_acceptance = true,
      default_prep_minutes = coalesce(p_default_prep_minutes, default_prep_minutes),
      minimum_order_amount = coalesce(p_minimum_order_amount, minimum_order_amount),
      pickup_packaging_fee = coalesce(p_pickup_packaging_fee, pickup_packaging_fee),
      delivery_packaging_fee = coalesce(p_delivery_packaging_fee, delivery_packaging_fee),
      pickup_settings = v_pickup,
      delivery_settings = v_delivery,
      updated_at = now()
  where branch_id = p_branch_id
  returning * into v_after;

  insert into public.branch_ordering_settings_audit(branch_id, actor_user_id, before_state, after_state)
  values (
    p_branch_id, auth.uid(), to_jsonb(v_before), to_jsonb(v_after)
  );
  return v_after;
end;
$$;
revoke all on function public.save_branch_ordering_settings(uuid,boolean,boolean,boolean,integer,numeric,numeric,numeric,text,text,boolean,boolean,numeric,boolean) from public, anon;
grant execute on function public.save_branch_ordering_settings(uuid,boolean,boolean,boolean,integer,numeric,numeric,numeric,text,text,boolean,boolean,numeric,boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Public storefront context: strict branch selection and valid aggregation
-- ---------------------------------------------------------------------------

create or replace function public.get_public_storefront_context(
  p_restaurant_slug text,
  p_branch_id uuid default null
)
returns table (
  restaurant_id uuid, restaurant_name text, restaurant_slug text, logo_url text,
  cover_url text, branch_id uuid, branch_name text, branch_address text,
  branch_phone text, online_ordering_enabled boolean, pickup_enabled boolean,
  delivery_enabled boolean, default_prep_minutes integer,
  minimum_order_amount numeric, pickup_packaging_fee numeric,
  delivery_packaging_fee numeric, pickup_settings jsonb, delivery_settings jsonb,
  branches jsonb, delivery_zones jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org public.organizations%rowtype;
  v_branch public.branches%rowtype;
  v_settings public.branch_ordering_settings%rowtype;
  v_branches_json jsonb;
  v_zones_json jsonb;
begin
  select * into v_org
  from public.organizations
  where slug = trim(lower(p_restaurant_slug))
    and status = 'ACTIVE'::public.account_status
  limit 1;
  if v_org.id is null then raise exception 'Restaurant not found or inactive'; end if;

  if p_branch_id is not null then
    select * into v_branch
    from public.branches
    where id = p_branch_id and organization_id = v_org.id and active = true;
    if v_branch.id is null then raise exception 'Selected branch does not belong to this restaurant or is inactive'; end if;
  else
    select * into v_branch
    from public.branches
    where organization_id = v_org.id and active = true
    order by created_at asc, id asc
    limit 1;
  end if;
  if v_branch.id is null then raise exception 'No active branches available'; end if;

  v_settings := public.ensure_branch_ordering_settings(v_branch.id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'name', b.name, 'address', b.address, 'phone', b.phone
  ) order by b.created_at asc, b.id asc), '[]'::jsonb)
  into v_branches_json
  from public.branches b
  where b.organization_id = v_org.id and b.active = true;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', dz.id,
    'name', dz.name,
    'pin_codes', dz.supported_pin_codes,
    'delivery_fee', dz.delivery_fee,
    'minimum_order_amount', dz.minimum_order_amount,
    'free_delivery_threshold', dz.free_delivery_threshold,
    'estimated_min_minutes', dz.estimated_min_minutes,
    'estimated_max_minutes', dz.estimated_max_minutes
  ) order by dz.priority desc, dz.delivery_fee asc, dz.id asc), '[]'::jsonb)
  into v_zones_json
  from public.delivery_zones dz
  where dz.branch_id = v_branch.id and dz.is_active = true;

  return query select
    v_org.id, v_org.name, v_org.slug, v_org.logo_url, v_org.cover_image_url,
    v_branch.id, v_branch.name, v_branch.address, v_branch.phone,
    v_settings.online_ordering_enabled, v_settings.pickup_enabled, v_settings.delivery_enabled,
    v_settings.default_prep_minutes, v_settings.minimum_order_amount,
    v_settings.pickup_packaging_fee, v_settings.delivery_packaging_fee,
    jsonb_build_object('instructions', v_settings.pickup_settings->>'instructions',
      'slot_interval_minutes', coalesce(v_settings.pickup_settings->'slot_interval_minutes', '15'::jsonb),
      'max_orders_per_slot', coalesce(v_settings.pickup_settings->'max_orders_per_slot', '8'::jsonb)),
    jsonb_build_object('instructions', v_settings.delivery_settings->>'instructions',
      'cod_enabled', coalesce((v_settings.delivery_settings->>'cod_enabled')::boolean, false),
      'upi_on_delivery_enabled', coalesce((v_settings.delivery_settings->>'upi_on_delivery_enabled')::boolean, false),
      'free_delivery_threshold', v_settings.delivery_settings->'free_delivery_threshold'),
    v_branches_json, v_zones_json;
end;
$$;
grant execute on function public.get_public_storefront_context(text,uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Public menu context validates tenant, active branch and online switch
-- ---------------------------------------------------------------------------

create or replace function public.get_public_menu_for_branch(p_branch_id uuid)
returns table (
  category_id uuid, category_name text, category_sort integer,
  subcategory_id uuid, subcategory_name text, subcategory_sort integer,
  meal_section text, item_id uuid, item_name text, item_description text,
  item_price numeric, image_url text, is_available boolean, is_veg boolean,
  is_spicy boolean, is_recommended boolean, is_featured boolean, is_popular boolean,
  preparation_minutes integer, dietary_tags text[], allergens text[], addons jsonb,
  variants jsonb, modifier_groups jsonb, category_translations jsonb,
  subcategory_translations jsonb, item_translations jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_settings public.branch_ordering_settings%rowtype;
begin
  if not exists (
    select 1 from public.branches b
    join public.organizations o on o.id = b.organization_id
    where b.id = p_branch_id and b.active = true and o.status = 'ACTIVE'::public.account_status
  ) then raise exception 'Branch not found or inactive'; end if;
  v_settings := public.ensure_branch_ordering_settings(p_branch_id);
  if not v_settings.online_ordering_enabled then
    raise exception 'Online ordering is currently disabled for this branch';
  end if;

  return query
  select
    c.id, c.name, c.sort_order, sc.id, sc.name, sc.sort_order,
    mi.meal_section, mi.id, mi.name, mi.description, mi.price, mi.image_url,
    mi.is_available, mi.is_veg, mi.is_spicy, mi.is_recommended, mi.is_featured,
    mi.is_popular, mi.preparation_minutes, mi.dietary_tags, mi.allergens, mi.addons,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'name', v.name, 'description', v.description,
        'price_delta', v.price_delta, 'is_default', v.is_default,
        'is_available', v.is_available, 'sort_order', v.sort_order,
        'translations', '[]'::jsonb
      ) order by v.sort_order)
      from public.menu_item_variants v
      where v.menu_item_id = mi.id and v.is_available = true
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mg.id, 'name', mg.name, 'description', mg.description,
        'is_required', mg.is_required, 'selection_mode', mg.selection_mode,
        'min_select', mg.min_select, 'max_select', mg.max_select,
        'sort_order', mg.sort_order,
        'modifiers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', m.id, 'name', m.name, 'description', m.description,
            'price_delta', m.price_delta, 'is_available', m.is_available,
            'sort_order', m.sort_order
          ) order by m.sort_order)
          from public.menu_modifiers m
          where m.group_id = mg.id and m.is_available = true
        ), '[]'::jsonb)
      ) order by mg.sort_order)
      from public.menu_modifier_groups mg where mg.menu_item_id = mi.id
    ), '[]'::jsonb),
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
  from public.menu_items mi
  join public.menu_categories c on c.id = mi.category_id
  left join public.menu_subcategories sc on sc.id = mi.subcategory_id
  where mi.branch_id = p_branch_id and mi.is_draft = false and mi.is_available = true
  order by c.sort_order asc, sc.sort_order asc nulls first, mi.name asc;
end;
$$;
grant execute on function public.get_public_menu_for_branch(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Server-authoritative fulfillment preview; coupon errors are not swallowed
-- ---------------------------------------------------------------------------

create or replace function public.preview_public_fulfillment_checkout(
  p_branch_id uuid,
  p_fulfillment_type text,
  p_items jsonb,
  p_delivery_pin_code text default null,
  p_coupon_code text default null,
  p_customer_phone text default null
)
returns table (
  subtotal numeric, discount numeric, discounted_subtotal numeric, tax numeric,
  additional_charges numeric, packaging_fee numeric, delivery_fee numeric,
  total numeric, charge_breakdown jsonb, coupon_id uuid, coupon_code text,
  discount_type text, discount_value numeric, delivery_zone_id uuid,
  delivery_zone_name text, estimated_min_minutes integer,
  estimated_max_minutes integer, is_serviceable boolean, serviceability_message text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_branch public.branches%rowtype;
  v_org public.organizations%rowtype;
  v_settings public.branch_ordering_settings%rowtype;
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
  v_coupon_id uuid;
  v_coupon_code text;
  v_discount_type text;
  v_discount_value numeric;
  v_zone public.delivery_zones%rowtype;
  v_pin text := trim(coalesce(p_delivery_pin_code, ''));
  v_type text := upper(trim(coalesce(p_fulfillment_type, '')));
  v_serviceable boolean := true;
  v_message text := 'Serviceable';
  v_est_min integer := 25;
  v_est_max integer := 40;
begin
  if v_type not in ('PICKUP', 'DELIVERY') then raise exception 'Invalid fulfillment type'; end if;
  select b.* into v_branch from public.branches b where b.id = p_branch_id and b.active = true;
  if v_branch.id is null then raise exception 'Branch not found or inactive'; end if;
  select o.* into v_org from public.organizations o where o.id = v_branch.organization_id and o.status = 'ACTIVE'::public.account_status;
  if v_org.id is null then raise exception 'Restaurant is inactive'; end if;
  v_settings := public.ensure_branch_ordering_settings(p_branch_id);
  if not v_settings.online_ordering_enabled then raise exception 'Online ordering is currently closed for this restaurant branch'; end if;
  if v_type = 'PICKUP' and not v_settings.pickup_enabled then raise exception 'Pickup ordering is not currently offered at this branch'; end if;
  if v_type = 'DELIVERY' and not v_settings.delivery_enabled then raise exception 'Delivery ordering is not currently offered at this branch'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Cart must be a JSON array'; end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'Cart is empty'; end if;

  v_snapshot := public.build16_calculate_cart(p_branch_id, p_items);
  -- Build 16 validates branch and stock availability; the public channel also
  -- excludes draft items even if a caller submits their UUID directly.
  if exists (
    select 1
    from jsonb_array_elements(v_snapshot) x
    join public.menu_items mi on mi.id = (x->>'menu_item_id')::uuid
    where mi.branch_id <> p_branch_id
       or mi.is_available = false
       or mi.is_draft = true
  ) then
    raise exception 'One or more cart items are not available for online ordering';
  end if;
  v_subtotal := round(coalesce((select sum((x->>'line_total')::numeric) from jsonb_array_elements(v_snapshot) x), 0), 2);
  if v_subtotal <= 0 then raise exception 'Cart is empty'; end if;
  if v_subtotal < v_settings.minimum_order_amount then
    raise exception 'Minimum order amount is ₹%', v_settings.minimum_order_amount;
  end if;
  if v_subtotal > v_settings.maximum_order_amount then
    raise exception 'Order exceeds this branch maximum order amount';
  end if;

  -- The coupon engine owns coupon scoping, eligibility, usage, and discount rules.
  -- A supplied invalid coupon must fail checkout; it must never become zero discount.
  if nullif(trim(coalesce(p_coupon_code, '')), '') is not null then
    select x.coupon_id, x.coupon_code, x.discount_type, x.discount_value, x.discount_amount
    into v_coupon_id, v_coupon_code, v_discount_type, v_discount_value, v_discount
    from public.build18_validate_coupon(p_branch_id, v_subtotal, v_snapshot, p_coupon_code, p_customer_phone, false) x;
    if v_coupon_id is null then raise exception 'Coupon could not be validated'; end if;
  end if;
  v_discount := least(greatest(coalesce(v_discount, 0), 0), v_subtotal);

  if v_type = 'PICKUP' then
    v_packaging := coalesce(v_settings.pickup_packaging_fee, 0);
    v_est_min := coalesce(v_settings.default_prep_minutes, 25);
    v_est_max := v_est_min + 15;
  else
    v_packaging := coalesce(v_settings.delivery_packaging_fee, 0);
    if v_pin !~ '^[0-9]{6}$' then
      v_serviceable := false;
      v_message := 'A valid 6-digit PIN code is required for delivery';
    else
      select * into v_zone
      from public.delivery_zones dz
      where dz.branch_id = p_branch_id and dz.is_active = true and v_pin = any(dz.supported_pin_codes)
      order by dz.priority desc, dz.delivery_fee asc, dz.id asc
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
        else
          v_delivery := v_zone.delivery_fee;
        end if;
      end if;
    end if;
  end if;

  if v_packaging > 0 then
    v_breakdown := v_breakdown || jsonb_build_object('name', 'Packaging charge', 'charge_type', 'FEE', 'calculation_type', 'FIXED', 'value', v_packaging, 'amount', v_packaging);
  end if;
  if v_type = 'DELIVERY' and v_zone.id is not null then
    v_breakdown := v_breakdown || jsonb_build_object('name', case when v_delivery = 0 then 'Free delivery' else 'Delivery fee (' || v_zone.name || ')' end, 'charge_type', 'FEE', 'calculation_type', 'FIXED', 'value', v_delivery, 'amount', v_delivery);
  end if;

  for v_charge in
    select c.name, c.charge_type, c.calculation_type, c.value
    from public.restaurant_charge_settings c
    where c.enabled = true
      and (c.branch_id = p_branch_id or (c.branch_id is null and not exists (
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
    if v_charge.charge_type = 'TAX' then v_tax := v_tax + v_amt; else v_additional := v_additional + v_amt; end if;
    v_breakdown := v_breakdown || jsonb_build_object('name', v_charge.name, 'charge_type', v_charge.charge_type, 'calculation_type', v_charge.calculation_type, 'value', v_charge.value, 'amount', v_amt);
  end loop;
  v_total := round(v_subtotal - v_discount + v_tax + v_additional + v_packaging + v_delivery, 2);
  if v_total > 1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;

  return query select
    v_subtotal, v_discount, round(v_subtotal - v_discount, 2), round(v_tax, 2),
    round(v_additional, 2), round(v_packaging, 2), round(v_delivery, 2), v_total,
    v_breakdown, v_coupon_id, v_coupon_code, v_discount_type, v_discount_value,
    v_zone.id, v_zone.name, v_est_min, v_est_max, v_serviceable, v_message;
end;
$$;
grant execute on function public.preview_public_fulfillment_checkout(uuid,text,jsonb,text,text,text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Idempotent public order creation with secure one-time verification codes
-- ---------------------------------------------------------------------------

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
  order_id uuid, order_number bigint, tracking_token text, fulfillment_type text,
  fulfillment_status text, subtotal numeric, tax numeric, additional_charges numeric,
  packaging_fee numeric, delivery_fee numeric, discount numeric, total numeric,
  charge_breakdown jsonb, payment_status public.payment_status,
  status public.order_status, pickup_code text, delivery_otp text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_branch public.branches%rowtype;
  v_org public.organizations%rowtype;
  v_settings public.branch_ordering_settings%rowtype;
  v_existing public.orders%rowtype;
  v_order public.orders%rowtype;
  v_preview record;
  v_coupon_lock record;
  v_phone text := nullif(regexp_replace(trim(coalesce(p_customer_phone, '')), '[^0-9]', '', 'g'), '');
  v_name text := nullif(left(trim(coalesce(p_customer_name, '')), 120), '');
  v_email text := nullif(lower(trim(coalesce(p_customer_email, ''))), '');
  v_method text := upper(trim(coalesce(p_payment_method, '')));
  v_type text := upper(trim(coalesce(p_fulfillment_type, '')));
  v_idem text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_fingerprint text;
  v_pickup_code text;
  v_delivery_otp text;
  v_snapshot jsonb;
  v_item jsonb;
  v_promised_ready timestamptz;
  v_promised_delivery timestamptz;
  v_random bytea;
begin
  if v_idem is null or length(v_idem) < 16 or length(v_idem) > 128 then
    raise exception 'A valid checkout idempotency key is required';
  end if;
  if v_name is null then raise exception 'Customer name is required'; end if;
  if v_phone is null then raise exception 'Valid customer phone is required'; end if;
  if length(v_phone) = 12 and left(v_phone, 2) = '91' then v_phone := right(v_phone, 10); end if;
  if length(v_phone) <> 10 or left(v_phone, 1) not in ('6','7','8','9') then
    raise exception 'Valid 10-digit Indian mobile number is required';
  end if;
  if v_type not in ('PICKUP','DELIVERY') then raise exception 'Fulfillment type must be PICKUP or DELIVERY'; end if;
  if v_method not in ('PICKUP_CASH','PICKUP_UPI','DELIVERY_CASH','DELIVERY_UPI') then
    raise exception 'Online prepaid checkout is not enabled in this foundation build; choose cash or UPI at handoff';
  end if;
  if (v_type = 'PICKUP' and left(v_method, 6) <> 'PICKUP') or (v_type = 'DELIVERY' and left(v_method, 8) <> 'DELIVERY') then
    raise exception 'Payment method does not match fulfillment type';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Cart must be a JSON array'; end if;
  if jsonb_array_length(p_items) = 0 then raise exception 'Cart is empty'; end if;

  select b.* into v_branch from public.branches b where b.id = p_branch_id and b.active = true;
  if v_branch.id is null then raise exception 'Branch not found or inactive'; end if;
  select o.* into v_org from public.organizations o where o.id = v_branch.organization_id and o.status = 'ACTIVE'::public.account_status;
  if v_org.id is null then raise exception 'Restaurant is inactive'; end if;
  v_settings := public.ensure_branch_ordering_settings(p_branch_id);
  if not v_settings.online_ordering_enabled then raise exception 'Online ordering is disabled for this branch'; end if;
  if v_type = 'PICKUP' and not v_settings.pickup_enabled then raise exception 'Pickup is disabled for this branch'; end if;
  if v_type = 'DELIVERY' and not v_settings.delivery_enabled then raise exception 'Delivery is disabled for this branch'; end if;
  if v_type = 'DELIVERY' and v_method = 'DELIVERY_CASH' and coalesce((v_settings.delivery_settings->>'cod_enabled')::boolean, false) = false then
    raise exception 'Cash on delivery is not enabled for this branch';
  end if;
  if v_type = 'DELIVERY' and v_method = 'DELIVERY_UPI' and coalesce((v_settings.delivery_settings->>'upi_on_delivery_enabled')::boolean, false) = false then
    raise exception 'UPI on delivery is not enabled for this branch';
  end if;
  if v_type = 'DELIVERY' and (
    jsonb_typeof(p_customer_address) <> 'object'
    or coalesce(p_customer_address->>'pin_code', '') !~ '^[0-9]{6}$'
    or trim(coalesce(p_customer_address->>'house', '')) = ''
    or trim(coalesce(p_customer_address->>'street', '')) = ''
    or trim(coalesce(p_delivery_pin_code, '')) <> (p_customer_address->>'pin_code')
  ) then raise exception 'A complete delivery address with matching 6-digit PIN code is required'; end if;
  if v_type = 'PICKUP' and p_customer_address is not null then
    raise exception 'Pickup orders cannot include a delivery address';
  end if;

  v_fingerprint := encode(extensions.digest(jsonb_build_object(
    'branch_id', p_branch_id, 'fulfillment_type', v_type, 'items', p_items,
    'payment_method', v_method, 'customer_name', v_name, 'customer_phone', v_phone,
    'customer_email', v_email, 'customer_address', p_customer_address,
    'delivery_pin_code', p_delivery_pin_code, 'delivery_instructions', p_delivery_instructions,
    'scheduled_for', p_scheduled_for, 'coupon_code', p_coupon_code, 'customer_note', p_customer_note
  )::text, 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(p_branch_id::text || ':' || v_idem, 0));
  select * into v_existing from public.orders o
  where o.branch_id = p_branch_id and o.idempotency_key = v_idem
  limit 1;
  if v_existing.id is not null then
    if v_existing.idempotency_fingerprint is null or v_existing.idempotency_fingerprint <> v_fingerprint then
      raise exception 'Idempotency key was already used for a different checkout';
    end if;
    return query
    select v_existing.id, v_existing.order_number, v_existing.tracking_token,
      v_existing.fulfillment_type, ofd.fulfillment_status, v_existing.subtotal,
      v_existing.tax, v_existing.additional_charges - coalesce(ofd.packaging_fee_snapshot,0) - coalesce(ofd.delivery_fee_snapshot,0),
      coalesce(ofd.packaging_fee_snapshot,0), coalesce(ofd.delivery_fee_snapshot,0),
      v_existing.discount, v_existing.total, v_existing.charge_breakdown,
      v_existing.payment_status, v_existing.status, null::text, null::text
    from public.order_fulfillment_details ofd where ofd.order_id = v_existing.id;
    return;
  end if;

  select * into v_preview from public.preview_public_fulfillment_checkout(
    p_branch_id, v_type, p_items, p_delivery_pin_code, p_coupon_code, v_phone
  );
  if not v_preview.is_serviceable then raise exception '%', v_preview.serviceability_message; end if;
  v_snapshot := public.build16_calculate_cart(p_branch_id, p_items);

  -- Revalidate with the coupon row locked. This serializes concurrent uses
  -- against the existing Build 18 usage limits before an order is committed.
  if nullif(trim(coalesce(p_coupon_code, '')), '') is not null then
    select x.coupon_id, x.coupon_code, x.discount_type, x.discount_value, x.discount_amount
    into v_coupon_lock
    from public.build18_validate_coupon(
      p_branch_id, v_preview.subtotal, v_snapshot, p_coupon_code, v_phone, true
    ) x;
    if v_coupon_lock.coupon_id is null then raise exception 'Coupon could not be validated'; end if;
    if v_coupon_lock.coupon_id is distinct from v_preview.coupon_id
      or round(v_coupon_lock.discount_amount, 2) <> round(v_preview.discount, 2) then
      raise exception 'Coupon pricing changed during checkout. Please review the updated total and retry.';
    end if;
  end if;

  if v_type = 'PICKUP' then
    v_random := extensions.gen_random_bytes(4);
    v_pickup_code := lpad((1000 + mod(
      get_byte(v_random, 0)::bigint * 16777216
      + get_byte(v_random, 1)::bigint * 65536
      + get_byte(v_random, 2)::bigint * 256
      + get_byte(v_random, 3)::bigint, 9000
    ))::text, 4, '0');
    v_promised_ready := coalesce(p_scheduled_for, now() + (v_preview.estimated_min_minutes || ' minutes')::interval);
  else
    v_random := extensions.gen_random_bytes(4);
    v_delivery_otp := lpad((1000 + mod(
      get_byte(v_random, 0)::bigint * 16777216
      + get_byte(v_random, 1)::bigint * 65536
      + get_byte(v_random, 2)::bigint * 256
      + get_byte(v_random, 3)::bigint, 9000
    ))::text, 4, '0');
    v_promised_ready := coalesce(p_scheduled_for, now() + (greatest(15, v_preview.estimated_min_minutes - 15) || ' minutes')::interval);
    v_promised_delivery := coalesce(p_scheduled_for + interval '30 minutes', now() + (v_preview.estimated_max_minutes || ' minutes')::interval);
  end if;
  insert into public.orders (
    branch_id, table_id, table_session_id, fulfillment_type, status, payment_status,
    payment_method, subtotal, tax, discount, additional_charges, total,
    charge_breakdown, idempotency_key, idempotency_fingerprint, checkout_snapshot,
    tracking_token, customer_note, customer_name, customer_phone, coupon_id,
    coupon_code_snapshot, discount_type_snapshot, discount_value_snapshot
  ) values (
    p_branch_id, null, null, v_type, 'NEW', 'PENDING', v_method,
    v_preview.subtotal, v_preview.tax, v_preview.discount,
    round(v_preview.additional_charges + v_preview.packaging_fee + v_preview.delivery_fee, 2),
    v_preview.total, v_preview.charge_breakdown, v_idem, v_fingerprint,
    jsonb_build_object('items', v_snapshot, 'subtotal', v_preview.subtotal,
      'discount', v_preview.discount, 'tax', v_preview.tax,
      'additional_charges', v_preview.additional_charges,
      'packaging_fee', v_preview.packaging_fee, 'delivery_fee', v_preview.delivery_fee,
      'total', v_preview.total, 'charge_breakdown', v_preview.charge_breakdown,
      'captured_at', now()),
    encode(extensions.gen_random_bytes(32), 'hex'),
    nullif(trim(coalesce(p_customer_note, '')), ''), v_name, v_phone,
    v_preview.coupon_id, v_preview.coupon_code, v_preview.discount_type, v_preview.discount_value
  ) returning * into v_order;

  insert into public.order_fulfillment_details (
    order_id, branch_id, fulfillment_type, fulfillment_status, scheduled_for,
    promised_ready_at, promised_delivery_at, customer_name_snapshot,
    customer_phone_snapshot, customer_email_snapshot, address_snapshot,
    delivery_zone_id, delivery_fee_snapshot, packaging_fee_snapshot,
    delivery_instructions, pickup_code_hash, delivery_otp_hash,
    pickup_code_expires_at, delivery_otp_expires_at
  ) values (
    v_order.id, p_branch_id, v_type,
    case when v_type = 'PICKUP' then 'WAITING_FOR_PICKUP' else 'WAITING_FOR_DRIVER' end,
    p_scheduled_for, v_promised_ready, v_promised_delivery,
    v_name, v_phone, v_email, p_customer_address,
    v_preview.delivery_zone_id, v_preview.delivery_fee, v_preview.packaging_fee,
    nullif(left(trim(coalesce(p_delivery_instructions, '')), 1000), ''),
    case when v_pickup_code is not null then crypt(v_order.id::text || ':' || v_pickup_code, gen_salt('bf', 12)) end,
    case when v_delivery_otp is not null then crypt(v_order.id::text || ':' || v_delivery_otp, gen_salt('bf', 12)) end,
    case when v_pickup_code is not null then now() + interval '12 hours' end,
    case when v_delivery_otp is not null then now() + interval '24 hours' end
  );

  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, metadata)
  values (v_order.id, p_branch_id, 'ORDER_CREATED', 'NOT_STARTED',
    case when v_type = 'PICKUP' then 'WAITING_FOR_PICKUP' else 'WAITING_FOR_DRIVER' end,
    jsonb_build_object('fulfillment_type', v_type, 'payment_method', v_method, 'total', v_preview.total));

  for v_item in select value from jsonb_array_elements(v_snapshot) loop
    insert into public.order_items (
      order_id, menu_item_id, item_name_snapshot, unit_price, quantity,
      selected_addons, special_instructions, selected_options, configuration_snapshot
    ) values (
      v_order.id, (v_item->>'menu_item_id')::uuid, v_item->>'item_name_snapshot',
      (v_item->>'unit_price')::numeric, (v_item->>'quantity')::integer,
      coalesce(v_item->'selected_addons', '[]'::jsonb),
      nullif(v_item->>'special_instructions', ''),
      coalesce(v_item->'selected_options', '[]'::jsonb), v_item
    );
  end loop;

  if v_preview.coupon_id is not null then
    insert into public.coupon_usages(
      coupon_id, order_id, organization_id, branch_id, table_id, table_session_id,
      customer_phone, coupon_code_snapshot, discount_type_snapshot,
      discount_value_snapshot, discount_amount
    ) values (
      v_preview.coupon_id, v_order.id, v_branch.organization_id, p_branch_id,
      null, null, v_phone, v_preview.coupon_code, v_preview.discount_type,
      v_preview.discount_value, v_preview.discount
    );
    insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
    values (v_order.id, p_branch_id, 'COUPON_APPLIED', null,
      jsonb_build_object('coupon_id', v_preview.coupon_id, 'coupon_code', v_preview.coupon_code,
        'discount', v_preview.discount, 'source', 'BUILD35_FULFILLMENT'));
  end if;

  return query select v_order.id, v_order.order_number, v_order.tracking_token,
    v_type, case when v_type = 'PICKUP' then 'WAITING_FOR_PICKUP' else 'WAITING_FOR_DRIVER' end,
    v_preview.subtotal, v_preview.tax, v_preview.additional_charges,
    v_preview.packaging_fee, v_preview.delivery_fee, v_preview.discount, v_preview.total,
    v_preview.charge_breakdown, v_order.payment_status, v_order.status,
    v_pickup_code, v_delivery_otp;
end;
$$;
grant execute on function public.create_public_fulfillment_order(uuid,text,jsonb,text,text,text,text,jsonb,text,text,timestamptz,text,text,text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Public tracking never returns OTPs / pickup codes
-- ---------------------------------------------------------------------------

drop function if exists public.get_public_fulfillment_order(text);
create function public.get_public_fulfillment_order(p_tracking_token text)
returns table (
  order_id uuid, order_number bigint, restaurant_name text, branch_name text,
  branch_address text, branch_phone text, fulfillment_type text,
  fulfillment_status text, status public.order_status,
  payment_status public.payment_status, payment_method text, subtotal numeric,
  tax numeric, additional_charges numeric, discount numeric, total numeric,
  charge_breakdown jsonb, created_at timestamptz, scheduled_for timestamptz,
  promised_ready_at timestamptz, promised_delivery_at timestamptz,
  pickup_code text, delivery_otp text, delivery_address jsonb,
  delivery_instructions text, rejection_reason text, items jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_order public.orders%rowtype;
  v_ofd public.order_fulfillment_details%rowtype;
  v_branch public.branches%rowtype;
  v_org public.organizations%rowtype;
  v_items jsonb;
begin
  if trim(coalesce(p_tracking_token, '')) !~ '^[a-f0-9]{32,64}$' then return; end if;
  select * into v_order from public.orders where tracking_token = trim(p_tracking_token) limit 1;
  if v_order.id is null then return; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = v_order.id;
  select * into v_branch from public.branches where id = v_order.branch_id;
  select * into v_org from public.organizations where id = v_branch.organization_id and status = 'ACTIVE'::public.account_status;
  if v_org.id is null then return; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', oi.id, 'name', oi.item_name_snapshot, 'quantity', oi.quantity,
    'unit_price', oi.unit_price, 'line_total', oi.line_total,
    'selected_addons', oi.selected_addons, 'selected_options', oi.selected_options,
    'special_instructions', oi.special_instructions
  ) order by oi.id asc), '[]'::jsonb)
  into v_items from public.order_items oi where oi.order_id = v_order.id;

  return query select v_order.id, v_order.order_number, v_org.name, v_branch.name,
    v_branch.address, v_branch.phone, v_order.fulfillment_type,
    coalesce(v_ofd.fulfillment_status, 'NOT_STARTED'), v_order.status,
    v_order.payment_status, v_order.payment_method, v_order.subtotal, v_order.tax,
    v_order.additional_charges, v_order.discount, v_order.total,
    v_order.charge_breakdown, v_order.created_at, v_ofd.scheduled_for,
    v_ofd.promised_ready_at, v_ofd.promised_delivery_at,
    null::text, null::text, v_ofd.address_snapshot,
    v_ofd.delivery_instructions, v_order.rejection_reason, v_items;
end;
$$;
grant execute on function public.get_public_fulfillment_order(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Fulfillment state transitions, OTP verification, rider and payment
-- ---------------------------------------------------------------------------

create or replace function public.fulfillment_list_eligible_riders(p_branch_id uuid)
returns table (id uuid, full_name text, role text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not (
    public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_DELIVERY')
    or public.current_user_has_permission_for_branch(p_branch_id, 'MANAGE_DELIVERY')
    or public.current_user_has_permission_for_branch(p_branch_id, 'ASSIGN_DELIVERY')
  ) then raise exception 'Permission denied: VIEW_DELIVERY required' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.branches b
    join public.organizations o on o.id = b.organization_id
    where b.id = p_branch_id and b.active = true and o.status = 'ACTIVE'::public.account_status
  ) then raise exception 'Branch not found or inactive'; end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'ASSIGN_DELIVERY') then
    return;
  end if;

  return query
  select s.id,
         coalesce(s.display_name, p.full_name, 'Staff') as full_name,
         s.role::text
  from public.staff s
  left join public.profiles p on p.id = s.user_id
  where s.branch_id = p_branch_id and s.active = true
    and (s.role = 'OWNER' or exists (
      select 1 from public.staff_permissions sp
      where sp.staff_id = s.id and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true
    ))
  order by coalesce(s.display_name, p.full_name, 'Staff') asc, s.id asc;
end;
$$;
revoke all on function public.fulfillment_list_eligible_riders(uuid) from public, anon;
grant execute on function public.fulfillment_list_eligible_riders(uuid) to authenticated;

create or replace function public.fulfillment_assign_rider(p_order_id uuid, p_staff_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'DELIVERY' then raise exception 'Delivery order not found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.status in ('CANCELLED','COMPLETED') then raise exception 'Order cannot be assigned in its current state'; end if;
  if v_ofd.fulfillment_status not in ('WAITING_FOR_DRIVER','ASSIGNED','READY_FOR_DISPATCH') then raise exception 'Delivery is not eligible for assignment'; end if;
  if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'ASSIGN_DELIVERY') then
    raise exception 'Permission denied: ASSIGN_DELIVERY required' using errcode = '42501';
  end if;
  select s.* into v_staff from public.staff s
  join public.branches b on b.id = s.branch_id and b.organization_id = s.organization_id
  where s.id = p_staff_id and s.branch_id = v_ofd.branch_id and s.active = true
  limit 1;
  if v_staff.id is null then raise exception 'Active delivery staff member not found in this branch'; end if;
  if v_staff.role <> 'OWNER' and not exists (
    select 1 from public.staff_permissions sp
    where sp.staff_id = v_staff.id and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true
  ) then raise exception 'Selected staff member is not authorized for delivery work'; end if;
  if v_ofd.assigned_staff_id = p_staff_id then return true; end if;

  update public.order_fulfillment_details
  set assigned_staff_id = p_staff_id, assigned_at = now(),
      fulfillment_status = case when v_order.status = 'READY' then 'READY_FOR_DISPATCH' else 'ASSIGNED' end, updated_at = now()
  where id = v_ofd.id;
  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (p_order_id, v_ofd.branch_id, 'RIDER_ASSIGNED', v_ofd.fulfillment_status,
    case when v_order.status = 'READY' then 'READY_FOR_DISPATCH' else 'ASSIGNED' end, auth.uid(),
    (select id from public.staff where user_id = auth.uid() and branch_id = v_ofd.branch_id order by created_at limit 1),
    jsonb_build_object('assigned_staff_id', p_staff_id, 'rider_name', coalesce(v_staff.display_name, (select pr.full_name from public.profiles pr where pr.id = v_staff.user_id), 'Staff')));
  return true;
end;
$$;
grant execute on function public.fulfillment_assign_rider(uuid,uuid) to authenticated;

create or replace function public.fulfillment_dispatch_delivery(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_actor_staff_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'DELIVERY' then raise exception 'Delivery order not found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  select s.id into v_actor_staff_id from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by (s.id = v_ofd.assigned_staff_id) desc, s.created_at limit 1;
  if not (
    exists (select 1 from public.staff rider
      where rider.id = v_ofd.assigned_staff_id and rider.user_id = auth.uid()
        and rider.branch_id = v_ofd.branch_id and rider.active = true
        and exists (select 1 from public.staff_permissions sp where sp.staff_id = rider.id
          and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true))
    or public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_DELIVERY')
  ) then raise exception 'Only the assigned delivery person or delivery manager can dispatch this order' using errcode = '42501'; end if;
  if v_ofd.fulfillment_status = 'OUT_FOR_DELIVERY' then return true; end if;
  if v_ofd.fulfillment_status <> 'READY_FOR_DISPATCH' or v_ofd.assigned_staff_id is null then
    raise exception 'Delivery must be assigned and the order must be READY before dispatch';
  end if;
  if v_order.status <> 'READY'::public.order_status then raise exception 'Order must be READY before dispatch'; end if;
  update public.order_fulfillment_details
  set fulfillment_status = 'OUT_FOR_DELIVERY', dispatched_at = now(), updated_at = now()
  where id = v_ofd.id;
  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (p_order_id, v_ofd.branch_id, 'OUT_FOR_DELIVERY', v_ofd.fulfillment_status, 'OUT_FOR_DELIVERY',
    auth.uid(), v_actor_staff_id, '{}'::jsonb);
  return true;
end;
$$;
grant execute on function public.fulfillment_dispatch_delivery(uuid) to authenticated;

-- Table-independent completion follows the existing Build 21 lifecycle. Dine-in
-- payment gates and staff capabilities remain unchanged.
create or replace function public.transition_order_status(
  p_order_id uuid,
  p_new_status public.order_status
)
returns table (
  id uuid, order_number bigint, table_id uuid, branch_id uuid,
  status public.order_status, payment_status public.payment_status,
  payment_method text, subtotal numeric, tax numeric, discount numeric,
  total numeric, created_at timestamptz, updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_ofd public.order_fulfillment_details%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_allowed boolean := false;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_order from public.orders where orders.id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found' using errcode = 'P0002'; end if;
  select s.* into v_staff from public.staff s
  where s.user_id = v_user and s.active = true
    and (s.branch_id = v_order.branch_id or (s.role = 'OWNER' and exists (
      select 1 from public.branches b where b.id = v_order.branch_id and b.organization_id = s.organization_id
    )))
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end, s.created_at
  limit 1;
  if v_staff.id is null then raise exception 'You do not have access to this order' using errcode = '42501'; end if;

  if (v_order.payment_method = 'PAY_NOW' or left(coalesce(v_order.payment_method, ''), 8) = 'PAY_NOW:')
     and v_order.status = 'NEW' and v_order.payment_status = 'PENDING' then
    raise exception 'Online payment is still pending; this order is not actionable';
  end if;

  if v_order.fulfillment_type in ('PICKUP','DELIVERY') and p_new_status = 'COMPLETED' then
    select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
    if v_order.payment_status <> 'PAID' then raise exception 'Payment must be collected before completing this order'; end if;
    if v_ofd.fulfillment_status not in ('PICKED_UP','DELIVERED') then raise exception 'Pickup or delivery must be confirmed before order completion'; end if;
    if v_order.status not in ('READY','SERVED') then raise exception 'Fulfillment order must be READY before completion'; end if;
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      or (v_order.fulfillment_type = 'PICKUP' and public.current_user_has_permission_for_branch(v_order.branch_id, 'MANAGE_PICKUP'))
      or (v_order.fulfillment_type = 'DELIVERY' and (
        public.current_user_has_permission_for_branch(v_order.branch_id, 'UPDATE_DELIVERY_STATUS')
        or public.current_user_has_permission_for_branch(v_order.branch_id, 'MANAGE_DELIVERY')
        or public.current_user_has_permission_for_branch(v_order.branch_id, 'COLLECT_DELIVERY_PAYMENT')
        or public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS')
      ))
      or (v_order.fulfillment_type = 'PICKUP' and (
        public.current_user_has_permission_for_branch(v_order.branch_id, 'MANAGE_PICKUP')
        or public.current_user_has_permission_for_branch(v_order.branch_id, 'COLLECT_DELIVERY_PAYMENT')
        or public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS')
      ));
  elsif v_order.payment_method = 'PAY_AT_COUNTER' and v_order.payment_status = 'PENDING'
    and ((v_order.status = 'NEW' and p_new_status in ('ACCEPTED','PREPARING'))
      or (v_order.status = 'ACCEPTED' and p_new_status = 'PREPARING')) then
    raise exception 'Counter payment is required before this order can be prepared';
  elsif v_order.status = 'NEW' and p_new_status = 'ACCEPTED' then
    if v_staff.role = 'KITCHEN' then
      v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
        and public.get_kitchen_order_acceptance(v_order.branch_id);
    else
      v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS');
    end if;
  elsif v_order.status = 'ACCEPTED' and p_new_status = 'PREPARING' then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen);
  elsif v_order.status = 'PREPARING' and p_new_status = 'READY' then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'KITCHEN_ACCESS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_kitchen);
  elsif v_order.status = 'READY' and p_new_status = 'SERVED' then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);
  elsif v_order.status = 'SERVED' and p_new_status = 'COMPLETED' then
    v_allowed := public.current_user_has_permission_for_branch(v_order.branch_id, 'EDIT_ORDERS')
      and (v_staff.role in ('OWNER','MANAGER') or v_staff.can_waiter);
  end if;
  if not v_allowed then raise exception 'Invalid or unauthorized order status transition: % → %', v_order.status, p_new_status using errcode = '42501'; end if;
  if p_new_status = 'COMPLETED' and v_order.payment_status <> 'PAID' then raise exception 'Payment must be marked paid before completing this order'; end if;

  update public.orders set status = p_new_status, updated_at = now() where orders.id = p_order_id;
  insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id)
  values (p_order_id, v_order.branch_id, 'STATUS_CHANGED', v_order.status::text, p_new_status::text, v_user);
  return query select o.id, o.order_number, o.table_id, o.branch_id, o.status, o.payment_status,
    o.payment_method, o.subtotal, o.tax, o.discount, o.total, o.created_at, o.updated_at
  from public.orders o where o.id = p_order_id;
end;
$$;
grant execute on function public.transition_order_status(uuid, public.order_status) to authenticated;
revoke execute on function public.transition_order_status(uuid, public.order_status) from anon, public;

create or replace function public.fulfillment_confirm_delivered(
  p_order_id uuid,
  p_delivery_otp text default null,
  p_manager_override boolean default false,
  p_override_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_actor_staff_id uuid;
  v_code_hash text;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'DELIVERY' then raise exception 'Delivery order not found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  select s.id into v_actor_staff_id from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by (s.id = v_ofd.assigned_staff_id) desc,
    case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end,
    s.created_at limit 1;

  if p_manager_override then
    if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_DELIVERY') then
      raise exception 'Manager override requires MANAGE_DELIVERY permission' using errcode = '42501';
    end if;
    if length(trim(coalesce(p_override_reason, ''))) < 8 then raise exception 'Manager override requires an audit reason of at least 8 characters'; end if;
  else
    if not exists (select 1 from public.staff rider
      where rider.id = v_ofd.assigned_staff_id and rider.user_id = auth.uid()
        and rider.branch_id = v_ofd.branch_id and rider.active = true
        and exists (select 1 from public.staff_permissions sp where sp.staff_id = rider.id
          and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true)) then
      raise exception 'Only the assigned authorized delivery person can confirm delivery' using errcode = '42501';
    end if;
  end if;
  if v_ofd.fulfillment_status = 'DELIVERED' then return true; end if;
  if v_ofd.fulfillment_status <> 'OUT_FOR_DELIVERY' then raise exception 'Only dispatched orders can be delivered'; end if;
  if v_order.status in ('CANCELLED','COMPLETED') then raise exception 'Order cannot be delivered in its current state'; end if;

  if not p_manager_override then
    if v_ofd.delivery_otp_hash is null or v_ofd.delivery_otp_used_at is not null
      or v_ofd.delivery_otp_expires_at is null or v_ofd.delivery_otp_expires_at <= now()
      or v_ofd.delivery_verification_attempts >= 5 then
      update public.order_fulfillment_details set delivery_verification_attempts = 5, updated_at = now() where id = v_ofd.id;
      return false;
    end if;
    v_code_hash := crypt(p_order_id::text || ':' || trim(coalesce(p_delivery_otp, '')), v_ofd.delivery_otp_hash);
    if v_code_hash is distinct from v_ofd.delivery_otp_hash then
      update public.order_fulfillment_details
      set delivery_verification_attempts = least(delivery_verification_attempts + 1, 5), updated_at = now()
      where id = v_ofd.id;
      return false;
    end if;
  end if;

  update public.order_fulfillment_details
  set fulfillment_status = 'DELIVERED', delivered_at = now(), delivery_otp_hash = null,
      delivery_otp_used_at = now(), updated_at = now()
  where id = v_ofd.id;
  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (p_order_id, v_ofd.branch_id, 'DELIVERED', v_ofd.fulfillment_status, 'DELIVERED',
    auth.uid(), v_actor_staff_id, jsonb_build_object('manager_override', p_manager_override,
      'override_reason', case when p_manager_override then left(trim(p_override_reason), 500) end));
  if v_order.payment_status = 'PAID' then perform public.transition_order_status(p_order_id, 'COMPLETED'::public.order_status); end if;
  return true;
end;
$$;
drop function if exists public.fulfillment_confirm_delivered(uuid,text,boolean);
grant execute on function public.fulfillment_confirm_delivered(uuid,text,boolean,text) to authenticated;
revoke execute on function public.fulfillment_confirm_delivered(uuid,text,boolean,text) from anon, public;

create or replace function public.fulfillment_confirm_pickup(
  p_order_id uuid,
  p_pickup_code text default null,
  p_manager_override boolean default false,
  p_override_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_actor_staff_id uuid;
  v_code_hash text;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'PICKUP' then raise exception 'Pickup order not found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  select s.id into v_actor_staff_id from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by s.created_at limit 1;
  if not public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_PICKUP') then
    raise exception 'Permission denied: MANAGE_PICKUP required' using errcode = '42501';
  end if;
  if v_ofd.fulfillment_status = 'PICKED_UP' then return true; end if;
  if v_ofd.fulfillment_status <> 'READY_FOR_PICKUP' then raise exception 'Pickup is not ready for handover'; end if;
  if v_order.status <> 'READY'::public.order_status then raise exception 'Order must be READY before pickup handover'; end if;
  if v_order.status in ('CANCELLED','COMPLETED') then raise exception 'Order cannot be picked up in its current state'; end if;

  if p_manager_override then
    if length(trim(coalesce(p_override_reason, ''))) < 8 then raise exception 'Manager override requires an audit reason of at least 8 characters'; end if;
  else
    if v_ofd.pickup_code_hash is null or v_ofd.pickup_code_used_at is not null
      or v_ofd.pickup_code_expires_at is null or v_ofd.pickup_code_expires_at <= now()
      or v_ofd.pickup_verification_attempts >= 5 then
      update public.order_fulfillment_details set pickup_verification_attempts = 5, updated_at = now() where id = v_ofd.id;
      return false;
    end if;
    v_code_hash := crypt(p_order_id::text || ':' || trim(coalesce(p_pickup_code, '')), v_ofd.pickup_code_hash);
    if v_code_hash is distinct from v_ofd.pickup_code_hash then
      update public.order_fulfillment_details
      set pickup_verification_attempts = least(pickup_verification_attempts + 1, 5), updated_at = now()
      where id = v_ofd.id;
      return false;
    end if;
  end if;

  update public.order_fulfillment_details
  set fulfillment_status = 'PICKED_UP', picked_up_at = now(), pickup_code_hash = null,
      pickup_code_used_at = now(), updated_at = now()
  where id = v_ofd.id;
  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (p_order_id, v_ofd.branch_id, 'PICKED_UP', v_ofd.fulfillment_status, 'PICKED_UP',
    auth.uid(), v_actor_staff_id, jsonb_build_object('manager_override', p_manager_override,
      'override_reason', case when p_manager_override then left(trim(p_override_reason), 500) end));
  if v_order.payment_status = 'PAID' then perform public.transition_order_status(p_order_id, 'COMPLETED'::public.order_status); end if;
  return true;
end;
$$;
drop function if exists public.fulfillment_confirm_pickup(uuid,text,boolean);
grant execute on function public.fulfillment_confirm_pickup(uuid,text,boolean,text) to authenticated;
revoke execute on function public.fulfillment_confirm_pickup(uuid,text,boolean,text) from anon, public;

create or replace function public.fulfillment_record_failed_delivery(p_order_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_actor_staff_id uuid;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if v_reason is null then raise exception 'A delivery failure reason is required'; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null or v_ofd.fulfillment_type <> 'DELIVERY' then raise exception 'Delivery order not found'; end if;
  select s.id into v_actor_staff_id from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_ofd.branch_id
  order by (s.id = v_ofd.assigned_staff_id) desc,
    case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end,
    s.created_at limit 1;
  if not (
    exists (select 1 from public.staff rider
      where rider.id = v_ofd.assigned_staff_id and rider.user_id = auth.uid()
        and rider.branch_id = v_ofd.branch_id and rider.active = true
        and exists (select 1 from public.staff_permissions sp where sp.staff_id = rider.id
          and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true))
    or public.current_user_has_permission_for_branch(v_ofd.branch_id, 'MANAGE_DELIVERY')
  ) then raise exception 'Only the assigned delivery person or delivery manager can record a failed delivery' using errcode = '42501'; end if;
  if v_ofd.fulfillment_status = 'DELIVERY_FAILED' then return true; end if;
  if v_ofd.fulfillment_status <> 'OUT_FOR_DELIVERY' then raise exception 'Only dispatched deliveries can be marked failed'; end if;
  update public.order_fulfillment_details
  set fulfillment_status = 'DELIVERY_FAILED', failed_at = now(), failure_reason = v_reason,
      delivery_otp_hash = null, updated_at = now()
  where id = v_ofd.id;
  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (p_order_id, v_ofd.branch_id, 'DELIVERY_FAILED', v_ofd.fulfillment_status, 'DELIVERY_FAILED', auth.uid(), v_actor_staff_id,
    jsonb_build_object('reason', v_reason));
  return true;
end;
$$;
grant execute on function public.fulfillment_record_failed_delivery(uuid,text) to authenticated;
revoke execute on function public.fulfillment_record_failed_delivery(uuid,text) from anon, public;

create or replace function public.fulfillment_collect_payment(p_order_id uuid, p_method text, p_amount numeric)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_order public.orders%rowtype;
  v_settings public.branch_ordering_settings%rowtype;
  v_actor public.staff%rowtype;
  v_method text := upper(trim(coalesce(p_method, '')));
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if v_method not in ('CASH','UPI') then raise exception 'Payment method must be CASH or UPI'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select * into v_ofd from public.order_fulfillment_details where order_id = p_order_id for update;
  if v_ofd.id is null then raise exception 'Fulfillment details not found'; end if;
  if v_order.status = 'CANCELLED' or v_order.payment_status = 'REFUNDED' then raise exception 'Cancelled or refunded orders cannot collect payment'; end if;
  select * into v_actor from public.staff s
  where s.user_id = auth.uid() and s.active = true and s.branch_id = v_order.branch_id
  order by (s.id = v_ofd.assigned_staff_id) desc,
    case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 else 2 end,
    s.created_at limit 1;
  if not (
    (v_ofd.fulfillment_type = 'DELIVERY' and public.current_user_has_permission_for_branch(v_order.branch_id, 'MANAGE_DELIVERY'))
    or (v_ofd.fulfillment_type = 'PICKUP' and public.current_user_has_permission_for_branch(v_order.branch_id, 'MANAGE_PICKUP'))
    or public.current_user_has_permission_for_branch(v_order.branch_id, 'PAYMENTS')
    or exists (select 1 from public.staff rider
      where rider.id = v_ofd.assigned_staff_id and rider.user_id = auth.uid()
        and rider.branch_id = v_order.branch_id and rider.active = true
        and exists (select 1 from public.staff_permissions sp where sp.staff_id = rider.id
          and sp.permission = 'COLLECT_DELIVERY_PAYMENT' and sp.allowed = true))
  ) then raise exception 'Only finance/delivery managers or the assigned rider with collection permission can collect payment' using errcode = '42501'; end if;
  if p_amount is null or round(p_amount, 2) <> round(v_order.total, 2) then
    raise exception 'Collected amount must exactly match order total (₹%)', v_order.total;
  end if;
  if v_order.payment_status = 'PAID' then
    if v_ofd.payment_collected_at is not null then return true; end if;
    raise exception 'Payment was already settled through another payment flow';
  end if;
  v_settings := public.ensure_branch_ordering_settings(v_order.branch_id);
  if v_ofd.fulfillment_type = 'DELIVERY' and v_method = 'CASH'
    and coalesce((v_settings.delivery_settings->>'cod_enabled')::boolean, false) = false then
    raise exception 'Cash on delivery is not enabled for this branch';
  end if;
  if v_ofd.fulfillment_type = 'DELIVERY' and v_method = 'UPI'
    and coalesce((v_settings.delivery_settings->>'upi_on_delivery_enabled')::boolean, false) = false then
    raise exception 'UPI on delivery is not enabled for this branch';
  end if;

  insert into public.payment_transactions(order_id, branch_id, provider, amount, status, method, raw_metadata)
  values (v_order.id, v_order.branch_id, 'MANUAL', v_order.total, 'PAID', v_method,
    jsonb_build_object('fulfillment_type', v_ofd.fulfillment_type, 'actor_user_id', auth.uid(), 'source', 'FULFILLMENT_COLLECTION'));
  update public.orders
  set payment_status = 'PAID', payment_method = v_ofd.fulfillment_type || '_' || v_method,
      paid_at = coalesce(paid_at, now()), updated_at = now()
  where id = v_order.id;
  update public.order_fulfillment_details
  set payment_collected_at = now(), payment_collected_by = v_actor.id,
      payment_collection_method = v_method, payment_collected_amount = v_order.total, updated_at = now()
  where id = v_ofd.id;
  insert into public.order_fulfillment_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id, actor_staff_id, metadata)
  values (v_order.id, v_order.branch_id, 'PAYMENT_COLLECTED', v_order.payment_status::text, 'PAID', auth.uid(), v_actor.id,
    jsonb_build_object('method', v_method, 'amount', v_order.total));
  if v_ofd.fulfillment_status in ('DELIVERED','PICKED_UP') then
    perform public.transition_order_status(v_order.id, 'COMPLETED'::public.order_status);
  end if;
  return true;
end;
$$;
grant execute on function public.fulfillment_collect_payment(uuid,text,numeric) to authenticated;
revoke execute on function public.fulfillment_collect_payment(uuid,text,numeric) from anon, public;

create or replace function public.fulfillment_list_my_deliveries()
returns table (
  order_id uuid, order_number bigint, customer_name text, customer_phone text,
  address_snapshot jsonb, delivery_instructions text, fulfillment_status text,
  payment_status public.payment_status, payment_method text, total numeric,
  delivery_fee numeric, promised_delivery_at timestamptz, created_at timestamptz,
  items jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select s.id into v_staff_id from public.staff s
  where s.user_id = auth.uid() and s.active = true
    and exists (select 1 from public.staff_permissions sp where sp.staff_id = s.id and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true)
  order by s.created_at limit 1;
  if not exists (select 1 from public.staff s where s.user_id = auth.uid() and s.active = true
    and exists (select 1 from public.staff_permissions sp where sp.staff_id = s.id and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true))
  then raise exception 'Active delivery staff permission is required' using errcode = '42501'; end if;

  return query
  select o.id, o.order_number, ofd.customer_name_snapshot, ofd.customer_phone_snapshot,
    ofd.address_snapshot, ofd.delivery_instructions, ofd.fulfillment_status,
    o.payment_status, o.payment_method, o.total, ofd.delivery_fee_snapshot,
    ofd.promised_delivery_at, o.created_at,
    coalesce((select jsonb_agg(jsonb_build_object('id', oi.id, 'name', oi.item_name_snapshot,
      'quantity', oi.quantity, 'unit_price', oi.unit_price, 'special_instructions', oi.special_instructions)
      order by oi.id) from public.order_items oi where oi.order_id = o.id), '[]'::jsonb)
  from public.order_fulfillment_details ofd
  join public.orders o on o.id = ofd.order_id
  join public.branches b on b.id = ofd.branch_id and b.active = true
  join public.organizations org on org.id = b.organization_id and org.status = 'ACTIVE'::public.account_status
  where ofd.assigned_staff_id in (select s.id from public.staff s where s.user_id = auth.uid() and s.active = true
      and exists (select 1 from public.staff_permissions sp where sp.staff_id = s.id
        and sp.permission = 'UPDATE_DELIVERY_STATUS' and sp.allowed = true))
    and ofd.fulfillment_type = 'DELIVERY'
    and ofd.fulfillment_status in ('ASSIGNED','READY_FOR_DISPATCH','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED')
  order by ofd.created_at desc;
end;
$$;
grant execute on function public.fulfillment_list_my_deliveries() to authenticated;
revoke execute on function public.fulfillment_list_my_deliveries() from anon, public;

create or replace function public.fulfillment_list_branch_orders(p_branch_id uuid, p_type text default null)
returns table (
  order_id uuid, order_number bigint, customer_name text, customer_phone text,
  fulfillment_type text, fulfillment_status text, order_status public.order_status,
  payment_status public.payment_status, payment_method text, total numeric,
  delivery_fee numeric, address_snapshot jsonb, delivery_instructions text,
  pickup_code text, delivery_otp text, assigned_staff_id uuid,
  assigned_staff_name text, promised_ready_at timestamptz,
  promised_delivery_at timestamptz, created_at timestamptz, items_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := nullif(upper(trim(coalesce(p_type, ''))), '');
  v_can_pickup boolean;
  v_can_delivery boolean;
  v_can_customer boolean;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.branches b where b.id = p_branch_id and b.active = true) then raise exception 'Branch not found or inactive'; end if;
  v_can_pickup := public.current_user_has_permission_for_branch(p_branch_id, 'MANAGE_PICKUP');
  v_can_delivery := public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_DELIVERY')
    or public.current_user_has_permission_for_branch(p_branch_id, 'MANAGE_DELIVERY')
    or public.current_user_has_permission_for_branch(p_branch_id, 'ASSIGN_DELIVERY');
  if (v_type = 'PICKUP' and not v_can_pickup) or (v_type = 'DELIVERY' and not v_can_delivery)
    or (v_type is null and not (v_can_pickup or v_can_delivery)) then
    raise exception 'Branch fulfillment permission denied' using errcode = '42501';
  end if;
  v_can_customer := public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_CUSTOMER_DETAILS');

  return query
  select o.id, o.order_number,
    case when v_can_customer then coalesce(nullif(trim(ofd.customer_name_snapshot), ''), nullif(trim(o.customer_name), ''), 'Customer') else 'Customer' end,
    case when v_can_customer then coalesce(nullif(trim(ofd.customer_phone_snapshot), ''), nullif(trim(o.customer_phone), ''), '—') else '—' end,
    ofd.fulfillment_type, ofd.fulfillment_status, o.status, o.payment_status, o.payment_method,
    o.total, coalesce(ofd.delivery_fee_snapshot, 0),
    case when v_can_delivery and v_can_customer then ofd.address_snapshot else null end,
    case when v_can_delivery and v_can_customer then ofd.delivery_instructions else null end,
    null::text, null::text, ofd.assigned_staff_id,
    coalesce(s.display_name, (select pr.full_name from public.profiles pr where pr.id = s.user_id), 'Staff') as assigned_staff_name,
    ofd.promised_ready_at, ofd.promised_delivery_at, o.created_at,
    (select count(*)::bigint from public.order_items oi where oi.order_id = o.id)
  from public.orders o
  join public.order_fulfillment_details ofd on ofd.order_id = o.id
  left join public.staff s on s.id = ofd.assigned_staff_id
  where ofd.branch_id = p_branch_id
    and (v_type is null or ofd.fulfillment_type = v_type)
    and ((ofd.fulfillment_type = 'PICKUP' and v_can_pickup)
      or (ofd.fulfillment_type = 'DELIVERY' and v_can_delivery))
  order by o.created_at desc
  limit 200;
end;
$$;
grant execute on function public.fulfillment_list_branch_orders(uuid,text) to authenticated;
revoke execute on function public.fulfillment_list_branch_orders(uuid,text) from anon, public;

-- ---------------------------------------------------------------------------
-- 10. Permission defaults: customer and fulfillment capabilities opt-in
-- ---------------------------------------------------------------------------

insert into public.staff_permissions(staff_id, permission, allowed)
select s.id, p.permission, (s.role = 'OWNER')
from public.staff s
cross join (values
  ('VIEW_CUSTOMER_DETAILS'), ('VIEW_FULFILLMENT_REPORTS'), ('VIEW_ONLINE_ORDERS'),
  ('MANAGE_ONLINE_ORDERING'), ('MANAGE_PICKUP'), ('VIEW_DELIVERY'),
  ('MANAGE_DELIVERY'), ('ASSIGN_DELIVERY'), ('UPDATE_DELIVERY_STATUS'),
  ('COLLECT_DELIVERY_PAYMENT')
) p(permission)
where not exists (
  select 1 from public.staff_permissions sp where sp.staff_id = s.id and sp.permission = p.permission
);

-- Explicitly revoke fulfillment/customer permissions that Build 35.1 granted
-- by default to every non-owner; managers can opt into them through staff settings.
update public.staff_permissions sp
set allowed = false, updated_at = now()
from public.staff s
where s.id = sp.staff_id and s.role <> 'OWNER'
  and sp.permission in (
    'VIEW_CUSTOMER_DETAILS','VIEW_FULFILLMENT_REPORTS','VIEW_ONLINE_ORDERS',
    'MANAGE_ONLINE_ORDERING','MANAGE_PICKUP','VIEW_DELIVERY','MANAGE_DELIVERY',
    'ASSIGN_DELIVERY','UPDATE_DELIVERY_STATUS','COLLECT_DELIVERY_PAYMENT'
  );

create or replace function public.set_staff_permission(
  p_staff_id uuid, p_permission text, p_allowed boolean
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
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if v_permission not in (
    'BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT','SETTINGS',
    'DISCOUNTS_COUPONS','VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS','ANALYTICS','MENU_MANAGEMENT',
    'INVENTORY_VIEW','INVENTORY_MANAGEMENT','INVENTORY_PURCHASE','INVENTORY_RECEIVE','INVENTORY_ADJUST',
    'INVENTORY_WASTAGE','INVENTORY_RECIPE_MANAGEMENT','INVENTORY_COST_VIEW','INVENTORY_TRANSFER',
    'VIEW_ONLINE_ORDERS','VIEW_CUSTOMER_DETAILS','MANAGE_ONLINE_ORDERING','MANAGE_PICKUP',
    'VIEW_DELIVERY','MANAGE_DELIVERY','ASSIGN_DELIVERY','UPDATE_DELIVERY_STATUS',
    'COLLECT_DELIVERY_PAYMENT','VIEW_DELIVERY_REPORTS','VIEW_FULFILLMENT_REPORTS'
  ) then raise exception 'Invalid permission name: %', p_permission; end if;
  select * into v_target from public.staff where id = p_staff_id and active = true;
  if v_target.id is null then raise exception 'Active staff record not found'; end if;
  if not exists (
    select 1 from public.staff s
    where s.user_id = auth.uid() and s.active = true and s.role = 'OWNER'
      and s.organization_id = v_target.organization_id
  ) then raise exception 'Only the organization owner can modify staff permissions' using errcode = '42501'; end if;
  insert into public.staff_permissions(staff_id, permission, allowed)
  values (p_staff_id, v_permission, coalesce(p_allowed, false))
  on conflict (staff_id, permission) do update set allowed = excluded.allowed, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.set_staff_permission(uuid,text,boolean) to authenticated;
revoke execute on function public.set_staff_permission(uuid,text,boolean) from anon, public;

-- Avoid giving sensitive fulfillment grants to staff created after this repair.
create or replace function public.ensure_default_staff_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sensitive text[] := array[
    'BILLING','CHARGES','PAYMENTS','STAFF_MANAGEMENT','BRANCH_MANAGEMENT','SUBSCRIPTION_MANAGEMENT','SETTINGS','DISCOUNTS_COUPONS',
    'INVENTORY_MANAGEMENT','INVENTORY_PURCHASE','INVENTORY_RECEIVE','INVENTORY_ADJUST','INVENTORY_WASTAGE',
    'INVENTORY_RECIPE_MANAGEMENT','INVENTORY_COST_VIEW','INVENTORY_TRANSFER',
    'MANAGE_ONLINE_ORDERING','VIEW_CUSTOMER_DETAILS','MANAGE_DELIVERY','ASSIGN_DELIVERY',
    'COLLECT_DELIVERY_PAYMENT','VIEW_DELIVERY_REPORTS','VIEW_FULFILLMENT_REPORTS'
  ];
  v_operational text[] := array['VIEW_ORDERS','EDIT_ORDERS','CANCEL_ORDERS','KITCHEN_ACCESS','ANALYTICS','MENU_MANAGEMENT'];
  v_inventory text[] := array['INVENTORY_VIEW','INVENTORY_MANAGEMENT','INVENTORY_PURCHASE','INVENTORY_RECEIVE','INVENTORY_ADJUST','INVENTORY_WASTAGE','INVENTORY_RECIPE_MANAGEMENT','INVENTORY_COST_VIEW','INVENTORY_TRANSFER'];
  v_fulfillment text[] := array['VIEW_ONLINE_ORDERS','VIEW_CUSTOMER_DETAILS','MANAGE_ONLINE_ORDERING','MANAGE_PICKUP','VIEW_DELIVERY','MANAGE_DELIVERY','ASSIGN_DELIVERY','UPDATE_DELIVERY_STATUS','COLLECT_DELIVERY_PAYMENT','VIEW_DELIVERY_REPORTS','VIEW_FULFILLMENT_REPORTS'];
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
    select new.id, p, false from unnest(v_sensitive || v_inventory || v_fulfillment) p
    on conflict (staff_id, permission) do nothing;
  end if;
  return new;
end;
$$;

-- Reports are financial/customer data and require an explicit report permission.
create or replace function public.fulfillment_get_reports(
  p_branch_id uuid, p_from timestamptz default null, p_to timestamptz default null
)
returns table (
  total_pickup_orders bigint, total_delivery_orders bigint, pickup_revenue numeric,
  delivery_revenue numeric, delivery_fees_collected numeric, packaging_fees_collected numeric,
  cod_collected numeric, upi_collected numeric, online_prepaid numeric,
  pending_collection numeric, failed_deliveries bigint, avg_prep_minutes numeric,
  avg_delivery_minutes numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from timestamptz := coalesce(p_from, now() - interval '30 days');
  v_to timestamptz := coalesce(p_to, now());
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if v_to <= v_from or v_to - v_from > interval '366 days' then raise exception 'Invalid report date range'; end if;
  if not (
    public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_FULFILLMENT_REPORTS')
    or public.current_user_has_permission_for_branch(p_branch_id, 'VIEW_DELIVERY_REPORTS')
    or public.current_user_has_permission_for_branch(p_branch_id, 'ANALYTICS')
  ) then raise exception 'Permission denied: fulfillment report permission required' using errcode = '42501'; end if;
  return query
  select
    count(*) filter (where ofd.fulfillment_type = 'PICKUP')::bigint,
    count(*) filter (where ofd.fulfillment_type = 'DELIVERY')::bigint,
    coalesce(sum(o.total) filter (where ofd.fulfillment_type = 'PICKUP' and o.status = 'COMPLETED'),0)::numeric,
    coalesce(sum(o.total) filter (where ofd.fulfillment_type = 'DELIVERY' and o.status = 'COMPLETED'),0)::numeric,
    coalesce(sum(ofd.delivery_fee_snapshot) filter (where o.payment_status = 'PAID'),0)::numeric,
    coalesce(sum(ofd.packaging_fee_snapshot) filter (where o.payment_status = 'PAID'),0)::numeric,
    coalesce(sum(ofd.payment_collected_amount) filter (where ofd.payment_collection_method = 'CASH'),0)::numeric,
    coalesce(sum(ofd.payment_collected_amount) filter (where ofd.payment_collection_method = 'UPI'),0)::numeric,
    coalesce(sum(o.total) filter (where o.payment_status = 'PAID' and ofd.payment_collected_at is null),0)::numeric,
    coalesce(sum(o.total) filter (where o.payment_status = 'PENDING' and o.status <> 'CANCELLED'),0)::numeric,
    count(*) filter (where ofd.fulfillment_status = 'DELIVERY_FAILED')::bigint,
    round(coalesce(avg(extract(epoch from (ofd.ready_at - o.created_at))/60.0) filter (where ofd.ready_at is not null),0),1)::numeric,
    round(coalesce(avg(extract(epoch from (ofd.delivered_at - ofd.dispatched_at))/60.0) filter (where ofd.delivered_at is not null and ofd.dispatched_at is not null),0),1)::numeric
  from public.order_fulfillment_details ofd
  join public.orders o on o.id = ofd.order_id
  where ofd.branch_id = p_branch_id and o.created_at >= v_from and o.created_at <= v_to;
end;
$$;
grant execute on function public.fulfillment_get_reports(uuid,timestamptz,timestamptz) to authenticated;
revoke execute on function public.fulfillment_get_reports(uuid,timestamptz,timestamptz) from anon, public;


-- ---------------------------------------------------------------------------
-- 11. Order lifecycle -> fulfillment event bridge
-- ---------------------------------------------------------------------------

create or replace function public.on_order_fulfillment_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ofd public.order_fulfillment_details%rowtype;
  v_event_type text;
  v_next_fulfillment_status text;
begin
  if new.status is not distinct from old.status then return new; end if;

  select * into v_ofd
  from public.order_fulfillment_details
  where order_id = new.id
  for update;
  if v_ofd.id is null then return new; end if;

  v_next_fulfillment_status := v_ofd.fulfillment_status;
  case new.status::text
    when 'ACCEPTED' then v_event_type := 'ORDER_ACCEPTED';
    when 'PREPARING' then v_event_type := 'PREPARATION_STARTED';
    when 'READY' then
      if v_ofd.fulfillment_type = 'PICKUP' then
        v_event_type := 'PICKUP_READY';
        v_next_fulfillment_status := 'READY_FOR_PICKUP';
      elsif v_ofd.fulfillment_type = 'DELIVERY' then
        v_event_type := 'DELIVERY_READY_FOR_DISPATCH';
        v_next_fulfillment_status := 'READY_FOR_DISPATCH';
      end if;
    when 'REJECTED' then
      v_event_type := 'ORDER_REJECTED';
      v_next_fulfillment_status := 'CANCELLED';
    when 'CANCELLED' then
      v_event_type := 'CANCELLED';
      v_next_fulfillment_status := 'CANCELLED';
    else
      return new;
  end case;

  if v_event_type is null then return new; end if;
  if v_next_fulfillment_status is distinct from v_ofd.fulfillment_status then
    update public.order_fulfillment_details
    set fulfillment_status = v_next_fulfillment_status,
        pickup_code_hash = case when v_next_fulfillment_status = 'CANCELLED' then null else pickup_code_hash end,
        delivery_otp_hash = case when v_next_fulfillment_status = 'CANCELLED' then null else delivery_otp_hash end,
        updated_at = now()
    where id = v_ofd.id;
  end if;

  insert into public.order_fulfillment_events(
    order_id, branch_id, event_type, from_status, to_status,
    actor_user_id, metadata
  ) values (
    new.id, new.branch_id, v_event_type, v_ofd.fulfillment_status,
    v_next_fulfillment_status, auth.uid(),
    jsonb_build_object('order_from_status', old.status::text,
      'order_to_status', new.status::text)
  );
  return new;
end;
$$;

revoke all on function public.on_order_fulfillment_status_change() from public, anon, authenticated;
drop trigger if exists orders_fulfillment_status_event on public.orders;
create trigger orders_fulfillment_status_event
after update of status on public.orders
for each row execute function public.on_order_fulfillment_status_change();

commit;
select pg_notify('pgrst', 'reload schema');
