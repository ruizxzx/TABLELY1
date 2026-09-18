begin;

-- Customer-authorized, read-only receipt projection. Totals come directly
-- from the order record so the receipt cannot recalculate or change billing.
create or replace function public.get_my_customer_receipt(p_order_id uuid)
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
    'branch_address', b.address,
    'branch_phone', b.phone,
    'created_at', o.created_at,
    'status', o.status,
    'payment_status', o.payment_status,
    'payment_method', o.payment_method,
    'subtotal', o.subtotal,
    'tax', o.tax,
    'additional_charges', o.additional_charges,
    'discount', o.discount,
    'coupon_code', o.coupon_code_snapshot,
    'total', o.total,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', oi.id,
        'item_name_snapshot', oi.item_name_snapshot,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'line_total', oi.line_total,
        'selected_addons', oi.selected_addons,
        'selected_options', oi.selected_options,
        'special_instructions', oi.special_instructions
      ) order by oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  join public.branches b
    on b.id = o.branch_id
  join public.organizations org
    on org.id = b.organization_id
  join public.customer_profiles cp
    on cp.id = o.customer_profile_id
   and cp.auth_user_id = auth.uid()
  where o.id = p_order_id;
$$;

revoke execute on function public.get_my_customer_receipt(uuid) from anon, public;
grant execute on function public.get_my_customer_receipt(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';
