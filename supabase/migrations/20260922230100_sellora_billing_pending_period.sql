alter table public.sellora_subscriptions
  add column if not exists pending_billing_period text check (pending_billing_period in ('monthly','yearly'));
