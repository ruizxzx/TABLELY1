-- Sellora Build 1+2 hardening: plan downgrade archival, plan recovery, category status, external-link delivery,
-- and public preview delivery.
-- Safe/idempotent. Run after 008_admin_creator_access_trials.sql.

alter table public.store_categories
  add column if not exists status text not null default 'live',
  add column if not exists plan_archived boolean not null default false,
  add column if not exists plan_archived_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'store_categories_status_check') then
    alter table public.store_categories add constraint store_categories_status_check check (status in ('live','archived'));
  end if;
end $$;

alter table public.products
  add column if not exists digital_delivery_type text not null default 'upload',
  add column if not exists file_access_url text,
  add column if not exists plan_archived boolean not null default false,
  add column if not exists plan_archived_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_digital_delivery_type_check') then
    alter table public.products add constraint products_digital_delivery_type_check check (digital_delivery_type in ('upload','link'));
  end if;
end $$;

alter table public.order_items
  add column if not exists file_access_url text;

-- Existing file-backed products keep upload delivery.
update public.products
set digital_delivery_type='upload'
where digital_delivery_type is null;

create index if not exists store_categories_store_status_idx
  on public.store_categories(store_id, status, is_visible, sort_order, created_at desc);
create index if not exists products_store_status_created_idx
  on public.products(store_id, status, created_at desc);

create or replace function public.sellora_plan_rank(p_plan text)
returns integer
language sql immutable as $$
  select case p_plan when 'free' then 0 when 'creator' then 1 when 'pro' then 2 when 'max' then 3 else 0 end;
$$;

create or replace function public.sellora_validate_delivery(p_type text, p_file_path text, p_file_access_url text)
returns void
language plpgsql immutable as $$
begin
  if p_type not in ('upload','link') then
    raise exception using errcode='23514', message='INVALID_DELIVERY_TYPE';
  end if;
  if p_type='upload' and nullif(trim(coalesce(p_file_path,'')),'') is null then
    raise exception using errcode='23514', message='DIGITAL_FILE_REQUIRED';
  end if;
  if p_type='link' then
    if nullif(trim(coalesce(p_file_access_url,'')),'') is null then
      raise exception using errcode='23514', message='DIGITAL_LINK_REQUIRED';
    end if;
    if p_file_access_url !~* '^https?://' then
      raise exception using errcode='23514', message='INVALID_DIGITAL_LINK';
    end if;
  end if;
end;
$$;

