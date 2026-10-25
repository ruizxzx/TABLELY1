begin;

create table if not exists public.restaurant_ai_daily_usage (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  usage_date date not null default (now() at time zone 'utc')::date,
  request_count integer not null default 0 check (request_count >= 0),
  reserved_output_tokens integer not null default 0 check (reserved_output_tokens >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, usage_date)
);

alter table public.restaurant_ai_daily_usage enable row level security;
revoke all on public.restaurant_ai_daily_usage from public, anon, authenticated;
grant all on public.restaurant_ai_daily_usage to service_role;

create or replace function public.reserve_restaurant_ai_request(
  p_organization_id uuid,
  p_branch_id uuid,
  p_reserved_tokens integer
)
returns table (allowed boolean, remaining_requests integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_tokens integer;
begin
  if p_reserved_tokens < 1 or p_reserved_tokens > 400 then
    raise exception 'Invalid assistant token reservation' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.branches b
    join public.organizations o on o.id = b.organization_id
    where b.id = p_branch_id and b.organization_id = p_organization_id
      and b.is_active and o.status = 'ACTIVE'::public.account_status
  ) then
    raise exception 'Restaurant branch scope is invalid' using errcode = '42501';
  end if;

  insert into public.restaurant_ai_daily_usage as daily_usage (
    organization_id, usage_date, request_count, reserved_output_tokens, updated_at
  )
  values (p_organization_id, (now() at time zone 'utc')::date, 1, p_reserved_tokens, now())
  on conflict (organization_id, usage_date) do update
  set request_count = daily_usage.request_count + 1,
      reserved_output_tokens = daily_usage.reserved_output_tokens + p_reserved_tokens,
      updated_at = now()
  where daily_usage.request_count < 30
    and daily_usage.reserved_output_tokens + p_reserved_tokens <= 12000
  returning request_count, reserved_output_tokens into v_count, v_tokens;

  if v_count is null then
    return query select false, 0;
  else
    return query select true, greatest(0, 30 - v_count);
  end if;
end;
$$;

revoke all on function public.reserve_restaurant_ai_request(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_restaurant_ai_request(uuid, uuid, integer) to service_role;

create or replace function public.get_restaurant_ai_public_context(p_table_code text)
returns table (
  organization_id uuid,
  branch_id uuid,
  restaurant_name text,
  menu jsonb,
  popular_items jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    o.id,
    b.id,
    o.name,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', menu.item_id,
        'name', menu.item_name,
        'description', menu.item_description,
        'category', menu.category_name,
        'price', menu.item_price
      ) order by menu.category_sort, menu.item_name)
      from (
        select public_menu.*
        from public.get_public_menu_for_table(trim(p_table_code)) public_menu
        where public_menu.item_id is not null and public_menu.is_available = true
        order by public_menu.category_sort, public_menu.item_name
        limit 40
      ) menu
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object('id', ranked.item_id, 'name', ranked.item_name) order by ranked.quantity desc, ranked.item_name)
      from (
        select mi.id as item_id, mi.name as item_name, sum(oi.quantity)::integer as quantity
        from public.orders o2
        join public.order_items oi on oi.order_id = o2.id
        join public.menu_items mi on mi.id = oi.menu_item_id and mi.branch_id = b.id
        where o2.branch_id = b.id
          and o2.payment_status = 'PAID'::public.payment_status
          and o2.created_at >= now() - interval '90 days'
          and mi.is_available = true and not mi.is_draft
        group by mi.id, mi.name
        having count(distinct o2.id) >= 3
        order by sum(oi.quantity) desc, mi.name
        limit 5
      ) ranked
    ), '[]'::jsonb)
  from public.tables t
  join public.branches b on b.id = t.branch_id and b.is_active
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;
$$;

revoke all on function public.get_restaurant_ai_public_context(text) from public, anon, authenticated;
grant execute on function public.get_restaurant_ai_public_context(text) to service_role;

commit;
