begin;

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
  select cp.id,
    cp.name,
    cp.email,
    cp.phone,
    min(o.created_at),
    count(o.id),
    coalesce(sum(o.total), 0),
    max(o.created_at),
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

commit;

notify pgrst, 'reload schema';
