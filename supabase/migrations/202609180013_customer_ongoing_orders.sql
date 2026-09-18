begin;

-- Server-authoritative view of orders belonging to the signed-in customer.
create or replace function public.get_my_customer_ongoing_orders()
returns table(
  order_id uuid,
  order_number bigint,
  restaurant_name text,
  created_at timestamptz,
  total numeric,
  status public.order_status,
  payment_status public.payment_status
)
language sql
security definer
stable
set search_path = public
as $$
  select o.id, o.order_number, org.name, o.created_at, o.total, o.status, o.payment_status
  from public.orders o
  join public.branches b on b.id = o.branch_id
  join public.organizations org on org.id = b.organization_id
  join public.customer_profiles cp on cp.id = o.customer_profile_id
  where cp.auth_user_id = auth.uid()
    and o.status not in ('COMPLETED', 'CANCELLED', 'REJECTED')
  order by o.created_at desc;
$$;

revoke execute on function public.get_my_customer_ongoing_orders() from anon, public;
grant execute on function public.get_my_customer_ongoing_orders() to authenticated;

commit;
