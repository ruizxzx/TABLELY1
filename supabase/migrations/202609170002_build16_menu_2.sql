-- TABLELY BUILD 16 — MENU 2.0 + MODIFIER ENGINE
-- Additive migration built on the verified Build 15 V4 baseline.
-- No Build 14/15 security/payment behavior is intentionally changed.
begin;

-- ============================================================
-- 1. Menu hierarchy / merchandising fields
-- ============================================================
alter table public.menu_items
  add column if not exists subcategory_id uuid,
  add column if not exists meal_section text,
  add column if not exists is_featured boolean not null default false,
  add column if not exists is_popular boolean not null default false,
  add column if not exists dietary_tags jsonb not null default '[]'::jsonb,
  add column if not exists allergens jsonb not null default '[]'::jsonb;

create table if not exists public.menu_subcategories (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  category_id uuid not null references public.menu_categories(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(branch_id, category_id, name)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname='menu_items_subcategory_branch_fk' and conrelid='public.menu_items'::regclass) then
    alter table public.menu_items add constraint menu_items_subcategory_branch_fk foreign key (subcategory_id) references public.menu_subcategories(id) on delete set null;
  end if;
end $$;

create index if not exists menu_subcategories_branch_idx on public.menu_subcategories(branch_id, category_id, sort_order);
create index if not exists menu_items_subcategory_idx on public.menu_items(subcategory_id);

-- ============================================================
-- 2. Variants
-- ============================================================
create table if not exists public.menu_item_variants (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  name text not null,
  description text,
  price_delta numeric(12,2) not null default 0 check (price_delta >= -1000000 and price_delta <= 1000000),
  is_default boolean not null default false,
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(menu_item_id, name)
);
create index if not exists menu_item_variants_item_idx on public.menu_item_variants(menu_item_id, sort_order);
create unique index if not exists menu_item_variants_one_default_uidx on public.menu_item_variants(menu_item_id) where is_default;

-- ============================================================
-- 3. Modifier engine
-- ============================================================
create table if not exists public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  name text not null,
  description text,
  is_required boolean not null default false,
  selection_mode text not null default 'MULTI' check (selection_mode in ('SINGLE','MULTI')),
  min_select integer not null default 0 check (min_select >= 0 and min_select <= 100),
  max_select integer not null default 1 check (max_select >= 1 and max_select <= 100),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(branch_id, name),
  check (min_select <= max_select),
  check ((is_required = false) or (min_select >= 1)),
  check ((selection_mode = 'SINGLE' and max_select = 1) or selection_mode = 'MULTI')
);
create table if not exists public.modifiers (
  id uuid primary key default gen_random_uuid(),
  modifier_group_id uuid not null references public.modifier_groups(id) on delete cascade,
  name text not null,
  description text,
  price_delta numeric(12,2) not null default 0 check (price_delta >= -1000000 and price_delta <= 1000000),
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(modifier_group_id, name)
);
create table if not exists public.menu_item_modifier_groups (
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  modifier_group_id uuid not null references public.modifier_groups(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key(menu_item_id, modifier_group_id)
);
create index if not exists modifiers_group_idx on public.modifiers(modifier_group_id, sort_order);
create index if not exists menu_item_modifier_groups_group_idx on public.menu_item_modifier_groups(modifier_group_id, sort_order);

-- ============================================================
-- 4. Translations
-- ============================================================
create table if not exists public.menu_item_translations (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  language_code text not null check (language_code ~ '^[a-z]{2,8}([_-][A-Z]{2,8})?$'),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(menu_item_id, language_code)
);
create table if not exists public.menu_category_translations (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.menu_categories(id) on delete cascade,
  language_code text not null check (language_code ~ '^[a-z]{2,8}([_-][A-Z]{2,8})?$'),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(category_id, language_code)
);
create table if not exists public.menu_subcategory_translations (
  id uuid primary key default gen_random_uuid(),
  subcategory_id uuid not null references public.menu_subcategories(id) on delete cascade,
  language_code text not null check (language_code ~ '^[a-z]{2,8}([_-][A-Z]{2,8})?$'),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(subcategory_id, language_code)
);
create table if not exists public.menu_variant_translations (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.menu_item_variants(id) on delete cascade,
  language_code text not null check (language_code ~ '^[a-z]{2,8}([_-][A-Z]{2,8})?$'),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(variant_id, language_code)
);
create table if not exists public.modifier_group_translations (
  id uuid primary key default gen_random_uuid(),
  modifier_group_id uuid not null references public.modifier_groups(id) on delete cascade,
  language_code text not null check (language_code ~ '^[a-z]{2,8}([_-][A-Z]{2,8})?$'),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(modifier_group_id, language_code)
);
create table if not exists public.modifier_translations (
  id uuid primary key default gen_random_uuid(),
  modifier_id uuid not null references public.modifiers(id) on delete cascade,
  language_code text not null check (language_code ~ '^[a-z]{2,8}([_-][A-Z]{2,8})?$'),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(modifier_id, language_code)
);

-- ============================================================
-- 5. Order snapshots
-- ============================================================
alter table public.order_items
  add column if not exists selected_options jsonb not null default '{}'::jsonb,
  add column if not exists configuration_snapshot jsonb not null default '{}'::jsonb;

-- Validate cross-branch relationships.
create or replace function public.validate_build16_menu_relations()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v_branch uuid;
begin
  if tg_table_name = 'menu_subcategories' then
    select branch_id into v_branch from public.menu_categories where id=new.category_id;
    if v_branch is null or v_branch <> new.branch_id then raise exception 'Subcategory category does not belong to this branch'; end if;
  elsif tg_table_name = 'menu_item_variants' then
    select branch_id into v_branch from public.menu_items where id=new.menu_item_id;
    if v_branch is null then raise exception 'Menu item not found for variant'; end if;
  elsif tg_table_name = 'modifier_groups' then
    select branch_id into v_branch from public.branches where id=new.branch_id;
    if v_branch is null then raise exception 'Branch not found for modifier group'; end if;
  elsif tg_table_name = 'modifiers' then
    select branch_id into v_branch from public.modifier_groups where id=new.modifier_group_id;
    if v_branch is null then raise exception 'Modifier group not found'; end if;
  elsif tg_table_name = 'menu_item_modifier_groups' then
    select mi.branch_id into v_branch from public.menu_items mi where mi.id=new.menu_item_id;
    if v_branch is null or not exists(select 1 from public.modifier_groups mg where mg.id=new.modifier_group_id and mg.branch_id=v_branch) then
      raise exception 'Menu item and modifier group must belong to the same branch';
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists menu_subcategory_branch_check on public.menu_subcategories;
create trigger menu_subcategory_branch_check before insert or update of branch_id, category_id on public.menu_subcategories for each row execute function public.validate_build16_menu_relations();
drop trigger if exists menu_item_variant_branch_check on public.menu_item_variants;
create trigger menu_item_variant_branch_check before insert or update of menu_item_id on public.menu_item_variants for each row execute function public.validate_build16_menu_relations();
drop trigger if exists modifier_group_branch_check on public.modifier_groups;
create trigger modifier_group_branch_check before insert or update of branch_id on public.modifier_groups for each row execute function public.validate_build16_menu_relations();
drop trigger if exists modifier_group_modifier_branch_check on public.modifiers;
create trigger modifier_group_modifier_branch_check before insert or update of modifier_group_id on public.modifiers for each row execute function public.validate_build16_menu_relations();
drop trigger if exists menu_item_modifier_group_branch_check on public.menu_item_modifier_groups;
create trigger menu_item_modifier_group_branch_check before insert or update on public.menu_item_modifier_groups for each row execute function public.validate_build16_menu_relations();

-- Keep a subcategory's branch in sync with its category.
create or replace function public.prevent_menu_item_subcategory_cross_branch()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if new.subcategory_id is not null and not exists (
    select 1 from public.menu_subcategories s
    where s.id=new.subcategory_id and s.branch_id=new.branch_id and s.category_id=new.category_id
  ) then
    raise exception 'Menu subcategory does not belong to this branch/category';
  end if;
  return new;
end; $$;
drop trigger if exists menu_item_subcategory_check on public.menu_items;
create trigger menu_item_subcategory_check before insert or update of branch_id, category_id, subcategory_id on public.menu_items for each row execute function public.prevent_menu_item_subcategory_cross_branch();

-- Restrict attribute values to the Build 16 vocabulary while allowing CUSTOM as
-- an explicit value; arrays must contain strings only.
create or replace function public.validate_build16_item_attributes()
returns trigger language plpgsql security invoker set search_path=public as $$
declare v text;
begin
  if jsonb_typeof(coalesce(new.dietary_tags,'[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(new.allergens,'[]'::jsonb)) <> 'array' then
    raise exception 'dietary_tags and allergens must be JSON arrays';
  end if;
  for v in select jsonb_array_elements_text(coalesce(new.dietary_tags,'[]'::jsonb)) loop
    if upper(v) not in ('VEG','NON_VEG','EGG','DAIRY','NUTS','GLUTEN','SPICY','CUSTOM') then raise exception 'Invalid dietary tag: %', v; end if;
  end loop;
  for v in select jsonb_array_elements_text(coalesce(new.allergens,'[]'::jsonb)) loop
    if upper(v) not in ('EGG','DAIRY','NUTS','GLUTEN','CUSTOM','SOY','FISH','SHELLFISH','SESAME','MUSTARD','PEANUTS','TREE_NUTS') then raise exception 'Invalid allergen: %', v; end if;
  end loop;
  return new;
end; $$;
drop trigger if exists menu_item_build16_attributes_check on public.menu_items;
create trigger menu_item_build16_attributes_check before insert or update of dietary_tags, allergens on public.menu_items for each row execute function public.validate_build16_item_attributes();

-- ============================================================
-- 6. Generic cart validator/pricer
-- ============================================================
drop function if exists public.build16_calculate_cart(uuid,jsonb);
create function public.build16_calculate_cart(p_branch_id uuid, p_items jsonb)
returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare
  v_item jsonb;
  v_menu public.menu_items%rowtype;
  v_variant public.menu_item_variants%rowtype;
  v_qty integer;
  v_unit numeric(12,2);
  v_base numeric(12,2);
  v_subtotal numeric(12,2):=0;
  v_selected_variant uuid;
  v_modifier_ids uuid[];
  v_options jsonb;
  v_legacy_addons jsonb;
  v_selected_addons jsonb;
  v_group record;
  v_count integer;
  v_mod record;
  v_snapshot jsonb:='[]'::jsonb;
  v_names text[];
  v_requested_count integer;
  v_seen integer;
  v_group_selected integer;
  v_mod_total numeric(12,2);
  v_config_key text;
begin
  if p_branch_id is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)=0 then raise exception 'Cart is empty'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if not (v_item ? 'menu_item_id') or not (v_item ? 'quantity') then raise exception 'Invalid cart item'; end if;
    begin v_qty:=(v_item->>'quantity')::integer; exception when others then raise exception 'Invalid item quantity'; end;
    if v_qty<1 or v_qty>50 then raise exception 'Item quantity must be between 1 and 50'; end if;
    select * into v_menu from public.menu_items where id=(v_item->>'menu_item_id')::uuid and branch_id=p_branch_id and is_available=true;
    if v_menu.id is null then raise exception 'One or more items are unavailable'; end if;

    v_unit:=round(v_menu.price,2); v_selected_variant:=null; v_options:='[]'::jsonb; v_selected_addons:='[]'::jsonb; v_legacy_addons:=coalesce(v_item->'addons','[]'::jsonb);

    if not (v_item ? 'variant_id') or nullif(trim(v_item->>'variant_id'),'') is null then
      if exists(select 1 from public.menu_item_variants vv where vv.menu_item_id=v_menu.id) then
        raise exception 'A variant must be selected for this item';
      end if;
    else
      begin v_selected_variant:=(v_item->>'variant_id')::uuid; exception when others then raise exception 'Invalid variant'; end;
      select * into v_variant from public.menu_item_variants where id=v_selected_variant and menu_item_id=v_menu.id and is_available=true;
      if v_variant.id is null then raise exception 'Selected variant is unavailable'; end if;
      v_unit:=round(v_unit+v_variant.price_delta,2);
      v_options:=v_options || jsonb_build_array(jsonb_build_object('type','VARIANT','id',v_variant.id,'name',v_variant.name,'price_delta',v_variant.price_delta));
    end if;

    v_modifier_ids:=coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(v_item->'modifier_ids','[]'::jsonb)) t(x)), '{}'::uuid[]);
    if array_length(v_modifier_ids,1) is null then v_modifier_ids:='{}'::uuid[]; end if;
    v_requested_count:=coalesce(array_length(v_modifier_ids,1),0);
    if exists(select 1 from unnest(v_modifier_ids) as z(id) where id is null) then raise exception 'Invalid modifier selection'; end if;
    if v_requested_count<> (select count(distinct x) from unnest(v_modifier_ids) as u(x)) then raise exception 'Duplicate modifiers are not allowed'; end if;

    for v_group in
      select mg.* from public.modifier_groups mg
      join public.menu_item_modifier_groups mig on mig.modifier_group_id=mg.id
      where mig.menu_item_id=v_menu.id and mg.branch_id=p_branch_id and mg.is_active=true
      order by mig.sort_order, mg.sort_order, mg.name
    loop
      select count(*) into v_group_selected
      from public.modifiers m
      where m.modifier_group_id=v_group.id and m.id=any(v_modifier_ids);
      if v_group.is_required and v_group_selected=0 then raise exception 'Selection required for modifier group: %', v_group.name; end if;
      if v_group_selected < v_group.min_select then raise exception 'Select at least % option(s) for %', v_group.min_select, v_group.name; end if;
      if v_group_selected > v_group.max_select then raise exception 'Select at most % option(s) for %', v_group.max_select, v_group.name; end if;
      if v_group.selection_mode='SINGLE' and v_group_selected>1 then raise exception 'Only one option may be selected for %', v_group.name; end if;
      if exists(select 1 from public.modifiers m where m.modifier_group_id=v_group.id and m.id=any(v_modifier_ids) and m.is_available=false) then raise exception 'One or more selected options are unavailable for %', v_group.name; end if;
    end loop;
    if exists(
      select 1 from unnest(v_modifier_ids) as sel(id)
      where not exists(
        select 1 from public.menu_item_modifier_groups mig
        join public.modifier_groups mg on mg.id=mig.modifier_group_id and mg.is_active=true
        join public.modifiers m on m.modifier_group_id=mg.id
        where mig.menu_item_id=v_menu.id and m.id=sel.id and m.is_available=true
      )
    ) then raise exception 'One or more selected modifiers are invalid'; end if;

    v_mod_total:=0;
    for v_mod in
      select m.id,m.name,m.price_delta,mg.name group_name
      from public.modifiers m join public.modifier_groups mg on mg.id=m.modifier_group_id
      where m.id=any(v_modifier_ids) order by mg.sort_order,m.sort_order,m.name
    loop
      v_mod_total:=v_mod_total+v_mod.price_delta;
      v_options:=v_options || jsonb_build_array(jsonb_build_object('type','MODIFIER','id',v_mod.id,'group_id',(select modifier_group_id from public.modifiers where id=v_mod.id),'group_name',v_mod.group_name,'name',v_mod.name,'price_delta',v_mod.price_delta));
    end loop;

    -- Legacy Build 5-15 add-ons remain accepted for existing carts, but their
    -- prices are always read from the current menu row. New UI uses modifiers.
    if jsonb_array_length(v_legacy_addons)>0 and v_requested_count=0 and v_selected_variant is null then
      if jsonb_typeof(v_legacy_addons)<>'array' then raise exception 'Invalid add-ons'; end if;
      if exists(select 1 from jsonb_array_elements(v_legacy_addons) req where not exists(select 1 from jsonb_array_elements(coalesce(v_menu.addons,'[]'::jsonb)) a where a->>'name'=req->>'name')) then raise exception 'One or more selected add-ons are invalid'; end if;
      select coalesce(jsonb_agg(jsonb_build_object('name',a->>'name','price',coalesce((a->>'price')::numeric,0)) order by a->>'name'),'[]'::jsonb),coalesce(sum(coalesce((a->>'price')::numeric,0)),0)
      into v_selected_addons,v_mod_total
      from jsonb_array_elements(coalesce(v_menu.addons,'[]'::jsonb)) a
      where exists(select 1 from jsonb_array_elements(v_legacy_addons) req where req->>'name'=a->>'name');
      v_options:=v_options || (select coalesce(jsonb_agg(jsonb_build_object('type','LEGACY_ADDON','name',a->>'name','price_delta',coalesce((a->>'price')::numeric,0)) order by a->>'name'),'[]'::jsonb) from jsonb_array_elements(v_selected_addons) a);
    end if;

    v_unit:=round(v_unit+v_mod_total,2); if v_unit<0 then raise exception 'Configured item price cannot be negative'; end if;
    v_subtotal:=v_subtotal+round(v_unit*v_qty,2); if v_subtotal>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;
    v_names:=array[]::text[];
    if v_selected_variant is not null then v_names:=array_append(v_names,v_variant.name); end if;
    for v_mod in select x->>'name' name from jsonb_array_elements(v_options) x where x->>'type' in ('MODIFIER','LEGACY_ADDON') loop v_names:=array_append(v_names,v_mod.name); end loop;
    v_config_key:=encode(extensions.digest(convert_to(coalesce(v_selected_variant::text,'')||'|'||coalesce(array_to_string(v_modifier_ids,','),'')||'|'||coalesce(array_to_string(v_names,','),''),'UTF8'),'sha256'),'hex');
    v_snapshot:=v_snapshot || jsonb_build_array(jsonb_build_object(
      'menu_item_id',v_menu.id,
      'item_name_snapshot',v_menu.name,
      'base_unit_price',v_menu.price,
      'variant_id',v_selected_variant,
      'variant_name',case when v_selected_variant is null then null else v_variant.name end,
      'variant_price_delta',case when v_selected_variant is null then 0 else v_variant.price_delta end,
      'selected_options',v_options,
      'selected_addons',v_selected_addons,
      'unit_price',v_unit,
      'quantity',v_qty,
      'line_total',round(v_unit*v_qty,2),
      'special_instructions',nullif(trim(coalesce(v_item->>'note','')),''),
      'configuration_key',v_config_key
    ));
  end loop;
  return v_snapshot;
