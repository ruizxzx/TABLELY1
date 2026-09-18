-- Platform billing operations: subscription actions, invoice/event visibility,
-- and cross-restaurant coupon controls.

create or replace function public.admin_list_billing_events(
  p_limit integer default 200
)
returns table(
  id uuid,
  organization_id uuid,
  organization_name text,
  subscription_id uuid,
  provider_event_id text,
  provider_subscription_id text,
  provider_payment_id text,
  event_type text,
  status text,
  amount numeric,
  currency text,
  occurred_at timestamptz,
  payload jsonb
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  return query
  select e.id, e.organization_id, o.name, e.subscription_id, e.provider_event_id,
         e.provider_subscription_id, e.provider_payment_id, e.event_type, e.status,
         e.amount, e.currency, e.occurred_at, e.payload
  from public.subscription_billing_events e
  left join public.organizations o on o.id = e.organization_id
  order by e.occurred_at desc
  limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;

create or replace function public.admin_list_invoices(
  p_limit integer default 200
)
returns table(
  id uuid,
  organization_id uuid,
  organization_name text,
  provider_payment_id text,
  provider_subscription_id text,
  status text,
  amount numeric,
  currency text,
  issued_at timestamptz,
  event_type text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  return query
  select e.id, e.organization_id, o.name, e.provider_payment_id,
         e.provider_subscription_id, e.status, e.amount, e.currency,
         e.occurred_at, e.event_type
  from public.subscription_billing_events e
  left join public.organizations o on o.id = e.organization_id
  where lower(e.event_type) like '%invoice%'
     or lower(e.event_type) like '%payment%'
  order by e.occurred_at desc
  limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;

create or replace function public.admin_list_coupons(
  p_limit integer default 500
)
returns table(
  id uuid,
  organization_id uuid,
  organization_name text,
  branch_id uuid,
  code text,
  title text,
  discount_type text,
  discount_value numeric,
  is_active boolean,
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit_total integer,
  usage_count bigint,
  updated_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  return query
  select c.id, c.organization_id, o.name, c.branch_id, c.code, c.title,
         c.discount_type, c.discount_value, c.is_active, c.starts_at, c.ends_at,
         c.usage_limit_total, count(u.id), c.updated_at
  from public.coupons c
  join public.organizations o on o.id = c.organization_id
  left join public.coupon_usages u on u.coupon_id = c.id
  group by c.id, o.name
  order by c.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 500), 1000));
end;
$$;

create or replace function public.admin_set_coupon_status(
  p_coupon_id uuid,
  p_is_active boolean
)
returns public.coupons
language plpgsql
security definer
set search_path = public
as $$
declare v_coupon public.coupons;
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  update public.coupons
  set is_active = p_is_active, updated_at = now()
  where id = p_coupon_id
  returning * into v_coupon;
  if v_coupon.id is null then raise exception 'Coupon not found'; end if;
  insert into public.admin_audit_logs(actor_user_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), case when p_is_active then 'COUPON_ENABLED' else 'COUPON_DISABLED' end, 'COUPON', p_coupon_id,
          jsonb_build_object('is_active', p_is_active));
  return v_coupon;
end;
$$;

create or replace function public.admin_delete_coupon(p_coupon_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admin access required' using errcode = '42501'; end if;
  if not exists (select 1 from public.coupons where id = p_coupon_id) then raise exception 'Coupon not found'; end if;
  delete from public.coupons where id = p_coupon_id;
  insert into public.admin_audit_logs(actor_user_id, action, entity_type, entity_id)
  values (auth.uid(), 'COUPON_DELETED', 'COUPON', p_coupon_id);
end;
$$;

grant execute on function public.admin_list_billing_events(integer) to authenticated;
grant execute on function public.admin_list_invoices(integer) to authenticated;
grant execute on function public.admin_list_coupons(integer) to authenticated;
grant execute on function public.admin_set_coupon_status(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_coupon(uuid) to authenticated;