create or replace function public.sellora_apply_plan_limits(p_creator_id uuid, p_old_plan text default 'free', p_new_plan text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_old_rank integer := public.sellora_plan_rank(coalesce(p_old_plan,'free'));
  v_new_rank integer;
  v_now timestamptz := now();
begin
  select id into v_store_id from public.stores where owner_id=p_creator_id limit 1;
  if v_store_id is null then return; end if;

  v_plan := coalesce(p_new_plan, public.sellora_effective_plan(p_creator_id));
  v_new_rank := public.sellora_plan_rank(v_plan);
  select max_products,max_categories into v_max_products,v_max_categories
  from public.sellora_plan_limits(v_plan);

  -- Upgrade: restore content previously taken offline by a plan downgrade, newest first.
  if v_new_rank > v_old_rank then
    if v_max_categories = 9223372036854775807 then
      update public.store_categories
      set status='live', is_visible=true, plan_archived=false, plan_archived_at=null, updated_at=v_now
      where store_id=v_store_id and status='archived' and plan_archived=true;
    else
      with ranked as (
        select id, row_number() over(order by plan_archived_at desc nulls last, created_at desc, id desc) rn
        from public.store_categories
        where store_id=v_store_id and status='archived' and plan_archived=true
      )
      update public.store_categories c
      set status='live', is_visible=true, plan_archived=false, plan_archived_at=null, updated_at=v_now
      from ranked r
      where c.id=r.id and r.rn <= v_max_categories;
    end if;

    if v_max_products = 9223372036854775807 then
      update public.products p
      set status='live', plan_archived=false, plan_archived_at=null, updated_at=v_now
      where p.store_id=v_store_id and p.status='archived' and p.plan_archived=true
        and exists (
          select 1 from public.store_categories c
          where c.id=p.category_id and c.status='live' and c.is_visible=true
        );
    else
      with ranked as (
        select p.id, row_number() over(order by p.plan_archived_at desc nulls last, coalesce(p.published_at,p.created_at) desc, p.id desc) rn
        from public.products p
        where p.store_id=v_store_id and p.status='archived' and p.plan_archived=true
          and exists (
            select 1 from public.store_categories c
            where c.id=p.category_id and c.status='live' and c.is_visible=true
          )
      )
      update public.products p
      set status='live', plan_archived=false, plan_archived_at=null,
          published_at=coalesce(p.published_at,v_now), updated_at=v_now
      from ranked r
      where p.id=r.id and r.rn <= v_max_products;
    end if;
  end if;

  -- Categories: only currently-live/visible sections consume the active category allowance.
  if v_max_categories <> 9223372036854775807 then
    with ranked as (
      select c.id,
             row_number() over(order by c.created_at desc, c.id desc) rn
      from public.store_categories c
      where c.store_id=v_store_id and c.status='live' and c.is_visible=true
    )
    update public.store_categories c
    set status='archived', is_visible=false, plan_archived=true, plan_archived_at=v_now, updated_at=v_now
    from ranked r
    where c.id=r.id and r.rn > v_max_categories;
  end if;

  -- Products in plan-archived categories are also taken offline.
  update public.products p
  set status='archived', plan_archived=true, plan_archived_at=v_now, updated_at=v_now
  where p.store_id=v_store_id and p.status='live'
    and exists (
      select 1 from public.store_categories c
      where c.id=p.category_id and (c.status<>'live' or c.is_visible=false) and c.plan_archived=true
    );

  -- Product allowance applies to live products. When over a limit, the newest live products are archived first.
  if v_max_products <> 9223372036854775807 then
    with ranked as (
      select p.id,
             row_number() over(order by p.created_at desc, p.id desc) rn
      from public.products p
      where p.store_id=v_store_id and p.status='live'
    )
    update public.products p
    set status='archived', plan_archived=true, plan_archived_at=v_now, updated_at=v_now
    from ranked r
    where p.id=r.id and r.rn > v_max_products;
  end if;
end;
$$;

-- Replace the entitlement trigger so publishing itself consumes the active limit, and use live counts rather than total historical rows.
create or replace function public.sellora_check_store_entitlements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_plan text;
  v_max_products bigint;
  v_max_categories bigint;
  v_product_count bigint;
  v_category_count bigint;
  v_store_id uuid;
begin
  v_store_id := coalesce(new.store_id, old.store_id);
  select owner_id into v_owner from public.stores where id=v_store_id;
  if v_owner is null then raise exception using errcode='23503', message='STORE_NOT_FOUND'; end if;

  v_plan := coalesce(public.sellora_effective_plan(v_owner),'free');
  select max_products,max_categories into v_max_products,v_max_categories from public.sellora_plan_limits(v_plan);

  if tg_table_name='products' then
    if tg_op in ('INSERT','UPDATE') and new.status='live' then
      if new.category_id is null then raise exception using errcode='23514', message='CATEGORY_REQUIRED'; end if;
      if not exists (
        select 1 from public.store_categories c
        where c.id=new.category_id and c.store_id=v_store_id and c.status='live' and c.is_visible=true
      ) then
        raise exception using errcode='23514', message='INVALID_CATEGORY';
      end if;
      perform public.sellora_validate_delivery(new.digital_delivery_type, new.file_path, new.file_access_url);
      if v_max_products <> 9223372036854775807 then
        select count(*) into v_product_count from public.products
        where store_id=v_store_id and status='live' and id<>coalesce(new.id,'00000000-0000-0000-0000-000000000000'::uuid);
        if v_product_count >= v_max_products then raise exception using errcode='42501', message='PRODUCT_LIMIT_REACHED'; end if;
      end if;
    end if;
    if tg_op='UPDATE' and new.store_id<>old.store_id then
      raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED';
    end if;
  else
    if tg_op in ('INSERT','UPDATE') and new.status='live' and new.is_visible=true then
      if v_max_categories <> 9223372036854775807 then
        select count(*) into v_category_count from public.store_categories
        where store_id=v_store_id and status='live' and is_visible=true and id<>coalesce(new.id,'00000000-0000-0000-0000-000000000000'::uuid);
        if v_category_count >= v_max_categories then raise exception using errcode='42501', message='CATEGORY_LIMIT_REACHED'; end if;
      end if;
    end if;
    if tg_op='UPDATE' and new.store_id<>old.store_id then
      raise exception using errcode='42501', message='STORE_CHANGE_NOT_ALLOWED';
    end if;
  end if;
  return case when tg_op='DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_products_entitlements on public.products;
create trigger trg_products_entitlements
before insert or update of store_id, category_id, status, visibility, digital_delivery_type, file_path, file_access_url
on public.products
for each row execute function public.sellora_check_store_entitlements();

drop trigger if exists trg_categories_entitlements on public.store_categories;
create trigger trg_categories_entitlements
before insert or update of store_id, status, is_visible
on public.store_categories
for each row execute function public.sellora_check_store_entitlements();

-- Any admin/billing plan change immediately reconciles active/live content.
create or replace function public.sellora_reconcile_plan_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_effective text;
  v_new_effective text;
begin
  v_old_effective := case
    when old.access_starts_at is not null and old.access_starts_at > now() then 'free'
    when old.access_expires_at is not null and old.access_expires_at <= now() then 'free'
    else coalesce(old.plan,'free')
  end;
  v_new_effective := case
    when new.access_starts_at is not null and new.access_starts_at > now() then 'free'
    when new.access_expires_at is not null and new.access_expires_at <= now() then 'free'
    else coalesce(new.plan,'free')
  end;
  perform public.sellora_apply_plan_limits(new.creator_id, v_old_effective, v_new_effective);
  return new;
end;
$$;

drop trigger if exists trg_creator_plans_reconcile on public.creator_plans;
create trigger trg_creator_plans_reconcile
after update of plan, access_starts_at, access_expires_at on public.creator_plans
for each row execute function public.sellora_reconcile_plan_change();

-- Safe recovery when a category is explicitly restored by the creator: it is subject to the current category cap.
comment on column public.store_categories.plan_archived is 'True only when Sellora automatically archived this category because of a plan entitlement change.';
comment on column public.products.plan_archived is 'True only when Sellora automatically archived this product because of a plan entitlement change.';
comment on column public.products.file_access_url is 'External HTTPS delivery URL used when digital_delivery_type=link.';
comment on column public.products.preview_file_path is 'Optional private preview file that can be opened or downloaded publicly through the signed preview endpoint for live products.';


create or replace function public.sellora_reconcile_my_plan()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception using errcode='42501', message='UNAUTHORIZED';
  end if;
  perform public.sellora_apply_plan_limits(auth.uid(), 'free', public.sellora_effective_plan(auth.uid()));
end;
$$;

grant execute on function public.sellora_reconcile_my_plan() to authenticated;

-- Reconcile existing creators once so a pre-existing account also respects the new active/live limits.
do $$
declare r record;
begin
  for r in select creator_id from public.creator_plans loop
    perform public.sellora_apply_plan_limits(r.creator_id, 'max', public.sellora_effective_plan(r.creator_id));
  end loop;
end $$;

-- These SECURITY DEFINER routines are internal implementation details; client sessions must not invoke them directly.
revoke all on function public.sellora_apply_plan_limits(uuid,text,text) from public, anon, authenticated;
revoke all on function public.sellora_reconcile_plan_change() from public, anon, authenticated;
revoke all on function public.sellora_check_store_entitlements() from public, anon, authenticated;