end; $$;
revoke execute on function public.build16_calculate_cart(uuid,jsonb) from anon,authenticated,public;

-- ============================================================
-- 7. Public menu feed with language/category/subcategory/options
-- ============================================================
drop function if exists public.get_public_menu_for_table(text);
create function public.get_public_menu_for_table(p_table_code text)
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
  select c.id,c.name,c.sort_order,s.id,s.name,s.sort_order,i.meal_section,i.id,i.name,i.description,i.price,i.image_url,i.is_available,i.is_veg,i.is_spicy,i.is_recommended,i.is_featured,i.is_popular,i.preparation_minutes,i.dietary_tags,i.allergens,
    coalesce((select jsonb_agg(jsonb_build_object('id',v.id,'name',v.name,'description',v.description,'price_delta',v.price_delta,'is_default',v.is_default,'is_available',v.is_available,'sort_order',v.sort_order) order by v.sort_order,v.name) from public.menu_item_variants v where v.menu_item_id=i.id),'[]'::jsonb) variants,
    coalesce((select jsonb_agg(jsonb_build_object('id',mg.id,'name',mg.name,'description',mg.description,'translations',(select coalesce(jsonb_agg(jsonb_build_object('language_code',mgt.language_code,'name',mgt.name,'description',mgt.description) order by mgt.language_code),'[]'::jsonb) from public.modifier_group_translations mgt where mgt.modifier_group_id=mg.id),'is_required',mg.is_required,'selection_mode',mg.selection_mode,'min_select',mg.min_select,'max_select',mg.max_select,'sort_order',mig.sort_order,'modifiers',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'description',m.description,'price_delta',m.price_delta,'is_available',m.is_available,'sort_order',m.sort_order,'translations',(select coalesce(jsonb_agg(jsonb_build_object('language_code',mt.language_code,'name',mt.name,'description',mt.description) order by mt.language_code),'[]'::jsonb) from public.modifier_translations mt where mt.modifier_id=m.id)) order by m.sort_order,m.name),'[]'::jsonb) from public.modifiers m where m.modifier_group_id=mg.id)) order by mig.sort_order,mg.sort_order,mg.name),'[]'::jsonb) modifier_groups,
    coalesce((select jsonb_agg(jsonb_build_object('language_code',ct.language_code,'name',ct.name) order by ct.language_code) from public.menu_category_translations ct where ct.category_id=c.id),'[]'::jsonb) category_translations,
    coalesce((select jsonb_agg(jsonb_build_object('language_code',st.language_code,'name',st.name) order by st.language_code) from public.menu_subcategory_translations st where st.subcategory_id=s.id),'[]'::jsonb) subcategory_translations,
    coalesce((select jsonb_agg(jsonb_build_object('language_code',it.language_code,'name',it.name,'description',it.description) order by it.language_code) from public.menu_item_translations it where it.menu_item_id=i.id),'[]'::jsonb) item_translations
  from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id
  join public.menu_items i on i.branch_id=b.id
  join public.menu_categories c on c.id=i.category_id and c.branch_id=b.id
  left join public.menu_subcategories s on s.id=i.subcategory_id and s.category_id=c.id and s.branch_id=b.id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
  order by c.sort_order,c.name,s.sort_order nulls first,s.name nulls first,i.name;
