-- Branch analytics RPC used by the Analytics screen.
create or replace function public.get_branch_analytics(
  p_branch_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_branch_member(p_branch_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'revenue', coalesce(sum(case when o.payment_status = 'PAID' then o.total else 0 end), 0),
    'orders', count(*),
    'completed_orders', count(*) filter (where o.status = 'COMPLETED'),
    'average_order_value', coalesce(avg(o.total), 0),
    'paid_orders', count(*) filter (where o.payment_status = 'PAID'),
    'cancelled_orders', count(*) filter (where o.status = 'CANCELLED'),
    'online_revenue', coalesce(sum(case when o.payment_status = 'PAID' and o.payment_method = 'PAY_NOW' then o.total else 0 end), 0),
    'counter_revenue', coalesce(sum(case when o.payment_status = 'PAID' and coalesce(o.payment_method, '') not like 'PAY_NOW:%' then o.total else 0 end), 0)
  )
  into v_result
  from public.orders o
  where o.branch_id = p_branch_id
    and o.created_at >= p_from
    and o.created_at < p_to;

  return v_result;
end;
$$;

grant execute on function public.get_branch_analytics(uuid, timestamptz, timestamptz) to authenticated;
