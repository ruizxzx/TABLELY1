drop policy if exists sellora_public_content_service_only on public.sellora_public_content;
create or replace function public.sellora_touch_contact_updated_at()
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