$$;
grant execute on function public.get_public_menu_for_table(text) to anon,authenticated;
revoke execute on function public.get_public_menu_for_table(text) from public;

-- ============================================================
-- 8. Server-side quota helper (only primary menu rows count)
-- ============================================================
create or replace function public.build16_assert_menu_item_limit(p_branch_id uuid, p_is_new boolean)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_org uuid; v_limit bigint; v_count bigint;
begin
  if not p_is_new then return true; end if;
  select organization_id into v_org from public.branches where id=p_branch_id;
  if v_org is null then raise exception 'Branch not found'; end if;
  select max_menu_items into v_limit from public.saas_plans where id=(select plan_id from public.organization_subscriptions where organization_id=v_org);
  select count(*) into v_count from public.menu_items m where m.branch_id=p_branch_id and m.is_available=true;
  if v_limit is not null and v_count>=v_limit then raise exception 'Menu item limit reached for your current plan'; end if;
  return true;
end; $$;
revoke execute on function public.build16_assert_menu_item_limit(uuid,boolean) from anon,authenticated,public;

-- ============================================================
-- 9. Preserve the payment/order RPCs but replace their pricing body via the
-- new validator. Signatures are identical to Build 15.
-- ============================================================
drop function if exists public.create_order_for_table(text,jsonb,text,text,text,text,text);
create function public.create_order_for_table(
  p_table_code text,p_items jsonb,p_payment_method text default 'PAY_AT_COUNTER',p_idempotency_key text default null,p_customer_note text default null,p_customer_name text default null,p_customer_phone text default null
) returns table(order_id uuid,order_number bigint,tracking_token text,subtotal numeric,tax numeric,additional_charges numeric,discount numeric,total numeric,charge_breakdown jsonb,payment_status public.payment_status,status public.order_status)
language plpgsql security definer set search_path=public as $$
declare v_table public.tables%rowtype; v_existing public.orders%rowtype; v_snapshot jsonb; v_order public.orders%rowtype; v_item jsonb; v_subtotal numeric(12,2); v_tax numeric(12,2):=0; v_additional numeric(12,2):=0; v_discount numeric(12,2):=0; v_total numeric(12,2); v_breakdown jsonb:='[]'::jsonb; v_charge record; v_amt numeric(12,2); v_name text:=nullif(left(trim(coalesce(p_customer_name,'')),120),''); v_phone text:=nullif(regexp_replace(trim(coalesce(p_customer_phone,'')),'[^0-9]','','g'),''); v_idem text:=nullif(trim(coalesce(p_idempotency_key,'')),''); v_method text:=upper(trim(coalesce(p_payment_method,'PAY_AT_COUNTER')));
begin
  if v_name is null then raise exception 'Customer name is required'; end if;
  if v_phone is null then raise exception 'Valid customer phone is required'; end if;
  if length(v_phone)=12 and left(v_phone,2)='91' then v_phone:=right(v_phone,10); end if;
  if length(v_phone)<>10 or left(v_phone,1) not in ('6','7','8','9') then raise exception 'Valid customer phone is required'; end if;
  select * into v_table from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if v_idem is not null then
    select * into v_existing from public.orders where branch_id=v_table.branch_id and idempotency_key=v_idem limit 1;
    if v_existing.id is not null then return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.subtotal,v_existing.tax,v_existing.additional_charges,v_existing.discount,v_existing.total,v_existing.charge_breakdown,v_existing.payment_status,v_existing.status; return; end if;
  end if;
  if v_method='PAY_NOW' then raise exception 'PAY_NOW orders must use the payment-first checkout flow' using errcode='P0001'; end if;
  if v_method<>'PAY_AT_COUNTER' then raise exception 'Unsupported payment method'; end if;
  v_snapshot:=public.build16_calculate_cart(v_table.branch_id,p_items); v_subtotal:=round(coalesce((select sum((x->>'line_total')::numeric) from jsonb_array_elements(v_snapshot) x),0),2); if v_subtotal<=0 then raise exception 'Cart is empty'; end if;
  for v_charge in select c.name,c.charge_type,c.calculation_type,c.value from public.restaurant_charge_settings c where c.enabled=true and (c.branch_id=v_table.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_table.branch_id))) order by c.sort_order,c.created_at loop
    if v_charge.calculation_type='PERCENT' then v_amt:=round((v_subtotal-v_discount)*v_charge.value/100.0,2); else v_amt:=round(v_charge.value,2); end if; if v_amt<0 then v_amt:=0; end if; if v_charge.charge_type='TAX' then v_tax:=v_tax+v_amt; else v_additional:=v_additional+v_amt; end if; v_breakdown:=v_breakdown||jsonb_build_object('name',v_charge.name,'charge_type',v_charge.charge_type,'calculation_type',v_charge.calculation_type,'value',v_charge.value,'amount',v_amt); end loop;
  v_total:=round(v_subtotal-v_discount+v_tax+v_additional,2); if v_total>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;
  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone) values(v_table.branch_id,v_table.id,'NEW','PENDING',v_method,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,coalesce(v_idem,encode(extensions.gen_random_bytes(16),'hex')),encode(extensions.gen_random_bytes(16),'hex'),nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_phone) returning * into v_order;
  for v_item in select value from jsonb_array_elements(v_snapshot) loop
    insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions,selected_options,configuration_snapshot)
    values(v_order.id,(v_item->>'menu_item_id')::uuid,v_item->>'item_name_snapshot',(v_item->>'unit_price')::numeric,(v_item->>'quantity')::integer,coalesce(v_item->'selected_addons','[]'::jsonb),nullif(v_item->>'special_instructions',''),coalesce(v_item->'selected_options','[]'::jsonb),v_item);
  end loop;
  return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.subtotal,v_order.tax,v_order.additional_charges,v_order.discount,v_order.total,v_order.charge_breakdown,v_order.payment_status,v_order.status;
