-- TABLELY BUILD 34.3 — Recipe builder, versioning & costing engine
-- RPCs for creating/editing recipes, managing versions, calculating costs.
-- Additive/idempotent. Depends on 20261025030000 and 20261025040000.

begin;

-- ---------------------------------------------------------------------------
-- 1) Upsert recipe (creates new version on every save)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_upsert_recipe(
  p_organization_id uuid,
  p_id uuid default null,
  p_menu_item_id uuid default null,
  p_branch_id uuid default null,
  p_name text default null,
  p_description text default null,
  p_output_servings numeric default 1,
  p_output_unit text default 'serving',
  p_prep_time_minutes integer default null,
  p_cooking_time_minutes integer default null,
  p_instructions text default null,
  p_is_sub_recipe boolean default false,
  p_is_active boolean default true,
  p_change_reason text default null,
  -- Recipe lines as JSON array: [{item_id, sub_recipe_id, qty_per_serving, unit, yield_pct, sort_order}]
  p_lines jsonb default '[]'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipe public.inventory_recipes;
  v_version public.inventory_recipe_versions;
  v_line_row public.inventory_recipe_lines;
  v_next_version integer;
  v_line jsonb;
  v_item_id uuid;
  v_sub_recipe_id uuid;
  v_line_unit text;
  v_line_qty numeric;
  v_line_yield numeric;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_organization_id is null
     or not coalesce(public.organization_has_feature(p_organization_id, 'INVENTORY'), false) then
    raise exception 'Inventory is unavailable for this organization' using errcode = '42501';
  end if;

  if p_branch_id is not null and not exists (
    select 1 from public.branches b
    where b.id = p_branch_id and b.organization_id = p_organization_id
      and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_RECIPE_MANAGEMENT')
  ) then
    raise exception 'Recipe branch is outside the authorized organization or permission scope' using errcode = '42501';
  end if;

  if p_branch_id is null and not (
    public.is_org_owner(p_organization_id)
    or exists (
      select 1 from public.branches b
      where b.organization_id = p_organization_id
        and public.current_user_has_permission_for_branch(b.id, 'INVENTORY_RECIPE_MANAGEMENT')
    )
  ) then
    raise exception 'INVENTORY_RECIPE_MANAGEMENT permission required' using errcode = '42501';
  end if;

  if p_menu_item_id is not null and not exists (
    select 1 from public.menu_items mi
    join public.branches b on b.id = mi.branch_id
    where mi.id = p_menu_item_id
      and b.organization_id = p_organization_id
      and (p_branch_id is null or mi.branch_id = p_branch_id)
  ) then
    raise exception 'Menu item is outside the recipe organization or branch' using errcode = '42501';
  end if;

  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'Recipe lines must be a JSON array';
  end if;

  if p_id is not null then
    -- Update existing recipe master
    update public.inventory_recipes set
      menu_item_id = p_menu_item_id,
      branch_id = p_branch_id,
      name = coalesce(p_name, name),
      description = p_description,
      output_servings = coalesce(p_output_servings, output_servings),
      output_unit = coalesce(p_output_unit, output_unit),
      prep_time_minutes = p_prep_time_minutes,
      cooking_time_minutes = p_cooking_time_minutes,
      instructions = p_instructions,
      is_sub_recipe = coalesce(p_is_sub_recipe, is_sub_recipe),
      is_active = coalesce(p_is_active, is_active),
      updated_at = now()
    where id = p_id
      and organization_id = p_organization_id
      and branch_id is not distinct from p_branch_id
    returning * into v_recipe;

    if v_recipe.id is null then
      raise exception 'Recipe not found or access denied' using errcode = 'P0002';
    end if;
  else
    -- Create new recipe
    if p_name is null then raise exception 'name is required for new recipes'; end if;
    insert into public.inventory_recipes(
      organization_id, menu_item_id, branch_id, name, description,
      output_servings, output_unit, prep_time_minutes, cooking_time_minutes,
      instructions, is_sub_recipe, is_active, created_by
    ) values (
      p_organization_id, p_menu_item_id, p_branch_id, trim(p_name), p_description,
      coalesce(p_output_servings, 1), coalesce(p_output_unit, 'serving'),
      p_prep_time_minutes, p_cooking_time_minutes, p_instructions,
      coalesce(p_is_sub_recipe, false), coalesce(p_is_active, true), auth.uid()
    ) returning * into v_recipe;
  end if;

  -- Always create a new version when lines are provided
  if jsonb_array_length(coalesce(p_lines, '[]')) > 0 or p_id is null then
    -- Determine next version number
    select coalesce(max(version_number), 0) + 1 into v_next_version
    from public.inventory_recipe_versions
    where recipe_id = v_recipe.id;

    insert into public.inventory_recipe_versions(
      recipe_id, organization_id, version_number, effective_from, change_reason, created_by
    ) values (
      v_recipe.id, p_organization_id, v_next_version, now(),
      p_change_reason, auth.uid()
    ) returning * into v_version;

    -- Insert lines for this version
    for v_line in select * from jsonb_array_elements(coalesce(p_lines, '[]'))
    loop
      v_item_id := nullif((v_line->>'item_id')::text, '')::uuid;
      v_sub_recipe_id := nullif((v_line->>'sub_recipe_id')::text, '')::uuid;
      v_line_qty := nullif(v_line->>'qty_per_serving', '')::numeric;
      v_line_unit := nullif(trim(v_line->>'unit'), '');
      v_line_yield := coalesce(nullif(v_line->>'yield_pct', '')::numeric, 100);

      if v_item_id is null and v_sub_recipe_id is null then
        raise exception 'Each recipe line must have either item_id or sub_recipe_id';
      end if;
      if v_line_qty is null or v_line_qty <= 0 or v_line_unit is null
         or v_line_yield <= 0 or v_line_yield > 100 then
        raise exception 'Recipe line quantity, unit, or yield is invalid';
      end if;
      if v_item_id is not null and not exists (
        select 1 from public.inventory_items ii
        where ii.id = v_item_id and ii.organization_id = p_organization_id
          and ii.base_unit = v_line_unit
      ) then
        raise exception 'Recipe ingredient must belong to this organization and use its base unit' using errcode = '42501';
      end if;
      if v_sub_recipe_id is not null and not exists (
        select 1 from public.inventory_recipes sr
        where sr.id = v_sub_recipe_id
          and sr.organization_id = p_organization_id
          and sr.id <> v_recipe.id
          and sr.is_sub_recipe = true
          and (sr.branch_id is null or sr.branch_id is not distinct from p_branch_id)
          and sr.output_unit = v_line_unit
      ) then
        raise exception 'Sub-recipe must belong to this organization and use the declared output unit' using errcode = '42501';
      end if;
      if v_sub_recipe_id is not null and exists (
        with recursive descendants(recipe_id, path) as (
          select v_sub_recipe_id, array[v_sub_recipe_id]
          union all
          select child_line.sub_recipe_id, descendants.path || child_line.sub_recipe_id
          from descendants
          join public.inventory_recipes parent_recipe
            on parent_recipe.id = descendants.recipe_id
          join public.inventory_recipe_lines child_line
            on child_line.version_id = parent_recipe.current_version_id
          where child_line.sub_recipe_id is not null
            and not child_line.sub_recipe_id = any(descendants.path)
        )
        select 1 from descendants where recipe_id = v_recipe.id
      ) then
        raise exception 'Sub-recipe would create a recipe cycle';
      end if;

      insert into public.inventory_recipe_lines(
        version_id, recipe_id, organization_id,
        item_id, sub_recipe_id,
        qty_per_serving, unit, yield_pct, sort_order
      ) values (
        v_version.id, v_recipe.id, p_organization_id,
        v_item_id, v_sub_recipe_id,
        (v_line->>'qty_per_serving')::numeric,
        v_line->>'unit',
        coalesce((v_line->>'yield_pct')::numeric, 100),
        coalesce((v_line->>'sort_order')::integer, 0)
      );
    end loop;

    -- Update recipe's current_version_id
    update public.inventory_recipes
    set current_version_id = v_version.id, updated_at = now()
    where id = v_recipe.id;

    update public.inventory_recipe_versions rv
    set cost_per_serving_paise = case
      when exists (
        select 1 from public.inventory_recipe_lines rl
        where rl.version_id = v_version.id and rl.sub_recipe_id is not null
      ) then null
      else (
        select coalesce(sum(
          rl.gross_qty_per_serving * coalesce(
            (select ib.avg_unit_cost_paise
             from public.inventory_balances ib
             where ib.item_id = rl.item_id and ib.branch_id = p_branch_id
             limit 1),
            (select (iis.unit_price_paise::numeric / ii.purchase_unit_conversion)::bigint
             from public.inventory_item_suppliers iis
             join public.inventory_items ii on ii.id = iis.item_id
             where iis.item_id = rl.item_id and iis.is_preferred = true
             limit 1),
            0
          )
        ), 0)::bigint
        from public.inventory_recipe_lines rl
        where rl.version_id = v_version.id
      )
    end
    where rv.id = v_version.id;
  end if;

  return jsonb_build_object(
    'recipe', row_to_json(v_recipe),
    'version', row_to_json(v_version),
    'lines', (
      select coalesce(jsonb_agg(l order by l.sort_order), '[]')
      from public.inventory_recipe_lines l
      where l.version_id = v_version.id
    )
  );
end;
$$;
grant execute on function public.inventory_upsert_recipe to authenticated;
revoke execute on function public.inventory_upsert_recipe from anon, public;

-- ---------------------------------------------------------------------------
-- 2) Calculate recipe cost (reads ingredient prices from item_suppliers)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_calculate_recipe_cost(
  p_recipe_id uuid,
  p_branch_id uuid,
  p_version_id uuid default null  -- null = current version
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_recipe public.inventory_recipes;
  v_version_id uuid;
  v_total_cost_paise bigint := 0;
  v_result jsonb;
  v_line_costs jsonb := '[]';
  v_org uuid;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW') then
    raise exception 'INVENTORY_COST_VIEW permission required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  select * into v_recipe from public.inventory_recipes where id = p_recipe_id;
  if v_recipe.id is null or v_recipe.organization_id <> (
    select organization_id from public.branches where id = p_branch_id
  ) or (v_recipe.branch_id is not null and v_recipe.branch_id <> p_branch_id) then
    raise exception 'Recipe not found in this branch' using errcode = 'P0002';
  end if;

  v_version_id := coalesce(p_version_id, v_recipe.current_version_id);
  if v_version_id is null then
    return jsonb_build_object('error', 'Recipe has no saved version yet', 'total_cost_paise', 0);
  end if;
  if not exists (
    select 1 from public.inventory_recipe_versions rv
    where rv.id = v_version_id and rv.recipe_id = v_recipe.id
  ) then
    raise exception 'Recipe version does not belong to this recipe' using errcode = '42501';
  end if;

  select organization_id into v_org from public.branches where id = p_branch_id;

  -- Build cost for each line
  select
    coalesce(sum(
      case
        when rl.item_id is not null then
          -- Item cost: gross_qty * avg_unit_cost (from inventory_balances, or supplier price as fallback)
          (rl.gross_qty_per_serving * coalesce(
            (select ib.avg_unit_cost_paise from public.inventory_balances ib
             where ib.item_id = rl.item_id and ib.branch_id = p_branch_id limit 1),
            -- Fallback: preferred supplier unit_price (convert from purchase_unit to base_unit)
            (select
              (iis.unit_price_paise::numeric / ii.purchase_unit_conversion)::bigint
             from public.inventory_item_suppliers iis
             join public.inventory_items ii on ii.id = iis.item_id
             where iis.item_id = rl.item_id and iis.is_preferred = true
             limit 1),
            0
          ))::bigint
        when rl.sub_recipe_id is not null then
          (rl.gross_qty_per_serving * coalesce((
            public.inventory_calculate_recipe_cost(rl.sub_recipe_id, p_branch_id, null)
              ->> 'cost_per_serving_paise'
          )::numeric, 0))::bigint
        else 0
      end
    ), 0) * v_recipe.output_servings
  into v_total_cost_paise
  from public.inventory_recipe_lines rl
  where rl.version_id = v_version_id;

  -- Build line-level cost breakdown
  select coalesce(jsonb_agg(jsonb_build_object(
    'line_id', rl.id,
    'item_id', rl.item_id,
    'item_name', ii.name,
    'sub_recipe_id', rl.sub_recipe_id,
    'qty_per_serving', rl.qty_per_serving,
    'gross_qty_per_serving', rl.gross_qty_per_serving,
    'unit', rl.unit,
    'yield_pct', rl.yield_pct,
    'unit_cost_paise', case when rl.item_id is not null then coalesce(
      (select ib.avg_unit_cost_paise from public.inventory_balances ib
       where ib.item_id = rl.item_id and ib.branch_id = p_branch_id limit 1),
      (select (iis.unit_price_paise::numeric / ii2.purchase_unit_conversion)::bigint
       from public.inventory_item_suppliers iis
       join public.inventory_items ii2 on ii2.id = iis.item_id
       where iis.item_id = rl.item_id and iis.is_preferred = true limit 1),
      0
    ) when rl.sub_recipe_id is not null then
      (public.inventory_calculate_recipe_cost(rl.sub_recipe_id, p_branch_id, null)
        ->> 'cost_per_serving_paise')::bigint
    else 0 end,
    'line_cost_paise', case when rl.item_id is not null then
      (rl.gross_qty_per_serving * coalesce(
        (select ib.avg_unit_cost_paise from public.inventory_balances ib
         where ib.item_id = rl.item_id and ib.branch_id = p_branch_id limit 1),
        (select (iis.unit_price_paise::numeric / ii2.purchase_unit_conversion)::bigint
         from public.inventory_item_suppliers iis
         join public.inventory_items ii2 on ii2.id = iis.item_id
         where iis.item_id = rl.item_id and iis.is_preferred = true limit 1),
        0
      ))::bigint
    when rl.sub_recipe_id is not null then
      (rl.gross_qty_per_serving * coalesce((
        public.inventory_calculate_recipe_cost(rl.sub_recipe_id, p_branch_id, null)
          ->> 'cost_per_serving_paise'
      )::numeric, 0))::bigint
    else 0 end,
    'sort_order', rl.sort_order
  ) order by rl.sort_order), '[]')
  into v_line_costs
  from public.inventory_recipe_lines rl
  left join public.inventory_items ii on ii.id = rl.item_id
  where rl.version_id = v_version_id;

  return jsonb_build_object(
    'recipe_id', p_recipe_id,
    'version_id', v_version_id,
    'output_servings', v_recipe.output_servings,
    'total_cost_paise', v_total_cost_paise,
    'cost_per_serving_paise', case when v_recipe.output_servings > 0
      then (v_total_cost_paise / v_recipe.output_servings)::bigint else 0 end,
    'lines', v_line_costs
  );
end;
$$;
grant execute on function public.inventory_calculate_recipe_cost(uuid, uuid, uuid) to authenticated;
revoke execute on function public.inventory_calculate_recipe_cost(uuid, uuid, uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- 3) List recipes for a branch/org
-- ---------------------------------------------------------------------------
create or replace function public.inventory_list_recipes(
  p_branch_id uuid,
  p_search text default null,
  p_is_sub_recipe boolean default null
)
returns table(
  id uuid,
  name text,
  description text,
  menu_item_id uuid,
  menu_item_name text,
  output_servings numeric,
  output_unit text,
  is_sub_recipe boolean,
  is_active boolean,
  current_version_id uuid,
  version_number integer,
  cost_per_serving_paise bigint,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
#variable_conflict use_column
declare v_org uuid; v_can_view_cost boolean;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;

  select b.organization_id into v_org from public.branches b where b.id = p_branch_id;
  if not public.organization_has_feature(v_org, 'INVENTORY') then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;
  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return query
  select
    r.id,
    r.name,
    r.description,
    r.menu_item_id,
    mi.name as menu_item_name,
    r.output_servings,
    r.output_unit,
    r.is_sub_recipe,
    r.is_active,
    r.current_version_id,
    rv.version_number,
    case when v_can_view_cost then rv.cost_per_serving_paise else null end,
    r.updated_at
  from public.inventory_recipes r
  left join public.menu_items mi on mi.id = r.menu_item_id
  left join public.inventory_recipe_versions rv on rv.id = r.current_version_id
  where r.organization_id = v_org
    and (r.branch_id is null or r.branch_id = p_branch_id)
    and r.is_active = true
    and (p_search is null or r.name ilike '%' || p_search || '%')
    and (p_is_sub_recipe is null or r.is_sub_recipe = p_is_sub_recipe)
  order by r.name;
end;
$$;
grant execute on function public.inventory_list_recipes(uuid, text, boolean) to authenticated;
revoke execute on function public.inventory_list_recipes(uuid, text, boolean) from anon, public;

-- ---------------------------------------------------------------------------
-- 4) Get recipe with lines (for the recipe builder)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_get_recipe(p_recipe_id uuid, p_branch_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_recipe public.inventory_recipes;
  v_has_cost_view boolean;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW') then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  v_has_cost_view := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  select * into v_recipe from public.inventory_recipes where id = p_recipe_id;
  if v_recipe.id is null
     or v_recipe.organization_id <> (select organization_id from public.branches where id = p_branch_id)
     or (v_recipe.branch_id is not null and v_recipe.branch_id <> p_branch_id) then
    raise exception 'Recipe not found in this branch' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'recipe', row_to_json(v_recipe),
    'versions', (
      select coalesce(jsonb_agg(
        case when v_has_cost_view then to_jsonb(v) else to_jsonb(v) - 'cost_per_serving_paise' end
        order by v.version_number desc
      ), '[]'::jsonb)
      from public.inventory_recipe_versions v
      where v.recipe_id = p_recipe_id
    ),
    'current_lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', rl.id,
        'item_id', rl.item_id,
        'item_name', ii.name,
        'item_base_unit', ii.base_unit,
        'sub_recipe_id', rl.sub_recipe_id,
        'sub_recipe_name', sr.name,
        'qty_per_serving', rl.qty_per_serving,
        'gross_qty_per_serving', rl.gross_qty_per_serving,
        'unit', rl.unit,
        'yield_pct', rl.yield_pct,
        'sort_order', rl.sort_order,
        'available_qty', case when v_has_cost_view then
          (select ib.available_qty from public.inventory_balances ib
           where ib.item_id = rl.item_id and ib.branch_id = p_branch_id limit 1)
          else null end,
        'unit_cost_paise', case when v_has_cost_view then
          coalesce(
            (select ib.avg_unit_cost_paise from public.inventory_balances ib
             where ib.item_id = rl.item_id and ib.branch_id = p_branch_id limit 1),
            (select (iis.unit_price_paise::numeric / ii2.purchase_unit_conversion)::bigint
             from public.inventory_item_suppliers iis
             join public.inventory_items ii2 on ii2.id = iis.item_id
             where iis.item_id = rl.item_id and iis.is_preferred = true limit 1),
            0
          )
          else null end
      ) order by rl.sort_order), '[]')
      from public.inventory_recipe_lines rl
      left join public.inventory_items ii on ii.id = rl.item_id
      left join public.inventory_recipes sr on sr.id = rl.sub_recipe_id
      where rl.version_id = v_recipe.current_version_id
    ),
    'linked_menu_item', (
      select row_to_json(mi) from public.menu_items mi where mi.id = v_recipe.menu_item_id
    )
  );
