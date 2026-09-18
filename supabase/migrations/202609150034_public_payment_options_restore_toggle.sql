-- Fix: "Pay online" never appears at customer checkout even after the owner
-- enables it and saves Razorpay keys in /settings/payments.
--
-- Root cause: Build 11's migration (202609150019_build11_feature_gate_integrations.sql)
-- rewrote get_public_payment_options() to only check organization_has_feature()
-- (the plan-tier entitlement), and dropped the earlier check against
-- restaurant_payment_settings.enabled entirely. So the owner-facing ON/OFF
-- toggle became a no-op for what customers actually see — even though the
-- real payment-creation route (app/api/payments/create) still correctly
-- checks both conditions before ever charging anyone. This migration restores
-- the original AND of both conditions, so the customer-facing option matches
-- what the owner configured and what the server will actually allow.
-- Additive/idempotent.

create or replace function public.get_public_payment_options(p_table_code text)
returns table(online_payment_enabled boolean, plan_id text)
language sql
security definer
set search_path = public
as $$
  select
    (
      public.organization_has_feature(o.id, 'ONLINE_PAYMENTS')
      and coalesce(rps.enabled, false)
    ) as online_payment_enabled,
    os.plan_id
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  left join public.organization_subscriptions os on os.organization_id = o.id
  left join public.restaurant_payment_settings rps on rps.organization_id = o.id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;
$$;
grant execute on function public.get_public_payment_options(text) to anon, authenticated;

select pg_notify('pgrst','reload schema');
