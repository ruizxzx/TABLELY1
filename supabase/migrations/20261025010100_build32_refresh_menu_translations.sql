begin;

create or replace function public.invalidate_menu_translations_for_source_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  execute format(
    'delete from public.%I where %I = $1 and language_code in ($2, $3)',
    tg_argv[0],
    tg_argv[1]
  )
  using new.id, 'hi', 'bn';
  return new;
end;
$$;

revoke all on function public.invalidate_menu_translations_for_source_change() from public, anon, authenticated;

drop trigger if exists menu_category_translation_source_changed on public.menu_categories;
create trigger menu_category_translation_source_changed
after update of name on public.menu_categories
for each row
when (old.name is distinct from new.name)
execute function public.invalidate_menu_translations_for_source_change('menu_category_translations', 'category_id');

drop trigger if exists menu_subcategory_translation_source_changed on public.menu_subcategories;
create trigger menu_subcategory_translation_source_changed
after update of name on public.menu_subcategories
for each row
when (old.name is distinct from new.name)
execute function public.invalidate_menu_translations_for_source_change('menu_subcategory_translations', 'subcategory_id');

drop trigger if exists menu_item_translation_source_changed on public.menu_items;
create trigger menu_item_translation_source_changed
after update of name, description on public.menu_items
for each row
when (old.name is distinct from new.name or old.description is distinct from new.description)
execute function public.invalidate_menu_translations_for_source_change('menu_item_translations', 'menu_item_id');

drop trigger if exists menu_variant_translation_source_changed on public.menu_item_variants;
create trigger menu_variant_translation_source_changed
after update of name, description on public.menu_item_variants
for each row
when (old.name is distinct from new.name or old.description is distinct from new.description)
execute function public.invalidate_menu_translations_for_source_change('menu_variant_translations', 'variant_id');

drop trigger if exists modifier_group_translation_source_changed on public.modifier_groups;
create trigger modifier_group_translation_source_changed
after update of name, description on public.modifier_groups
for each row
when (old.name is distinct from new.name or old.description is distinct from new.description)
execute function public.invalidate_menu_translations_for_source_change('modifier_group_translations', 'modifier_group_id');

drop trigger if exists modifier_translation_source_changed on public.modifiers;
create trigger modifier_translation_source_changed
after update of name, description on public.modifiers
for each row
when (old.name is distinct from new.name or old.description is distinct from new.description)
execute function public.invalidate_menu_translations_for_source_change('modifier_translations', 'modifier_id');

commit;
