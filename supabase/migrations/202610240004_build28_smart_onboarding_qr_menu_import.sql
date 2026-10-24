-- TABLELY BUILD 28 — Smart onboarding, menu import history and permanent QR destinations.
-- Additive and data-preserving. Existing slug/table-code QR URLs remain valid.

begin;

-- Persist onboarding progress server-side so an owner can resume across devices.
alter table public.organizations
  add column if not exists onboarding_progress jsonb not null default '{"step":1,"completedSteps":[]}'::jsonb,
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists restaurant_category text,
  add column if not exists cuisine_type text,
  add column if not exists business_email text;

-- Existing restaurants already have a provisioned workspace; do not interrupt
-- their current operation by showing the new-restaurant setup wizard.
update public.organizations
set onboarding_progress = '{"step":7,"completedSteps":[1,2,3,4,5,6,7]}'::jsonb,
    onboarding_completed_at = coalesce(onboarding_completed_at, now())
where onboarding_completed_at is null;

-- Existing branch timezone is part of Build 12; add structured hours separately.
alter table public.branches
  add column if not exists business_hours jsonb not null default '{}'::jsonb;

-- Give every table a stable opaque QR identifier. Existing table_code URLs continue
-- to work and remain unchanged; newly generated QR cards use /q/{public_qr_id}.
alter table public.tables
  add column if not exists public_qr_id uuid default gen_random_uuid();

update public.tables
set public_qr_id = gen_random_uuid()
where public_qr_id is null;

alter table public.tables
  alter column public_qr_id set default gen_random_uuid(),
  alter column public_qr_id set not null;

create unique index if not exists tables_public_qr_id_uidx
  on public.tables(public_qr_id);

-- Imported records remain explicit drafts until an owner activates them.
alter table public.menu_items
  add column if not exists is_draft boolean not null default false;

