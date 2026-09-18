-- Menu Studio RPCs omitted from the ordered Build 3/4 migrations.
create or replace function public.is_branch_manager_or_owner(target_branch uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff s
    where s.branch_id = target_branch
      and s.user_id = auth.uid()
      and s.role in ('OWNER'::public.staff_role, 'MANAGER'::public.staff_role)
      and s.active = true
  );
$$;

grant execute on function public.is_branch_manager_or_owner(uuid) to authenticated;

create or replace function public.create_menu_category(p_branch_id uuid, p_name text)
returns public.menu_categories
language plpgsql
security definer
set search_path = public
as $$
declare
  v_category public.menu_categories;
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_order integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not public.is_branch_manager_or_owner(p_branch_id) then
    raise exception 'You do not have permission to manage this menu' using errcode = '42501';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then
    raise exception 'Category name must be between 1 and 80 characters';
  end if;

  select c.* into v_category
  from public.menu_categories c
  where c.branch_id = p_branch_id and lower(c.name) = lower(v_name)
  limit 1;
  if v_category.id is not null then
    return v_category;
  end if;

  select coalesce(max(sort_order), -1) + 1
  into v_order
  from public.menu_categories
  where branch_id = p_branch_id;

  insert into public.menu_categories(branch_id, name, sort_order)
  values (p_branch_id, v_name, v_order)
  returning * into v_category;
  return v_category;
end;
$$;

grant execute on function public.create_menu_category(uuid, text) to authenticated;

create or replace function public.ensure_default_menu_categories(p_branch_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_count integer := 0;
  v_defaults text[] := array['Starters', 'Main Course', 'Drinks', 'Desserts'];
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if not public.is_branch_manager_or_owner(p_branch_id) then
    raise exception 'You do not have permission to manage this menu' using errcode = '42501';
  end if;
  foreach v_name in array v_defaults loop
    perform public.create_menu_category(p_branch_id, v_name);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.ensure_default_menu_categories(uuid) to authenticated;
