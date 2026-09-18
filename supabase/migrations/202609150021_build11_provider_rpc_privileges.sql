-- Provider synchronization RPCs are server-only; clients must not forge billing events.
revoke execute on function public.admin_set_provider_plan_id(text, text) from public, authenticated;
grant execute on function public.admin_set_provider_plan_id(text, text) to service_role;

revoke execute on function public.record_subscription_provider_creation(uuid, text, text) from public, authenticated;
grant execute on function public.record_subscription_provider_creation(uuid, text, text) to service_role;

revoke execute on function public.record_subscription_webhook_event(text, text, text, jsonb) from public, authenticated;
grant execute on function public.record_subscription_webhook_event(text, text, text, jsonb) to service_role;

revoke execute on function public.apply_provider_subscription_event(text, text, text, text, text, jsonb) from public, authenticated;
grant execute on function public.apply_provider_subscription_event(text, text, text, text, text, jsonb) to service_role;
