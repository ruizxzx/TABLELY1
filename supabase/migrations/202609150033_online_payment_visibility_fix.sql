-- Fix: "Pay online" missing on the customer checkout page.
-- organization_has_feature() was never granted EXECUTE to the anon role,
-- even though get_public_payment_options() (which anonymous, unauthenticated
-- customers call from the checkout page) depends on it internally. Also
-- covers get_public_checkout_charges-style public RPCs that share the same
-- feature-gate helper, for consistency.
-- Additive/idempotent.

grant execute on function public.organization_has_feature(uuid, text) to anon, authenticated, service_role;

select pg_notify('pgrst','reload schema');
