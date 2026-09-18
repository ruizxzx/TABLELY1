-- TABLELY: expose charge breakdown on the customer-facing order/bill.
--
-- get_public_order (from 202609140010) predates the charges feature
-- (202609142000) and was never updated: it returns subtotal/tax/discount/
-- total, but not the `additional_charges` (fee-type charges, e.g. a
-- "Platform charge") or `charge_breakdown` (itemized name/amount per
-- charge) columns that create_order_for_table already stores on every
-- order. Net effect: any FEE-type charge silently inflated the customer's
-- total with no visible line item explaining it, and TAX-type charges were
-- shown only as one lump "tax" number instead of itemized (e.g. "GST 5%").

drop function if exists public.get_public_order(text);

create function public.get_public_order(p_tracking_token text)
returns table (
  order_id uuid,
  order_number bigint,
  restaurant_name text,
  table_number integer,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  subtotal numeric,
  tax numeric,
  additional_charges numeric,
  discount numeric,
  total numeric,
  charge_breakdown jsonb,
  created_at timestamptz,
  item_id uuid,
  item_name text,
  quantity integer,
  unit_price numeric,
  line_total numeric,
  selected_addons jsonb,
  special_instructions text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.order_number,
    org.name,
    t.table_number,
    o.status,
    o.payment_status,
    o.payment_method,
    o.subtotal,
    o.tax,
    o.additional_charges,
    o.discount,
    o.total,
    o.charge_breakdown,
    o.created_at,
    oi.id,
    oi.item_name_snapshot,
    oi.quantity,
    oi.unit_price,
    oi.line_total,
    oi.selected_addons,
    oi.special_instructions
  from public.orders o
  join public.tables t on t.id = o.table_id
  join public.branches b on b.id = o.branch_id
  join public.organizations org on org.id = b.organization_id
  left join public.order_items oi on oi.order_id = o.id
  where o.tracking_token = trim(p_tracking_token)
  order by oi.id asc;
$$;

grant execute on function public.get_public_order(text) to anon, authenticated;
alter function public.get_public_order(text) set search_path = public;

notify pgrst, 'reload schema';
