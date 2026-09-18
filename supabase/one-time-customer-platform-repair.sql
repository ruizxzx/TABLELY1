-- TABLELY ONE-TIME CUSTOMER PLATFORM REPAIR
-- Run this entire file once in Supabase SQL Editor.

begin;

alter table public.customer_profiles
  add column if not exists customer_account_enabled boolean not null default false;

create or replace function public.build22_current_customer_profile()
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then return null; end if;
  select id into v_id
  from public.customer_profiles
  where auth_user_id = auth.uid()
    and customer_account_enabled = true;
  return v_id;
end;
$$;

revoke execute on function public.build22_current_customer_profile() from anon, public;
grant execute on function public.build22_current_customer_profile() to authenticated;

create or replace function public.get_branch_customer_detail(
  p_branch_id uuid,
  p_customer_profile_id uuid
)
returns table(
  customer_profile_id uuid,
  name text,
  email text,
  phone text,
  customer_since timestamptz,
  total_orders bigint,
  total_spend numeric,
  last_order_at timestamptz,
  active_pay_later numeric
)
language sql
security definer
stable
set search_path = public
as $$
  select cp.id, cp.name, cp.email, cp.phone, min(o.created_at),
    count(o.id), coalesce(sum(o.total), 0), max(o.created_at),
    coalesce(sum(case
      when o.table_session_id is not null
       and o.payment_status = 'PENDING'
       and o.status not in ('CANCELLED', 'REJECTED')
      then o.total else 0 end), 0)
  from public.customer_profiles cp
  join public.orders o on o.customer_profile_id = cp.id
  where cp.id = p_customer_profile_id
    and o.branch_id = p_branch_id
    and public.current_user_has_permission_for_branch(p_branch_id, 'EDIT_ORDERS')
  group by cp.id, cp.name, cp.email, cp.phone;
$$;

create or replace function public.get_branch_customer_orders(
  p_branch_id uuid,
  p_customer_profile_id uuid
)
returns table(
  order_id uuid,
  order_number bigint,
  created_at timestamptz,
  total numeric,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text
)
language sql
security definer
stable
set search_path = public
as $$
  select o.id, o.order_number, o.created_at, o.total, o.status,
    o.payment_status, o.payment_method
  from public.orders o
  where o.branch_id = p_branch_id
    and o.customer_profile_id = p_customer_profile_id
    and public.current_user_has_permission_for_branch(p_branch_id, 'EDIT_ORDERS')
  order by o.created_at desc;
$$;

revoke execute on function public.get_branch_customer_detail(uuid, uuid) from anon, public;
revoke execute on function public.get_branch_customer_orders(uuid, uuid) from anon, public;
grant execute on function public.get_branch_customer_detail(uuid, uuid) to authenticated;
grant execute on function public.get_branch_customer_orders(uuid, uuid) to authenticated;

create or replace function public.get_my_customer_order_detail(p_order_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'restaurant_name', org.name,
    'branch_name', b.name,
    'created_at', o.created_at,
    'status', o.status,
    'payment_status', o.payment_status,
    'payment_method', o.payment_method,
    'total', o.total,
    'items', coalesce((
      select jsonb_agg(to_jsonb(oi) order by oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  join public.branches b on b.id = o.branch_id
  join public.organizations org on org.id = b.organization_id
  join public.customer_profiles cp
    on cp.id = o.customer_profile_id
   and cp.auth_user_id = auth.uid()
  where o.id = p_order_id;
$$;

revoke execute on function public.get_my_customer_order_detail(uuid) from anon, public;
grant execute on function public.get_my_customer_order_detail(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Customer platform repair completed' as result;