exception when unique_violation then
  if v_idem is not null then select * into v_existing from public.orders where branch_id=v_table.branch_id and idempotency_key=v_idem limit 1; if v_existing.id is not null then return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.subtotal,v_existing.tax,v_existing.additional_charges,v_existing.discount,v_existing.total,v_existing.charge_breakdown,v_existing.payment_status,v_existing.status; return; end if; end if; raise;
end; $$;
grant execute on function public.create_order_for_table(text,jsonb,text,text,text,text,text) to anon,authenticated;
revoke execute on function public.create_order_for_table(text,jsonb,text,text,text,text,text) from public;

-- Recreate payment attempt builder with identical signature and canonical snapshots.
create or replace function public.create_payment_attempt_for_table(p_table_code text,p_items jsonb,p_idempotency_key text,p_customer_note text default null,p_customer_name text default null,p_customer_phone text default null)
returns table(payment_attempt_id uuid,attempt_token text,total numeric,payment_started_at timestamptz,payment_expires_at timestamptz)
language plpgsql security definer set search_path=public as $$
declare v_table public.tables%rowtype; v_attempt public.payment_attempts%rowtype; v_snapshot jsonb; v_subtotal numeric(12,2); v_tax numeric(12,2):=0; v_discount numeric(12,2):=0; v_additional numeric(12,2):=0; v_total numeric(12,2); v_breakdown jsonb:='[]'::jsonb; v_charge record; v_amt numeric(12,2); v_name text:=nullif(left(trim(coalesce(p_customer_name,'')),120),''); v_phone text:=nullif(regexp_replace(trim(coalesce(p_customer_phone,'')),'[^0-9]','','g'),''); v_idem text:=nullif(trim(coalesce(p_idempotency_key,'')),''); v_now timestamptz:=now();
begin
  if v_idem is null then raise exception 'Checkout session key is required'; end if;
  if v_name is null then raise exception 'Customer name is required'; end if;
  if v_phone is null then raise exception 'Valid customer phone is required'; end if;
  if length(v_phone)=12 and left(v_phone,2)='91' then v_phone:=right(v_phone,10); end if;
  if length(v_phone)<>10 or left(v_phone,1) not in ('6','7','8','9') then raise exception 'Valid customer phone is required'; end if;
  select * into v_table from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  select * into v_attempt from public.payment_attempts pa where pa.branch_id=v_table.branch_id and pa.idempotency_key=v_idem and pa.status in ('PENDING','PROCESSING') order by pa.created_at desc limit 1;
  if v_attempt.id is not null then if v_attempt.payment_expires_at<=v_now then update public.payment_attempts set status='EXPIRED',updated_at=v_now,failure_reason='Payment session expired' where id=v_attempt.id; else return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at; return; end if; end if;
  v_snapshot:=public.build16_calculate_cart(v_table.branch_id,p_items); v_subtotal:=round(coalesce((select sum((x->>'line_total')::numeric) from jsonb_array_elements(v_snapshot) x),0),2);
  for v_charge in select c.name,c.charge_type,c.calculation_type,c.value from public.restaurant_charge_settings c where c.enabled=true and (c.branch_id=v_table.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_table.branch_id))) order by c.sort_order,c.created_at loop
    if v_charge.calculation_type='PERCENT' then v_amt:=round((v_subtotal-v_discount)*v_charge.value/100.0,2); else v_amt:=round(v_charge.value,2); end if; if v_amt<0 then v_amt:=0; end if; if v_charge.charge_type='TAX' then v_tax:=v_tax+v_amt; else v_additional:=v_additional+v_amt; end if; v_breakdown:=v_breakdown||jsonb_build_object('name',v_charge.name,'charge_type',v_charge.charge_type,'calculation_type',v_charge.calculation_type,'value',v_charge.value,'amount',v_amt); end loop;
  v_total:=round(v_subtotal-v_discount+v_tax+v_additional,2); if v_total>1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;
  insert into public.payment_attempts(attempt_token,branch_id,table_id,idempotency_key,items_snapshot,subtotal,tax,discount,additional_charges,total,charge_breakdown,customer_note,customer_name,customer_phone,payment_started_at,payment_expires_at) values(encode(extensions.gen_random_bytes(32),'hex'),v_table.branch_id,v_table.id,v_idem,v_snapshot,v_subtotal,v_tax,v_discount,v_additional,v_total,v_breakdown,nullif(trim(coalesce(p_customer_note,'')),''),v_name,v_phone,v_now,v_now+interval '1 hour') returning * into v_attempt;
  return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at;
