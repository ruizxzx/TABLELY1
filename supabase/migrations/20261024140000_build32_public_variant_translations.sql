begin;

create or replace function public.get_public_menu_for_table(p_table_code text)
returns table(
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
  dietary_tags jsonb,
  allergens jsonb,
  variants jsonb,
  modifier_groups jsonb,
  category_translations jsonb,
  subcategory_translations jsonb,
  item_translations jsonb
)
language sql stable security definer set search_path=public as $$
  select
    c.id,
    c.name,
    c.sort_order,
    s.id,
    s.name,
    s.sort_order,
    i.meal_section,
    i.id,
    i.name,
    i.description,
    i.price,
    i.image_url,
    i.is_available,
    i.is_veg,
    i.is_spicy,
    i.is_recommended,
    i.is_featured,
    i.is_popular,
    i.preparation_minutes,
    i.dietary_tags,
    i.allergens,
    coalesce(variant_data.variants, '[]'::jsonb) as variants,
    coalesce(modifier_group_data.modifier_groups, '[]'::jsonb) as modifier_groups,
    coalesce((select jsonb_agg(jsonb_build_object('language_code',ct.language_code,'name',ct.name) order by ct.language_code) from public.menu_category_translations ct where ct.category_id=c.id),'[]'::jsonb) category_translations,
    coalesce((select jsonb_agg(jsonb_build_object('language_code',st.language_code,'name',st.name) order by st.language_code) from public.menu_subcategory_translations st where st.subcategory_id=s.id),'[]'::jsonb) subcategory_translations,
    coalesce((select jsonb_agg(jsonb_build_object('language_code',it.language_code,'name',it.name,'description',it.description) order by it.language_code) from public.menu_item_translations it where it.menu_item_id=i.id),'[]'::jsonb) item_translations
  from public.tables t
  join public.branches b on b.id=t.branch_id
  join public.organizations o on o.id=b.organization_id
  join public.menu_items i on i.branch_id=b.id
  join public.menu_categories c on c.id=i.category_id and c.branch_id=b.id
  left join public.menu_subcategories s on s.id=i.subcategory_id and s.category_id=c.id and s.branch_id=b.id
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'id', v.id,
        'name', v.name,
        'description', v.description,
        'price_delta', v.price_delta,
        'is_default', v.is_default,
        'is_available', v.is_available,
        'sort_order', v.sort_order,
        'translations', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'language_code', vt.language_code,
              'name', vt.name,
              'description', vt.description
            ) order by vt.language_code
          )
          from public.menu_variant_translations vt
          where vt.variant_id = v.id
        ), '[]'::jsonb)
      ) order by v.sort_order, v.name
    ) as variants
    from public.menu_item_variants v
    where v.menu_item_id = i.id
  ) variant_data on true
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'id', mg.id,
        'name', mg.name,
        'description', mg.description,
        'translations', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'language_code', mgt.language_code,
              'name', mgt.name,
              'description', mgt.description
            ) order by mgt.language_code
          )
          from public.modifier_group_translations mgt
          where mgt.modifier_group_id = mg.id
        ), '[]'::jsonb),
        'is_required', mg.is_required,
        'selection_mode', mg.selection_mode,
        'min_select', mg.min_select,
        'max_select', mg.max_select,
        'sort_order', mig.sort_order,
        'modifiers', coalesce(modifier_data.modifiers, '[]'::jsonb)
      ) order by mig.sort_order, mg.sort_order, mg.name
    ) as modifier_groups
    from public.menu_item_modifier_groups mig
    join public.modifier_groups mg on mg.id = mig.modifier_group_id
    left join lateral (
      select jsonb_agg(
        jsonb_build_object(
          'id', m.id,
          'name', m.name,
          'description', m.description,
          'price_delta', m.price_delta,
          'is_available', m.is_available,
          'sort_order', m.sort_order,
          'translations', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'language_code', mt.language_code,
                'name', mt.name,
                'description', mt.description
              ) order by mt.language_code
            )
            from public.modifier_translations mt
            where mt.modifier_id = m.id
          ), '[]'::jsonb)
        ) order by m.sort_order, m.name
      ) as modifiers
      from public.modifiers m
      where m.modifier_group_id = mg.id
    ) modifier_data on true
    where mig.menu_item_id = i.id
  ) modifier_group_data on true
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
  order by c.sort_order,c.name,s.sort_order nulls first,s.name nulls first,i.name;
$$;

grant execute on function public.get_public_menu_for_table(text) to anon,authenticated;
revoke execute on function public.get_public_menu_for_table(text) from public;

commit;
