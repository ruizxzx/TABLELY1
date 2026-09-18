-- TABLELY BUILD 5 — Realtime operations
-- Additive and idempotent. Do not drop existing RLS/policies with CASCADE.

create extension if not exists pgcrypto with schema extensions;

alter table public.orders add column if not exists updated_at timestamptz not null default now();
alter table public.orders replica identity full;

create table if not exists public.service_requests (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  table_id uuid not null references public.tables(id) on delete cascade,
  type text not null check (type in ('WAITER','WATER','BILL','ASSISTANCE')),
  status text not null default 'OPEN' check (status in ('OPEN','ACKNOWLEDGED','RESOLVED','CANCELLED')),
  note text,
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists service_requests_branch_status_idx on public.service_requests(branch_id, status, created_at desc);
create index if not exists service_requests_table_idx on public.service_requests(table_id, created_at desc);

create table if not exists public.order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  actor_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists order_events_order_id_idx on public.order_events(order_id, created_at desc);
create index if not exists order_events_branch_idx on public.order_events(branch_id, created_at desc);
alter table public.order_events enable row level security;

drop policy if exists order_events_select_member on public.order_events;
create policy order_events_select_member on public.order_events for select to authenticated using (public.is_branch_member(branch_id));
revoke insert, update, delete on public.order_events from authenticated;
grant select on public.order_events to authenticated;

create or replace function public.touch_updated_at()
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

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at before update on public.orders for each row execute function public.touch_updated_at();

-- Keep the existing transition function signature. Use local names instead of output-column names to avoid ambiguity.
create or replace function public.transition_order_status(p_order_id uuid, p_new_status public.order_status)
returns table (
  id uuid,
  order_number bigint,
  table_id uuid,
  branch_id uuid,
  status public.order_status,
  payment_status public.payment_status,
  payment_method text,
  subtotal numeric,
  tax numeric,
  discount numeric,
  total numeric,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_allowed boolean := false;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;

  select o.* into v_order from public.orders as o where o.id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  select s.* into v_staff
  from public.staff as s
  where s.user_id = v_user and s.branch_id = v_order.branch_id
  order by case when s.role = 'OWNER' then 0 when s.role = 'MANAGER' then 1 when s.role = 'KITCHEN' then 2 else 3 end, s.created_at
  limit 1;
  if v_staff.id is null then raise exception 'You do not have access to this order' using errcode='42501'; end if;

  if v_order.status = 'NEW' and p_new_status in ('ACCEPTED','CANCELLED') then v_allowed := true;
  elsif v_order.status = 'NEW' and p_new_status = 'PREPARING' and v_staff.role = 'KITCHEN' then v_allowed := true;
  elsif v_order.status = 'ACCEPTED' and p_new_status in ('PREPARING','CANCELLED') then v_allowed := true;
  elsif v_order.status = 'PREPARING' and p_new_status = 'READY' then v_allowed := true;
  elsif v_order.status = 'READY' and p_new_status = 'SERVED' then v_allowed := true;
  elsif v_order.status = 'SERVED' and p_new_status = 'COMPLETED' then v_allowed := true;
  end if;
  if not v_allowed then raise exception 'Invalid order status transition: % → %', v_order.status, p_new_status; end if;

  if v_staff.role = 'KITCHEN' and p_new_status not in ('PREPARING','READY','SERVED') then raise exception 'Kitchen role cannot perform this transition' using errcode='42501'; end if;
  if v_staff.role = 'WAITER' and p_new_status not in ('ACCEPTED','SERVED','COMPLETED') then raise exception 'Waiter role cannot perform this transition' using errcode='42501'; end if;

  update public.orders as ord
  set status = p_new_status, updated_at = now()
  where ord.id = v_order.id;

  insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id)
  values(v_order.id, v_order.branch_id, 'STATUS_CHANGED', v_order.status::text, p_new_status::text, v_user);

  return query
  select ord.id, ord.order_number, ord.table_id, ord.branch_id, ord.status, ord.payment_status, ord.payment_method,
         ord.subtotal, ord.tax, ord.discount, ord.total, ord.created_at, ord.updated_at
  from public.orders as ord
  where ord.id = v_order.id;
end;
$$;
grant execute on function public.transition_order_status(uuid, public.order_status) to authenticated;

-- Customer-safe public broadcast. Only a narrow payload is exposed; the database row is never broadcast wholesale.
create or replace function public.broadcast_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token text := coalesce(NEW.tracking_token, OLD.tracking_token);
  v_payload jsonb;
begin
  if v_token is null or length(v_token) < 16 then return coalesce(NEW, OLD); end if;
  v_payload := jsonb_build_object(
    'order_id', NEW.id,
    'status', NEW.status::text,
    'payment_status', NEW.payment_status::text,
    'updated_at', NEW.updated_at
  );
  perform realtime.send(v_payload, 'ORDER_STATUS', 'tablely:order:' || v_token, false);
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists orders_broadcast_status on public.orders;
create trigger orders_broadcast_status
after insert or update of status, payment_status on public.orders
for each row execute function public.broadcast_order_status_change();

-- Staff realtime uses Postgres Changes and existing RLS. Service requests are also in the realtime publication.
alter table public.service_requests replica identity full;
do $$
begin
  begin alter publication supabase_realtime add table public.orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.service_requests; exception when duplicate_object then null; end;
end $$;

create index if not exists orders_branch_status_created_idx on public.orders(branch_id, status, created_at desc);
create index if not exists orders_branch_updated_idx on public.orders(branch_id, updated_at desc);
create index if not exists service_requests_branch_status_created_idx on public.service_requests(branch_id, status, created_at desc);

select pg_notify('pgrst','reload schema');