exception when unique_violation then select * into v_attempt from public.payment_attempts where branch_id=v_table.branch_id and idempotency_key=v_idem and status in ('PENDING','PROCESSING') order by created_at desc limit 1; if v_attempt.id is not null then return query select v_attempt.id,v_attempt.attempt_token,v_attempt.total,v_attempt.payment_started_at,v_attempt.payment_expires_at; return; end if; raise;
end; $$;
grant execute on function public.create_payment_attempt_for_table(text,jsonb,text,text,text,text) to anon,authenticated;
revoke execute on function public.create_payment_attempt_for_table(text,jsonb,text,text,text,text) from public;

-- Replace finalize only to persist the new snapshot columns. All security checks stay the same.
create or replace function public.finalize_payment_attempt(p_payment_attempt_id uuid,p_attempt_token text,p_razorpay_payment_id text,p_payment_method text)
returns table(order_id uuid,order_number bigint,tracking_token text,total numeric,payment_status public.payment_status,status public.order_status)
language plpgsql security definer set search_path=public as $$
declare v_attempt public.payment_attempts%rowtype; v_order public.orders%rowtype; v_now timestamptz:=now(); v_item jsonb; v_method text:=upper(trim(coalesce(p_payment_method,'ONLINE'))); v_token text:=nullif(trim(p_attempt_token),'');
begin
  if v_payment_attempt_id is null or v_token is null then raise exception 'Invalid payment attempt'; end if;
  select * into v_attempt from public.payment_attempts where id=p_payment_attempt_id and attempt_token=v_token for update;
  if v_attempt.id is null then raise exception 'Payment attempt not found' using errcode='P0002'; end if;
  if v_attempt.status='SUCCESS' and v_attempt.order_id is not null then select * into v_order from public.orders where id=v_attempt.order_id; return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.total,v_order.payment_status,v_order.status; return; end if;
  if v_attempt.status in ('FAILED','EXPIRED') then raise exception 'Payment attempt is no longer valid' using errcode='P0001'; end if;
  if v_attempt.payment_expires_at<=v_now then update public.payment_attempts set status='EXPIRED',failure_reason='Payment session expired',updated_at=v_now,completed_at=v_now where id=v_attempt.id; raise exception 'Payment session expired. Please place a new order.' using errcode='P0001'; end if;
  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,additional_charges,total,charge_breakdown,idempotency_key,tracking_token,customer_note,customer_name,customer_phone,paid_at,razorpay_payment_id) values(v_attempt.branch_id,v_attempt.table_id,'NEW','PAID',concat('PAY_NOW:',case when v_method='' then 'ONLINE' else v_method end),v_attempt.subtotal,v_attempt.tax,v_attempt.discount,v_attempt.additional_charges,v_attempt.total,v_attempt.charge_breakdown,concat('payment-attempt:',v_attempt.id::text),encode(extensions.gen_random_bytes(16),'hex'),v_attempt.customer_note,v_attempt.customer_name,v_attempt.customer_phone,v_now,p_razorpay_payment_id) returning * into v_order;
  for v_item in select value from jsonb_array_elements(v_attempt.items_snapshot) loop
    insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions,selected_options,configuration_snapshot) values(v_order.id,(v_item->>'menu_item_id')::uuid,v_item->>'item_name_snapshot',(v_item->>'unit_price')::numeric,(v_item->>'quantity')::integer,coalesce(v_item->'selected_addons','[]'::jsonb),nullif(v_item->>'special_instructions',''),coalesce(v_item->'selected_options','[]'::jsonb),v_item);
  end loop;
  insert into public.payment_transactions(order_id,branch_id,provider,provider_order_id,provider_payment_id,amount,status,method,raw_metadata) values(v_order.id,v_order.branch_id,'RAZORPAY',v_attempt.razorpay_order_id,p_razorpay_payment_id,v_order.total,'CAPTURED',v_method,jsonb_build_object('payment_attempt_id',v_attempt.id,'source','payment-first-finalize')) on conflict (provider_order_id) do update set order_id=excluded.order_id,provider_payment_id=excluded.provider_payment_id,amount=excluded.amount,status=excluded.status,method=excluded.method,raw_metadata=excluded.raw_metadata,updated_at=now();
  update public.payment_attempts set status='SUCCESS',razorpay_payment_id=p_razorpay_payment_id,order_id=v_order.id,completed_at=v_now,updated_at=v_now where id=v_attempt.id;
  return query select v_order.id,v_order.order_number,v_order.tracking_token,v_order.total,v_order.payment_status,v_order.status;
