begin;

create or replace function public.inventory_get_recipe_version(
  p_recipe_id uuid,
  p_branch_id uuid,
  p_version_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_recipe public.inventory_recipes;
  v_version public.inventory_recipe_versions;
  v_can_view_cost boolean;
begin
  if not public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_VIEW')
     or not exists (
       select 1 from public.branches b
       where b.id = p_branch_id
         and public.organization_has_feature(b.organization_id, 'INVENTORY')
     ) then
    raise exception 'INVENTORY_VIEW permission required' using errcode = '42501';
  end if;

  select * into v_recipe
  from public.inventory_recipes r
  where r.id = p_recipe_id
    and r.organization_id = (select b.organization_id from public.branches b where b.id = p_branch_id)
    and (r.branch_id is null or r.branch_id = p_branch_id);
  if v_recipe.id is null then
    raise exception 'Recipe not found in this branch' using errcode = 'P0002';
  end if;

  select * into v_version
  from public.inventory_recipe_versions rv
  where rv.id = p_version_id and rv.recipe_id = v_recipe.id;
  if v_version.id is null then
    raise exception 'Recipe version does not belong to this recipe' using errcode = '42501';
  end if;
  v_can_view_cost := public.current_user_has_permission_for_branch(p_branch_id, 'INVENTORY_COST_VIEW');

  return jsonb_build_object(
    'version', case when v_can_view_cost
      then to_jsonb(v_version)
      else to_jsonb(v_version) - 'cost_per_serving_paise'
    end,
    'lines', (
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
        'sort_order', rl.sort_order
      ) order by rl.sort_order), '[]'::jsonb)
      from public.inventory_recipe_lines rl
      left join public.inventory_items ii on ii.id = rl.item_id
      left join public.inventory_recipes sr on sr.id = rl.sub_recipe_id
      where rl.version_id = v_version.id
    )
  );
end;
$$;
grant execute on function public.inventory_get_recipe_version(uuid, uuid, uuid) to authenticated;
revoke execute on function public.inventory_get_recipe_version(uuid, uuid, uuid) from anon, public;

select pg_notify('pgrst', 'reload schema');
commit;
