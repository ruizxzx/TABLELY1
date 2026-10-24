-- Final Build 5 security hardening. Keep trigger function resolution deterministic.
create or replace function public.sellora_touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