end; $$;
revoke execute on function public.finalize_payment_attempt(uuid,text,text,text) from anon,authenticated,public;
grant execute on function public.finalize_payment_attempt(uuid,text,text,text) to service_role;

-- ============================================================
-- 10. RLS — all Build 16 tables are branch scoped.
-- ============================================================
alter table public.menu_subcategories enable row level security;
alter table public.menu_item_variants enable row level security;
alter table public.modifier_groups enable row level security;
alter table public.modifiers enable row level security;
alter table public.menu_item_modifier_groups enable row level security;
alter table public.menu_item_translations enable row level security;
alter table public.menu_category_translations enable row level security;
alter table public.menu_subcategory_translations enable row level security;
alter table public.menu_variant_translations enable row level security;
alter table public.modifier_group_translations enable row level security;
alter table public.modifier_translations enable row level security;

grant select,insert,update,delete on public.menu_subcategories,public.menu_item_variants,public.modifier_groups,public.modifiers,public.menu_item_modifier_groups,public.menu_item_translations,public.menu_category_translations,public.menu_subcategory_translations,public.menu_variant_translations,public.modifier_group_translations,public.modifier_translations to authenticated;
revoke all on public.menu_subcategories,public.menu_item_variants,public.modifier_groups,public.modifiers,public.menu_item_modifier_groups,public.menu_item_translations,public.menu_category_translations,public.menu_subcategory_translations,public.menu_variant_translations,public.modifier_group_translations,public.modifier_translations from anon,public;

