begin;

-- Keep order-detail visibility consistent with customer history. A customer
-- owns an order through the authenticated profile relationship; account
-- activation is enforced when account-only flows are created, not when
-- previously-owned orders are read.
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
