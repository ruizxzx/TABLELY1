-- TABLELY BUILD 35.10 — Qualify public tracking order_id lookup
-- Prevent collision between the OUT parameter and fulfillment table column.

begin;

create or replace function public.get_public_fulfillment_order(p_tracking_token text)
returns table (
  order_id uuid, order_number bigint, restaurant_name text, branch_name text,
  branch_address text, branch_phone text, fulfillment_type text,
  fulfillment_status text, status public.order_status,
  payment_status public.payment_status, payment_method text, subtotal numeric,
  tax numeric, additional_charges numeric, discount numeric, total numeric,
  charge_breakdown jsonb, created_at timestamptz, scheduled_for timestamptz,
  promised_ready_at timestamptz, promised_delivery_at timestamptz,
  pickup_code text, delivery_otp text, delivery_address jsonb,
  delivery_instructions text, rejection_reason text, items jsonb
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_order public.orders%rowtype;
  v_ofd public.order_fulfillment_details%rowtype;
  v_branch public.branches%rowtype;
  v_org public.organizations%rowtype;
  v_items jsonb;
begin
  if trim(coalesce(p_tracking_token, '')) !~ '^[a-f0-9]{32,64}$' then return; end if;
  select * into v_order
  from public.orders o
  where o.tracking_token = trim(p_tracking_token)
  limit 1;
  if v_order.id is null then return; end if;

  select * into v_ofd
  from public.order_fulfillment_details ofd
  where ofd.order_id = v_order.id;
  select * into v_branch from public.branches b where b.id = v_order.branch_id;
  select * into v_org
  from public.organizations o
  where o.id = v_branch.organization_id and o.status = 'ACTIVE'::public.account_status;
  if v_org.id is null then return; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', oi.id, 'name', oi.item_name_snapshot, 'quantity', oi.quantity,
    'unit_price', oi.unit_price, 'line_total', oi.line_total,
    'selected_addons', oi.selected_addons, 'selected_options', oi.selected_options,
    'special_instructions', oi.special_instructions
  ) order by oi.id asc), '[]'::jsonb)
  into v_items
  from public.order_items oi
  where oi.order_id = v_order.id;

  return query select
    v_order.id, v_order.order_number, v_org.name, v_branch.name,
    v_branch.address, v_branch.phone, v_order.fulfillment_type,
    coalesce(v_ofd.fulfillment_status, 'NOT_STARTED'), v_order.status,
    v_order.payment_status, v_order.payment_method, v_order.subtotal, v_order.tax,
    v_order.additional_charges, v_order.discount, v_order.total,
    v_order.charge_breakdown, v_order.created_at, v_ofd.scheduled_for,
    v_ofd.promised_ready_at, v_ofd.promised_delivery_at,
    null::text, null::text, v_ofd.address_snapshot,
    v_ofd.delivery_instructions, v_order.rejection_reason, v_items;
end;
$$;

grant execute on function public.get_public_fulfillment_order(text) to anon, authenticated;
notify pgrst, 'reload schema';
commit;