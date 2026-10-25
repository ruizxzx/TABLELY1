-- TABLELY BUILD 35.7 — Make optional storefront cover compatible with organization schema
-- Forward-only replacement for databases where organizations has no cover image column.

begin;

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
    v_org.id, v_org.name, v_org.slug, v_org.logo_url, null::text,
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