-- Read policies for branch members; write policies require MENU_MANAGEMENT.
drop policy if exists build16_subcat_select on public.menu_subcategories;
create policy build16_subcat_select on public.menu_subcategories for select to authenticated using (public.current_user_has_permission_for_branch(branch_id,'MENU_MANAGEMENT') or public.is_branch_member(branch_id));
drop policy if exists build16_subcat_write on public.menu_subcategories;
create policy build16_subcat_write on public.menu_subcategories for all to authenticated using (public.current_user_has_permission_for_branch(branch_id,'MENU_MANAGEMENT')) with check (public.current_user_has_permission_for_branch(branch_id,'MENU_MANAGEMENT'));

drop policy if exists build16_variant_select on public.menu_item_variants;
create policy build16_variant_select on public.menu_item_variants for select to authenticated using (exists(select 1 from public.menu_items i where i.id=menu_item_variants.menu_item_id and (public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT') or public.is_branch_member(i.branch_id))));
drop policy if exists build16_variant_write on public.menu_item_variants;
create policy build16_variant_write on public.menu_item_variants for all to authenticated using (exists(select 1 from public.menu_items i where i.id=menu_item_variants.menu_item_id and public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.menu_items i where i.id=menu_item_variants.menu_item_id and public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT'))));

drop policy if exists build16_group_select on public.modifier_groups;
create policy build16_group_select on public.modifier_groups for select to authenticated using (public.is_branch_member(branch_id));
drop policy if exists build16_group_write on public.modifier_groups;
create policy build16_group_write on public.modifier_groups for all to authenticated using (public.current_user_has_permission_for_branch(branch_id,'MENU_MANAGEMENT')) with check (public.current_user_has_permission_for_branch(branch_id,'MENU_MANAGEMENT'));

drop policy if exists build16_modifier_select on public.modifiers;
create policy build16_modifier_select on public.modifiers for select to authenticated using (exists(select 1 from public.modifier_groups g where g.id=modifier_group_id and public.is_branch_member(g.branch_id)));
drop policy if exists build16_modifier_write on public.modifiers;
create policy build16_modifier_write on public.modifiers for all to authenticated using (exists(select 1 from public.modifier_groups g where g.id=modifier_group_id and public.current_user_has_permission_for_branch(g.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.modifier_groups g where g.id=modifier_group_id and public.current_user_has_permission_for_branch(g.branch_id,'MENU_MANAGEMENT'))));

drop policy if exists build16_link_select on public.menu_item_modifier_groups;
create policy build16_link_select on public.menu_item_modifier_groups for select to authenticated using (exists(select 1 from public.menu_items i where i.id=menu_item_id and public.is_branch_member(i.branch_id)));
drop policy if exists build16_link_write on public.menu_item_modifier_groups;
create policy build16_link_write on public.menu_item_modifier_groups for all to authenticated using (exists(select 1 from public.menu_items i where i.id=menu_item_id and public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.menu_items i where i.id=menu_item_id and public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT'))));

-- Translation policies resolve the branch through their parent entity.
drop policy if exists build16_item_tr_select on public.menu_item_translations;
create policy build16_item_tr_select on public.menu_item_translations for select to authenticated using (exists(select 1 from public.menu_items i where i.id=menu_item_id and public.is_branch_member(i.branch_id)));
drop policy if exists build16_item_tr_write on public.menu_item_translations;
create policy build16_item_tr_write on public.menu_item_translations for all to authenticated using (exists(select 1 from public.menu_items i where i.id=menu_item_id and public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.menu_items i where i.id=menu_item_id and public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT'))));

drop policy if exists build16_cat_tr_select on public.menu_category_translations;
create policy build16_cat_tr_select on public.menu_category_translations for select to authenticated using (exists(select 1 from public.menu_categories c where c.id=category_id and public.is_branch_member(c.branch_id)));
drop policy if exists build16_cat_tr_write on public.menu_category_translations;
create policy build16_cat_tr_write on public.menu_category_translations for all to authenticated using (exists(select 1 from public.menu_categories c where c.id=category_id and public.current_user_has_permission_for_branch(c.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.menu_categories c where c.id=category_id and public.current_user_has_permission_for_branch(c.branch_id,'MENU_MANAGEMENT'))));

drop policy if exists build16_subcat_tr_select on public.menu_subcategory_translations;
create policy build16_subcat_tr_select on public.menu_subcategory_translations for select to authenticated using (exists(select 1 from public.menu_subcategories s where s.id=subcategory_id and public.is_branch_member(s.branch_id)));
drop policy if exists build16_subcat_tr_write on public.menu_subcategory_translations;
create policy build16_subcat_tr_write on public.menu_subcategory_translations for all to authenticated using (exists(select 1 from public.menu_subcategories s where s.id=subcategory_id and public.current_user_has_permission_for_branch(s.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.menu_subcategories s where s.id=subcategory_id and public.current_user_has_permission_for_branch(s.branch_id,'MENU_MANAGEMENT'))));

drop policy if exists build16_variant_tr_select on public.menu_variant_translations;
create policy build16_variant_tr_select on public.menu_variant_translations for select to authenticated using (exists(select 1 from public.menu_item_variants v join public.menu_items i on i.id=v.menu_item_id where v.id=variant_id and public.is_branch_member(i.branch_id)));
drop policy if exists build16_variant_tr_write on public.menu_variant_translations;
create policy build16_variant_tr_write on public.menu_variant_translations for all to authenticated using (exists(select 1 from public.menu_item_variants v join public.menu_items i on i.id=v.menu_item_id where v.id=variant_id and public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.menu_item_variants v join public.menu_items i on i.id=v.menu_item_id where v.id=variant_id and public.current_user_has_permission_for_branch(i.branch_id,'MENU_MANAGEMENT'))));

drop policy if exists build16_group_tr_select on public.modifier_group_translations;
create policy build16_group_tr_select on public.modifier_group_translations for select to authenticated using (exists(select 1 from public.modifier_groups g where g.id=modifier_group_id and public.is_branch_member(g.branch_id)));
drop policy if exists build16_group_tr_write on public.modifier_group_translations;
create policy build16_group_tr_write on public.modifier_group_translations for all to authenticated using (exists(select 1 from public.modifier_groups g where g.id=modifier_group_id and public.current_user_has_permission_for_branch(g.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.modifier_groups g where g.id=modifier_group_id and public.current_user_has_permission_for_branch(g.branch_id,'MENU_MANAGEMENT'))));

drop policy if exists build16_modifier_tr_select on public.modifier_translations;
create policy build16_modifier_tr_select on public.modifier_translations for select to authenticated using (exists(select 1 from public.modifiers m join public.modifier_groups g on g.id=m.modifier_group_id where m.id=modifier_id and public.is_branch_member(g.branch_id)));
drop policy if exists build16_modifier_tr_write on public.modifier_translations;
create policy build16_modifier_tr_write on public.modifier_translations for all to authenticated using (exists(select 1 from public.modifiers m join public.modifier_groups g on g.id=m.modifier_group_id where m.id=modifier_id and public.current_user_has_permission_for_branch(g.branch_id,'MENU_MANAGEMENT'))) with check (exists(select 1 from public.modifiers m join public.modifier_groups g on g.id=m.modifier_group_id where m.id=modifier_id and public.current_user_has_permission_for_branch(g.branch_id,'MENU_MANAGEMENT'))));

-- Existing menu item RLS needs to include Build 16 fields naturally; no policy rewrite needed.

-- ============================================================
-- 11. Safe defaults / quota trigger
-- ============================================================
update public.menu_items set dietary_tags='[]'::jsonb where dietary_tags is null;
update public.menu_items set allergens='[]'::jsonb where allergens is null;

create or replace function public.build16_menu_item_quota_guard()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  perform public.build16_assert_menu_item_limit(new.branch_id,true);
  return new;
end; $$;
drop trigger if exists build16_menu_item_quota_guard on public.menu_items;
create trigger build16_menu_item_quota_guard before insert on public.menu_items for each row execute function public.build16_menu_item_quota_guard();


-- Public order read now exposes the immutable Build 16 configuration snapshot.
drop function if exists public.get_public_order(text);
create function public.get_public_order(p_tracking_token text)
returns table (
  order_id uuid, order_number bigint, restaurant_name text, table_number integer,
  status public.order_status, payment_status public.payment_status, payment_method text,
  subtotal numeric, tax numeric, additional_charges numeric, discount numeric, total numeric,
  charge_breakdown jsonb, created_at timestamptz, payment_started_at timestamptz,
  payment_expires_at timestamptz, cancellation_reason text, item_id uuid, item_name text,
  quantity integer, unit_price numeric, line_total numeric, selected_addons jsonb,
  special_instructions text, selected_options jsonb, configuration_snapshot jsonb
)
language plpgsql security definer set search_path=public as $$
declare v_order_id uuid;
begin
  select o.id into v_order_id from public.orders o where o.tracking_token=trim(p_tracking_token) limit 1;
  if v_order_id is null then return; end if;
  perform public.expire_awaiting_payment_orders_for_order(v_order_id);
  return query
  select o.id,o.order_number,org.name,t.table_number,o.status,o.payment_status,o.payment_method,
         o.subtotal,o.tax,o.additional_charges,o.discount,o.total,o.charge_breakdown,o.created_at,
         o.payment_started_at,o.payment_expires_at,o.cancellation_reason,
         oi.id,oi.item_name_snapshot,oi.quantity,oi.unit_price,oi.line_total,oi.selected_addons,
         oi.special_instructions,oi.selected_options,oi.configuration_snapshot
  from public.orders o
  join public.tables t on t.id=o.table_id
  join public.branches b on b.id=o.branch_id
  join public.organizations org on org.id=b.organization_id
  left join public.order_items oi on oi.order_id=o.id
  where o.id=v_order_id
  order by oi.id asc;
end; $$;
grant execute on function public.get_public_order(text) to anon,authenticated;
revoke execute on function public.get_public_order(text) from public;

commit;
