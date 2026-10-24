-- Allow server-side billing workflows to manage plan and subscription records.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.sellora_plans, public.sellora_plan_versions, public.sellora_plan_variants, public.sellora_subscriptions, public.sellora_subscription_events, public.sellora_subscription_payments, public.sellora_billing_audits to service_role;