-- Private menu-import audit trail. Source files are stored in the private
-- menu-imports Storage bucket and never made publicly readable.
create table if not exists public.menu_import_jobs (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  source_filename text not null,
  source_mime_type text not null,
  source_storage_path text,
  status text not null default 'PROCESSING'
    check (status in ('PROCESSING','PREVIEW','COMPLETED','FAILED')),
  preview_data jsonb not null default '[]'::jsonb,
  extracted_count integer not null default 0 check (extracted_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  selected_count integer not null default 0 check (selected_count >= 0),
  skipped_duplicate_count integer not null default 0 check (skipped_duplicate_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.menu_import_jobs
  add column if not exists selected_count integer not null default 0,
  add column if not exists skipped_duplicate_count integer not null default 0;

create index if not exists menu_import_jobs_branch_created_idx
  on public.menu_import_jobs(branch_id, created_at desc);
create index if not exists menu_import_jobs_user_created_idx
  on public.menu_import_jobs(user_id, created_at desc);

alter table public.menu_import_jobs enable row level security;

drop policy if exists menu_import_jobs_select_authorized on public.menu_import_jobs;
create policy menu_import_jobs_select_authorized
  on public.menu_import_jobs
  for select to authenticated
  using (public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT'));

drop policy if exists menu_import_jobs_insert_authorized on public.menu_import_jobs;
create policy menu_import_jobs_insert_authorized
  on public.menu_import_jobs
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
  );

drop policy if exists menu_import_jobs_update_authorized on public.menu_import_jobs;
create policy menu_import_jobs_update_authorized
  on public.menu_import_jobs
  for update to authenticated
  using (
    (user_id = auth.uid() or exists (
      select 1 from public.branches b
      where b.id = menu_import_jobs.branch_id
        and public.is_org_owner(b.organization_id)
    ))
    and public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
  )
  with check (
    (user_id = auth.uid() or exists (
      select 1 from public.branches b
      where b.id = menu_import_jobs.branch_id
        and public.is_org_owner(b.organization_id)
    ))
    and public.current_user_has_permission_for_branch(branch_id, 'MENU_MANAGEMENT')
  );

grant select, insert, update on public.menu_import_jobs to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'menu-imports',
  'menu-imports',
  false,
  20971520,
  array[
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = 20971520,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.commit_menu_import_job(
  p_job_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_job public.menu_import_jobs%rowtype;
  v_item jsonb;
  v_variant jsonb;
  v_group jsonb;
  v_modifier jsonb;
  v_name text;
  v_category text;
  v_description text;
  v_group_name text;
  v_group_id uuid;
  v_modifier_name text;
  v_selection_mode text;
  v_is_required boolean;
  v_min_select integer;
  v_max_select integer;
  v_price numeric(12,2);
  v_category_id uuid;
  v_item_id uuid;
  v_inserted integer := 0;
  v_skipped integer := 0;
  v_variants integer := 0;
  v_modifier_groups integer := 0;
  v_modifiers integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Menu items must be supplied as an array';
  end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 500 then
    raise exception 'Select between 1 and 500 menu items';
  end if;

  select * into v_job
  from public.menu_import_jobs
  where id = p_job_id
  for update;

  if not found then raise exception 'Menu import job not found'; end if;
  if v_job.user_id <> auth.uid() and not exists (
    select 1 from public.branches b
    where b.id = v_job.branch_id and public.is_org_owner(b.organization_id)
  ) then
    raise exception 'Only the uploader or restaurant owner can finalize this import' using errcode = '42501';
  end if;
  if v_job.status <> 'PREVIEW' then raise exception 'Menu import is not awaiting approval'; end if;
  if not public.current_user_has_permission_for_branch(v_job.branch_id, 'MENU_MANAGEMENT') then
    raise exception 'Menu management permission is required' using errcode = '42501';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_name := left(trim(coalesce(v_item->>'name', '')), 140);
    v_category := left(trim(coalesce(v_item->>'category', 'Uncategorized')), 80);
    v_description := nullif(left(trim(coalesce(v_item->>'description', '')), 600), '');
    if v_name = '' then raise exception 'Every imported item requires a name'; end if;
    if coalesce(v_item->>'price', '') !~ '^([0-9]+)(\.[0-9]{1,2})?$' then
      raise exception 'A valid non-negative price is required for item %', v_name;
    end if;
    if (v_item->>'price')::numeric > 9999999999.99 then raise exception 'Menu item price exceeds the supported maximum for %', v_name; end if;
    v_price := (v_item->>'price')::numeric(12,2);
    if v_price < 0 then raise exception 'Negative prices are not allowed'; end if;
    if v_category = '' then v_category := 'Uncategorized'; end if;

    select id into v_category_id
    from public.menu_categories
    where branch_id = v_job.branch_id and lower(name) = lower(v_category)
    limit 1;

    if v_category_id is null then
      insert into public.menu_categories(branch_id, name)
      values(v_job.branch_id, v_category)
      on conflict (branch_id, name) do nothing
      returning id into v_category_id;
      if v_category_id is null then
        select id into v_category_id from public.menu_categories
        where branch_id = v_job.branch_id and lower(name) = lower(v_category) limit 1;
      end if;
    end if;
    if v_category_id is null then raise exception 'Could not resolve menu category %', v_category; end if;

    if exists (
      select 1 from public.menu_items
      where branch_id = v_job.branch_id
        and category_id = v_category_id
        and lower(name) = lower(v_name)
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    insert into public.menu_items(
      branch_id, category_id, name, description, price, is_veg, is_available, is_draft
    ) values (
      v_job.branch_id, v_category_id, v_name, v_description, v_price,
      case when jsonb_typeof(v_item->'is_veg') = 'boolean' then (v_item->>'is_veg')::boolean else null end,
      false, true
    ) returning id into v_item_id;

    if jsonb_typeof(v_item->'variants') = 'array' then
      for v_variant in select value from jsonb_array_elements(v_item->'variants')
      loop
        if nullif(trim(coalesce(v_variant->>'name', '')), '') is not null then
          if coalesce(v_variant->>'price_delta', '0') !~ '^-?([0-9]+)(\.[0-9]{1,2})?$' then
            raise exception 'Invalid variant price adjustment for %', v_name;
          end if;
          if abs((v_variant->>'price_delta')::numeric) > 1000000 then raise exception 'Variant price adjustment exceeds the supported limit for %', v_name; end if;
          insert into public.menu_item_variants(menu_item_id, name, price_delta, is_available)
          values(v_item_id, left(trim(v_variant->>'name'), 80), (v_variant->>'price_delta')::numeric(12,2), true)
          on conflict (menu_item_id, name) do nothing;
          v_variants := v_variants + 1;
        end if;
      end loop;
    end if;
    if jsonb_typeof(v_item->'modifier_groups') = 'array' then
      for v_group in select value from jsonb_array_elements(v_item->'modifier_groups')
      loop
        v_group_name := nullif(trim(coalesce(v_group->>'name', '')), '');
        if v_group_name is null then continue; end if;
        -- The existing schema scopes modifier-group names to a branch. Prefixing
        -- with the dish keeps independently extracted groups isolated and avoids
        -- silently merging different add-on lists that happen to share a label.
        v_group_name := left(left(v_name, 45) || ' · ' || left(v_group_name, 70), 120);
        v_selection_mode := case when v_group->>'selection_mode' = 'SINGLE' then 'SINGLE' else 'MULTI' end;
        v_is_required := coalesce((v_group->>'is_required')::boolean, false);
        v_max_select := case when v_selection_mode = 'SINGLE' then 1 else coalesce((v_group->>'max_select')::integer, 3) end;
        v_min_select := coalesce((v_group->>'min_select')::integer, case when v_is_required then 1 else 0 end);
        if v_max_select < 1 or v_max_select > 100 or v_min_select < 0 or v_min_select > v_max_select or (v_is_required and v_min_select < 1) then
          raise exception 'Invalid modifier selection rules for %', v_name;
        end if;

        insert into public.modifier_groups(branch_id, name, description, is_required, selection_mode, min_select, max_select, is_active)
        values(v_job.branch_id, v_group_name, nullif(left(trim(coalesce(v_group->>'description', '')), 300), ''), v_is_required, v_selection_mode, v_min_select, v_max_select, true)
        on conflict (branch_id, name) do nothing;
        select id into v_group_id from public.modifier_groups
        where branch_id = v_job.branch_id and name = v_group_name limit 1;
        if v_group_id is null then raise exception 'Could not create modifier group for %', v_name; end if;
        insert into public.menu_item_modifier_groups(menu_item_id, modifier_group_id)
        values(v_item_id, v_group_id)
        on conflict (menu_item_id, modifier_group_id) do nothing;
        v_modifier_groups := v_modifier_groups + 1;

        if jsonb_typeof(v_group->'modifiers') = 'array' then
          for v_modifier in select value from jsonb_array_elements(v_group->'modifiers')
          loop
            v_modifier_name := left(trim(coalesce(v_modifier->>'name', '')), 80);
            if v_modifier_name = '' then continue; end if;
            if coalesce(v_modifier->>'price_delta', '0') !~ '^-?([0-9]+)(\.[0-9]{1,2})?$' then
              raise exception 'Invalid modifier price adjustment for %', v_name;
            end if;
            if abs((v_modifier->>'price_delta')::numeric) > 1000000 then raise exception 'Modifier price adjustment exceeds the supported limit for %', v_name; end if;
            insert into public.modifiers(modifier_group_id, name, description, price_delta, is_available)
            values(v_group_id, v_modifier_name, nullif(left(trim(coalesce(v_modifier->>'description', '')), 300), ''), (v_modifier->>'price_delta')::numeric(12,2), true)
            on conflict (modifier_group_id, name) do nothing;
            v_modifiers := v_modifiers + 1;
          end loop;
        end if;
      end loop;
    end if;
    v_inserted := v_inserted + 1;
  end loop;

  update public.menu_import_jobs
  set status = 'COMPLETED', imported_count = v_inserted,
      selected_count = jsonb_array_length(p_items),
      skipped_duplicate_count = v_skipped, rejected_count = 0,
      updated_at = now(), error_message = null
  where id = v_job.id;

  return jsonb_build_object(
    'imported', v_inserted,
    'skipped_duplicates', v_skipped,
    'variants_created_or_matched', v_variants,
    'modifier_groups_created_or_matched', v_modifier_groups,
    'modifiers_created_or_matched', v_modifiers,
    'drafts_require_activation', true
  );
end;
$$;

grant execute on function public.commit_menu_import_job(uuid, jsonb) to authenticated;
revoke execute on function public.commit_menu_import_job(uuid, jsonb) from anon, public;

-- Idempotent table-creation batches make onboarding safe to retry after a timeout.
create table if not exists public.onboarding_table_batches (
  branch_id uuid not null references public.branches(id) on delete cascade,
  request_id uuid not null,
  table_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  primary key (branch_id, request_id)
);
alter table public.onboarding_table_batches enable row level security;
grant select, insert, update on public.onboarding_table_batches to authenticated;

drop policy if exists onboarding_table_batches_owner_select on public.onboarding_table_batches;
create policy onboarding_table_batches_owner_select on public.onboarding_table_batches
  for select to authenticated using (
    exists (select 1 from public.branches b where b.id = branch_id and public.is_org_owner(b.organization_id))
  );

drop policy if exists onboarding_table_batches_owner_insert on public.onboarding_table_batches;
create policy onboarding_table_batches_owner_insert on public.onboarding_table_batches
  for insert to authenticated with check (
    exists (select 1 from public.branches b where b.id = branch_id and public.is_org_owner(b.organization_id))
  );

drop policy if exists onboarding_table_batches_owner_update on public.onboarding_table_batches;
create policy onboarding_table_batches_owner_update on public.onboarding_table_batches
  for update to authenticated using (
    exists (select 1 from public.branches b where b.id = branch_id and public.is_org_owner(b.organization_id))
  ) with check (
    exists (select 1 from public.branches b where b.id = branch_id and public.is_org_owner(b.organization_id))
  );

create or replace function public.create_onboarding_tables(
  p_branch_id uuid,
  p_count integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org_id uuid;
  v_batch public.onboarding_table_batches%rowtype;
  v_start integer;
  v_index integer;
  v_table_id uuid;
  v_ids uuid[] := '{}'::uuid[];
  v_code text;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if p_count is null or p_count < 1 or p_count > 100 then raise exception 'Create between 1 and 100 tables'; end if;
  if p_request_id is null then raise exception 'A request identifier is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_branch_id::text, 0));

  select organization_id into v_org_id from public.branches where id = p_branch_id and is_active = true;
  if v_org_id is null or not public.is_org_owner(v_org_id) then
    raise exception 'Only the restaurant owner can create onboarding tables' using errcode = '42501';
  end if;

  insert into public.onboarding_table_batches(branch_id, request_id)
  values(p_branch_id, p_request_id)
  on conflict (branch_id, request_id) do nothing;

  select * into v_batch from public.onboarding_table_batches
  where branch_id = p_branch_id and request_id = p_request_id
  for update;

  if cardinality(v_batch.table_ids) > 0 then
    return jsonb_build_object('table_ids', to_jsonb(v_batch.table_ids), 'replayed', true);
  end if;

  select coalesce(max(table_number), 0) + 1 into v_start
  from public.tables where branch_id = p_branch_id;

  for v_index in 0..(p_count - 1) loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    insert into public.tables(branch_id, table_number, table_code, active, seats)
    values(p_branch_id, v_start + v_index, v_code, true, 4)
    returning id into v_table_id;
    v_ids := array_append(v_ids, v_table_id);
  end loop;

  update public.onboarding_table_batches set table_ids = v_ids
  where branch_id = p_branch_id and request_id = p_request_id;

  return jsonb_build_object('table_ids', to_jsonb(v_ids), 'replayed', false);
end;
$$;

grant execute on function public.create_onboarding_tables(uuid, integer, uuid) to authenticated;
revoke execute on function public.create_onboarding_tables(uuid, integer, uuid) from anon, public;

notify pgrst, 'reload schema';
commit;
