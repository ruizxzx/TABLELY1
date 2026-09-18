-- Platform-wide Tablely browser title + global logo synchronization.

alter table public.platform_brand_settings
  add column if not exists site_title text;

update public.platform_brand_settings
set site_title = 'Tablely — Restaurant Ordering OS'
where id = true and nullif(trim(site_title), '') is null;

alter table public.platform_brand_settings
  alter column site_title set default 'Tablely — Restaurant Ordering OS';
alter table public.platform_brand_settings
  alter column site_title set not null;

drop function if exists public.get_public_platform_brand();
create function public.get_public_platform_brand()
returns table(logo_url text, site_title text)
language sql stable security definer set search_path=public
as $$
  select b.logo_url, b.site_title
  from public.platform_brand_settings b
  where b.id = true;
$$;

create or replace function public.admin_update_platform_brand(
  p_logo_url text,
  p_logo_path text,
  p_site_title text
)
returns public.platform_brand_settings
language plpgsql security definer set search_path=public
as $$
declare
  v_row public.platform_brand_settings;
  v_old public.platform_brand_settings;
  v_title text;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;

  v_title := coalesce(nullif(left(trim(coalesce(p_site_title, '')), 140), ''), 'Tablely — Restaurant Ordering OS');

  select * into v_old
  from public.platform_brand_settings
  where id = true
  for update;

  update public.platform_brand_settings
  set logo_url = nullif(left(trim(coalesce(p_logo_url, '')), 1000), ''),
      logo_path = nullif(left(trim(coalesce(p_logo_path, '')), 500), ''),
      site_title = v_title,
      updated_at = now(),
      updated_by = auth.uid()
  where id = true
  returning * into v_row;

  insert into public.admin_audit_logs(actor_user_id, action, entity_type, metadata)
  values (
    auth.uid(),
    'PLATFORM_BRAND_UPDATED',
    'PLATFORM_BRAND',
    jsonb_build_object(
      'old_logo_url', v_old.logo_url,
      'new_logo_url', v_row.logo_url,
      'old_site_title', v_old.site_title,
      'new_site_title', v_row.site_title
    )
  );

  return v_row;
end;
$$;

create or replace function public.admin_get_platform_brand()
returns public.platform_brand_settings
language plpgsql security definer set search_path=public
as $$
declare
  v_row public.platform_brand_settings;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
  select * into v_row from public.platform_brand_settings where id = true;
  return v_row;
end;
$$;

revoke execute on function public.get_public_platform_brand() from public, anon;
grant execute on function public.get_public_platform_brand() to anon, authenticated;
revoke execute on function public.admin_get_platform_brand() from public, anon;
grant execute on function public.admin_get_platform_brand() to authenticated;
revoke execute on function public.admin_update_platform_brand(text, text, text) from public, anon;
grant execute on function public.admin_update_platform_brand(text, text, text) to authenticated;


create or replace function public.admin_update_platform_brand(p_logo_url text, p_logo_path text)
returns public.platform_brand_settings
language plpgsql security definer set search_path=public
as $$
declare
  v_row public.platform_brand_settings;
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode = '42501';
  end if;
  update public.platform_brand_settings
  set logo_url = nullif(left(trim(coalesce(p_logo_url, '')), 1000), ''),
      logo_path = nullif(left(trim(coalesce(p_logo_path, '')), 500), ''),
      updated_at = now(),
      updated_by = auth.uid()
  where id = true
  returning * into v_row;
  insert into public.admin_audit_logs(actor_user_id, action, entity_type, metadata)
  values (auth.uid(), 'PLATFORM_BRAND_UPDATED', 'PLATFORM_BRAND', jsonb_build_object('compatibility_wrapper', true));
  return v_row;
end;
$$;

revoke execute on function public.admin_update_platform_brand(text, text) from public, anon;
grant execute on function public.admin_update_platform_brand(text, text) to authenticated;
