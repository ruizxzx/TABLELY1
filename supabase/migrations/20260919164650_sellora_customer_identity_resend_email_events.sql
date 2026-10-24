-- SELLORA customer identity, persistent order history and Resend email event audit.
alter table public.orders
  add column if not exists customer_id uuid references public.profiles(id) on delete set null;

create index if not exists orders_customer_id_created_idx
  on public.orders(customer_id, created_at desc);

create table if not exists public.sellora_email_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  event_type text not null,
  recipient text not null,
  subject text not null,
  template_key text not null,
  entity_type text,
  entity_id uuid,
  provider text not null default 'resend',
  provider_message_id text,
  status text not null default 'queued' check (status in ('queued','processing','sent','retrying','failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sellora_email_events_status_created_idx
  on public.sellora_email_events(status, created_at desc);
create index if not exists sellora_email_events_recipient_created_idx
  on public.sellora_email_events(recipient, created_at desc);

alter table public.sellora_email_events enable row level security;
drop policy if exists "sellora email events service only" on public.sellora_email_events;
create policy "sellora email events service only"
  on public.sellora_email_events for all to anon, authenticated
  using (false) with check (false);

drop policy if exists "customers read own orders" on public.orders;
create policy "customers read own orders"
  on public.orders for select to authenticated
  using (auth.uid() = customer_id);

create or replace function public.sellora_link_guest_orders_to_user(p_user_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  user_email text;
  linked_count integer;
begin
  select lower(email) into user_email from auth.users where id = p_user_id;
  if user_email is null then return 0; end if;
  update public.orders
     set customer_id = p_user_id, updated_at = now()
   where customer_id is null and lower(buyer_email) = user_email;
  get diagnostics linked_count = row_count;
  return linked_count;
end;
$$;
revoke all on function public.sellora_link_guest_orders_to_user(uuid) from public, anon, authenticated;
grant execute on function public.sellora_link_guest_orders_to_user(uuid) to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;

  update public.orders
     set customer_id = new.id, updated_at = now()
   where customer_id is null and lower(buyer_email) = lower(new.email);
  return new;
end;
$$;

update public.orders o
   set customer_id = u.id, updated_at = now()
  from auth.users u
 where o.customer_id is null and lower(o.buyer_email) = lower(u.email);
