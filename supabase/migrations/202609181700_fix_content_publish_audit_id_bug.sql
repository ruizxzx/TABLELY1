-- Fix: publishing/saving/unpublishing a public content page (Terms,
-- Privacy, Vision, Contact) failed with:
--   record "v_row" has no field "id"
--
-- Root cause: public.platform_content_pages is keyed by `slug` (text),
-- it has no `id` column at all. admin_save_public_content_page,
-- admin_publish_public_content_page and admin_unpublish_public_content_page
-- all did `... values (auth.uid(), ..., v_row.id, ...)` when writing the
-- audit log row, where v_row is typed public.platform_content_pages.
-- Referencing the non-existent `.id` field raised at runtime.
--
-- Fix: audit_logs.entity_id is a uuid column, and platform_content_pages'
-- natural key is a text slug (not a uuid), so it never belonged in
-- entity_id. Each of these calls already records the page's slug in
-- `metadata`, so entity_id is simply left null here instead.

create or replace function public.admin_save_public_content_page(
  p_slug text,
  p_title text,
  p_draft jsonb
)
returns public.platform_content_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.platform_content_pages;
  v_slug text := lower(trim(coalesce(p_slug,'')));
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode='42501';
  end if;
  if v_slug not in ('contact','vision','privacy','terms') then
    raise exception 'Unknown content page';
  end if;
  if p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    raise exception 'Content must be a JSON object';
  end if;
  if char_length(trim(coalesce(p_title,''))) < 2 then
    raise exception 'Content page title is required';
  end if;
  update public.platform_content_pages
  set title = left(trim(coalesce(p_title,'')),180),
      draft = p_draft,
      updated_at = now(),
      updated_by = auth.uid()
  where slug = v_slug
  returning * into v_row;
  if v_row.slug is null then raise exception 'Content page not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(auth.uid(),'PLATFORM_CONTENT_UPDATED','PLATFORM_CONTENT',null,jsonb_build_object('slug',v_slug));
  return v_row;
end;
$$;
grant execute on function public.admin_save_public_content_page(text,text,jsonb) to authenticated;

create or replace function public.admin_publish_public_content_page(p_slug text)
returns public.platform_content_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.platform_content_pages;
  v_slug text := lower(trim(coalesce(p_slug,'')));
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode='42501';
  end if;
  update public.platform_content_pages
  set published = draft,
      is_published = true,
      version = version + 1,
      published_at = now(),
      published_by = auth.uid(),
      updated_at = now(),
      updated_by = auth.uid()
  where slug = v_slug
  returning * into v_row;
  if v_row.slug is null then raise exception 'Content page not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(auth.uid(),'PLATFORM_CONTENT_PUBLISHED','PLATFORM_CONTENT',null,jsonb_build_object('slug',v_slug,'version',v_row.version));
  return v_row;
end;
$$;
grant execute on function public.admin_publish_public_content_page(text) to authenticated;

create or replace function public.admin_unpublish_public_content_page(p_slug text)
returns public.platform_content_pages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.platform_content_pages;
  v_slug text := lower(trim(coalesce(p_slug,'')));
begin
  if not public.is_platform_admin() then
    raise exception 'Platform admin access required' using errcode='42501';
  end if;
  update public.platform_content_pages
  set is_published = false,
      updated_at = now(),
      updated_by = auth.uid()
  where slug = v_slug
  returning * into v_row;
  if v_row.slug is null then raise exception 'Content page not found'; end if;
  insert into public.admin_audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
  values(auth.uid(),'PLATFORM_CONTENT_UNPUBLISHED','PLATFORM_CONTENT',null,jsonb_build_object('slug',v_slug));
  return v_row;
end;
$$;
grant execute on function public.admin_unpublish_public_content_page(text) to authenticated;

select pg_notify('pgrst','reload schema');