end;
$$;
grant execute on function public.inventory_get_recipe(uuid, uuid) to authenticated;
revoke execute on function public.inventory_get_recipe(uuid, uuid) from anon, public;

-- ---------------------------------------------------------------------------
-- 5) Menu cost report (all menu items with their recipe cost vs selling price)
-- ---------------------------------------------------------------------------
create or replace function public.inventory_menu_cost_report(p_branch_id uuid)
returns table(
  menu_item_id uuid,
  menu_item_name text,
  selling_price_paise bigint,
  recipe_id uuid,
  recipe_name text,
  recipe_version_id uuid,
  cost_per_serving_paise bigint,
  food_cost_pct numeric,
  gross_contribution_paise bigint,
  gross_margin_pct numeric
)
language plpgsql
security definer
stable
set search_path = public
as $$
#variable_conflict use_column
declare v_org uuid;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW') then
    raise exception 'INVENTORY_COST_VIEW permission required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.branches b
    where b.id = p_branch_id
      and public.organization_has_feature(b.organization_id, 'INVENTORY')
  ) then
    raise exception 'Inventory is unavailable for this branch' using errcode = '42501';
  end if;

  select b.organization_id into v_org from public.branches b where b.id = p_branch_id;

  return query
  select
    mi.id as menu_item_id,
    mi.name as menu_item_name,
    -- selling price in paise (mi.price is in INR decimal; convert to paise)
    (mi.price * 100)::bigint as selling_price_paise,
    r.id as recipe_id,
    r.name as recipe_name,
    r.current_version_id as recipe_version_id,
    rv.cost_per_serving_paise as cost_per_serving_paise,
    -- Food cost % = (recipe cost / net selling price) * 100
    case when mi.price > 0 and rv.cost_per_serving_paise is not null
      then round((rv.cost_per_serving_paise::numeric / (mi.price * 100)) * 100, 2)
      else null
    end as food_cost_pct,
    -- Gross contribution per serving in paise
    case when rv.cost_per_serving_paise is not null
      then (mi.price * 100)::bigint - rv.cost_per_serving_paise
      else null
    end as gross_contribution_paise,
    -- Gross margin % = (contribution / selling price) * 100
    case when mi.price > 0 and rv.cost_per_serving_paise is not null
      then round(((mi.price * 100 - rv.cost_per_serving_paise)::numeric / (mi.price * 100)) * 100, 2)
      else null
    end as gross_margin_pct
  from public.menu_items mi
  left join public.inventory_recipes r
    on r.menu_item_id = mi.id
    and r.is_active = true
    and (r.branch_id is null or r.branch_id = p_branch_id)
  left join public.inventory_recipe_versions rv on rv.id = r.current_version_id
  where mi.branch_id = p_branch_id
    and mi.is_available = true
  order by mi.name;
end;
$$;
grant execute on function public.inventory_menu_cost_report(uuid) to authenticated;
revoke execute on function public.inventory_menu_cost_report(uuid) from anon, public;

select pg_notify('pgrst', 'reload schema');
commit;
