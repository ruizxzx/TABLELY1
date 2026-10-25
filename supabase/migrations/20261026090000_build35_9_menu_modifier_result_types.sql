-- TABLELY BUILD 35.9 — Match public menu RPC output types to menu_items
-- The source columns dietary_tags and allergens are jsonb, not text arrays.

begin;

drop function if exists public.get_public_menu_for_branch(uuid);

create function public.get_public_menu_for_branch(p_branch_id uuid)
returns table (
  category_id uuid, category_name text, category_sort integer,
  subcategory_id uuid, subcategory_name text, subcategory_sort integer,
  meal_section text, item_id uuid, item_name text, item_description text,
  item_price numeric, image_url text, is_available boolean, is_veg boolean,
  is_spicy boolean, is_recommended boolean, is_featured boolean, is_popular boolean,
  preparation_minutes integer, dietary_tags jsonb, allergens jsonb, addons jsonb,
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
    where b.id = p_branch_id and b.is_active = true and o.status = 'ACTIVE'::public.account_status
  ) then
    raise exception 'Branch not found or inactive';
  end if;

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
        'translations', coalesce((
          select jsonb_agg(jsonb_build_object(
            'language_code', vt.language_code, 'name', vt.name, 'description', vt.description
          ) order by vt.language_code)
          from public.menu_variant_translations vt where vt.variant_id = v.id
        ), '[]'::jsonb)
      ) order by v.sort_order, v.name)
      from public.menu_item_variants v
      where v.menu_item_id = mi.id and v.is_available = true
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mg.id,
        'name', mg.name,
        'description', mg.description,
        'translations', coalesce((
          select jsonb_agg(jsonb_build_object(
            'language_code', mgt.language_code,
            'name', mgt.name,
            'description', mgt.description
          ) order by mgt.language_code)
          from public.modifier_group_translations mgt where mgt.modifier_group_id = mg.id
        ), '[]'::jsonb),
        'is_required', mg.is_required,
        'selection_mode', mg.selection_mode,
        'min_select', mg.min_select,
        'max_select', mg.max_select,
        'sort_order', mig.sort_order,
        'modifiers', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', m.id,
            'name', m.name,
            'description', m.description,
            'price_delta', m.price_delta,
            'is_available', m.is_available,
            'sort_order', m.sort_order,
            'translations', coalesce((
              select jsonb_agg(jsonb_build_object(
                'language_code', mt.language_code,
                'name', mt.name,
                'description', mt.description
              ) order by mt.language_code)
              from public.modifier_translations mt where mt.modifier_id = m.id
            ), '[]'::jsonb)
          ) order by m.sort_order, m.name)
          from public.modifiers m
          where m.modifier_group_id = mg.id and m.is_available = true
        ), '[]'::jsonb)
      ) order by mig.sort_order, mg.sort_order, mg.name)
      from public.menu_item_modifier_groups mig
      join public.modifier_groups mg on mg.id = mig.modifier_group_id and mg.is_active = true
      where mig.menu_item_id = mi.id
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('language_code', ct.language_code, 'name', ct.name) order by ct.language_code)
      from public.menu_category_translations ct where ct.category_id = c.id
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('language_code', st.language_code, 'name', st.name) order by st.language_code)
      from public.menu_subcategory_translations st where st.subcategory_id = sc.id
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'language_code', it.language_code, 'name', it.name, 'description', it.description
      ) order by it.language_code)
      from public.menu_item_translations it where it.menu_item_id = mi.id
    ), '[]'::jsonb)
  from public.menu_items mi
  join public.menu_categories c on c.id = mi.category_id
  left join public.menu_subcategories sc on sc.id = mi.subcategory_id
  where mi.branch_id = p_branch_id and mi.is_draft = false and mi.is_available = true
  order by c.sort_order asc, sc.sort_order asc nulls first, mi.name asc;
end;
$$;

grant execute on function public.get_public_menu_for_branch(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
commit;