-- TABLELY BUILD 35.5 — Branch status compatibility and missing RPC recovery
-- Forward-only repair for databases where Build 35.3 RPCs are absent.

begin;

-- Earlier application and fulfillment SQL uses branches.active, while the
-- canonical branch status field is is_active. Keep legacy callers in sync.
alter table public.branches
  add column if not exists active boolean generated always as (is_active) stored;

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
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'branch_ordering_settings_audit'
      and policyname = 'branch_ordering_settings_audit_select'
  ) then
    create policy branch_ordering_settings_audit_select on public.branch_ordering_settings_audit
      for select to authenticated
      using (
        public.current_user_has_permission_for_branch(branch_id, 'MANAGE_ONLINE_ORDERING')
        or public.current_user_has_permission_for_branch(branch_id, 'SETTINGS')
      );
  end if;
end;
$$;
grant select on public.branch_ordering_settings_audit to authenticated;

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
    where b.id = p_branch_id and b.is_active = true and o.status = 'ACTIVE'::public.account_status
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

create or replace function public.save_branch_ordering_settings(
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
    where b.id = p_branch_id and b.is_active = true and o.status = 'ACTIVE'::public.account_status
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
  values (p_branch_id, auth.uid(), to_jsonb(v_before), to_jsonb(v_after));
  return v_after;
end;
$$;
revoke all on function public.save_branch_ordering_settings(uuid,boolean,boolean,boolean,integer,numeric,numeric,numeric,text,text,boolean,boolean,numeric,boolean) from public, anon;
grant execute on function public.save_branch_ordering_settings(uuid,boolean,boolean,boolean,integer,numeric,numeric,numeric,text,text,boolean,boolean,numeric,boolean) to authenticated;

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
    where b.id = p_branch_id and b.is_active = true and o.status = 'ACTIVE'::public.account_status
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
    where id = p_branch_id and organization_id = v_org.id and is_active = true;
    if v_branch.id is null then raise exception 'Selected branch does not belong to this restaurant or is inactive'; end if;
  else
    select * into v_branch
    from public.branches
    where organization_id = v_org.id and is_active = true
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
  where b.organization_id = v_org.id and b.is_active = true;

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

notify pgrst, 'reload schema';
commit;