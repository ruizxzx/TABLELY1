-- Keep inventory failures visible without making WARNING-mode stock tracking
-- failures stop order operations. STRICT mode remains fail-closed.
begin;

create table if not exists public.inventory_processing_errors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete restrict,
  order_status text not null check (order_status in ('ACCEPTED', 'COMPLETED', 'CANCELLED')),
  error_code text not null,
  error_message text not null,
  occurrences integer not null default 1 check (occurrences > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  unique (order_id, order_status, error_code)
);

create index if not exists inventory_processing_errors_branch_idx
  on public.inventory_processing_errors(branch_id, resolved_at, last_seen_at desc);

alter table public.inventory_processing_errors enable row level security;

create policy inventory_processing_errors_select on public.inventory_processing_errors
  for select to authenticated
  using (
    public.current_user_has_permission_for_branch(branch_id, 'INVENTORY_MANAGEMENT')
    and public.organization_has_feature(organization_id, 'INVENTORY')
  );

grant select on public.inventory_processing_errors to authenticated;
revoke all on public.inventory_processing_errors from anon;

create or replace function public.inventory_order_lifecycle_hook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_stock_mode text := 'WARNING';
begin
  if old.status = new.status then return new; end if;
  if new.status not in ('ACCEPTED', 'COMPLETED', 'CANCELLED') then return new; end if;

  select b.organization_id into v_organization_id
  from public.branches b
  where b.id = new.branch_id;

  if v_organization_id is null
     or not public.organization_has_feature(v_organization_id, 'INVENTORY') then
    return new;
  end if;

  select s.stock_mode into v_stock_mode
  from public.branch_inventory_settings s
  where s.branch_id = new.branch_id;
  v_stock_mode := coalesce(v_stock_mode, 'WARNING');

  if v_stock_mode = 'DISABLED' then return new; end if;

  begin
    if new.status = 'ACCEPTED' then
      perform public.inventory_reserve_for_order(new.id);
    elsif new.status = 'COMPLETED' then
      perform public.inventory_consume_for_order(new.id);
    elsif new.status = 'CANCELLED' then
      perform public.inventory_release_reservation(new.id);
    end if;
  exception when others then
    if v_stock_mode = 'STRICT' then
      raise;
    end if;

    insert into public.inventory_processing_errors(
      organization_id, branch_id, order_id, order_status, error_code, error_message
    ) values (
      v_organization_id, new.branch_id, new.id, new.status::text, sqlstate,
      left(sqlerrm, 500)
    )
    on conflict (order_id, order_status, error_code)
    do update set
      occurrences = public.inventory_processing_errors.occurrences + 1,
      last_seen_at = now(),
      error_message = excluded.error_message,
      resolved_at = null,
      resolved_by = null;
  end;

  return new;
end;
$$;

create or replace function public.inventory_resolve_processing_error(p_error_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_error public.inventory_processing_errors;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_error
  from public.inventory_processing_errors
  where id = p_error_id
  for update;

  if v_error.id is null then
    raise exception 'Inventory processing error not found' using errcode = 'P0002';
  end if;
  if not public.organization_has_feature(v_error.organization_id, 'INVENTORY')
     or not public.current_user_has_permission_for_branch(v_error.branch_id, 'INVENTORY_MANAGEMENT') then
    raise exception 'INVENTORY_MANAGEMENT permission required' using errcode = '42501';
  end if;

  update public.inventory_processing_errors
  set resolved_at = now(), resolved_by = auth.uid()
  where id = p_error_id;
end;
$$;

grant execute on function public.inventory_resolve_processing_error(uuid) to authenticated;
revoke execute on function public.inventory_resolve_processing_error(uuid) from public, anon;

select pg_notify('pgrst', 'reload schema');
commit;
