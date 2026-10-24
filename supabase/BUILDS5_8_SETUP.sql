-- TABLELY BUILDS 5-8
-- Realtime operations, kitchen/staff service tools, payments/billing, hardening & analytics.
-- Designed to be applied on the existing Build 3/4 project. No DROP ... CASCADE.
-- Uses schema-qualified extensions/realtime objects for SECURITY DEFINER functions.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Operational columns ----------
alter table public.orders add column if not exists razorpay_order_id text;
alter table public.orders add column if not exists razorpay_payment_id text;
alter table public.orders add column if not exists paid_at timestamptz;
alter table public.orders add column if not exists updated_at timestamptz not null default now();

create index if not exists orders_updated_at_idx on public.orders(updated_at desc);
create unique index if not exists orders_razorpay_order_uidx
  on public.orders(razorpay_order_id) where razorpay_order_id is not null;
create unique index if not exists orders_razorpay_payment_uidx
  on public.orders(razorpay_payment_id) where razorpay_payment_id is not null;

-- ---------- Audit/event history ----------
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

-- ---------- Payment transactions ----------
create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  provider text not null default 'MANUAL',
  provider_order_id text,
  provider_payment_id text,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'INR',
  status text not null,
  method text,
  failure_reason text,
  raw_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_transactions_order_idx on public.payment_transactions(order_id, created_at desc);
create index if not exists payment_transactions_branch_idx on public.payment_transactions(branch_id, created_at desc);
create unique index if not exists payment_transactions_provider_payment_uidx
  on public.payment_transactions(provider_payment_id);

-- ---------- Customer service requests ----------
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

-- ---------- Persistent rate limiting ----------
create table if not exists public.rate_limit_buckets (
  key text primary key,
  window_started_at timestamptz not null,
  hit_count integer not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------- Updated-at trigger ----------
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
drop trigger if exists payment_transactions_set_updated_at on public.payment_transactions;
create trigger payment_transactions_set_updated_at before update on public.payment_transactions for each row execute function public.touch_updated_at();

-- ---------- Rate limit RPC ----------
create or replace function public.allow_rate_limit(p_key text, p_window_seconds integer, p_max_requests integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_row public.rate_limit_buckets%rowtype;
  v_window interval := make_interval(secs => greatest(1, least(p_window_seconds, 3600)));
begin
  if coalesce(trim(p_key), '') = '' then raise exception 'Rate limit key required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(trim(p_key), 0));
  select * into v_row from public.rate_limit_buckets where key = trim(p_key) for update;

  if v_row.key is null or v_row.window_started_at + v_window <= v_now then
    insert into public.rate_limit_buckets(key, window_started_at, hit_count, updated_at)
    values (trim(p_key), v_now, 1, v_now)
    on conflict (key) do update set window_started_at = excluded.window_started_at, hit_count = 1, updated_at = v_now;
    return true;
  end if;

  if v_row.hit_count >= greatest(1, least(p_max_requests, 1000)) then
    return false;
  end if;

  update public.rate_limit_buckets set hit_count = hit_count + 1, updated_at = v_now where key = v_row.key;
  return true;
end;
$$;
grant execute on function public.allow_rate_limit(text, integer, integer) to anon, authenticated;

-- ---------- Order status transition ----------
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
  v_allowed boolean := false;
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;

  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;

  select s.* into v_staff
  from public.staff s
  where s.user_id = v_user and s.branch_id = v_order.branch_id
  order by case when s.role='OWNER' then 0 when s.role='MANAGER' then 1 when s.role='KITCHEN' then 2 else 3 end, s.created_at
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

  if v_staff.role = 'KITCHEN' and p_new_status not in ('PREPARING','READY','SERVED') then
    raise exception 'Kitchen role cannot perform this transition' using errcode='42501';
  end if;
  if v_staff.role = 'WAITER' and p_new_status not in ('ACCEPTED','SERVED','COMPLETED') then
    raise exception 'Waiter role cannot perform this transition' using errcode='42501';
  end if;

  update public.orders
  set status = p_new_status, updated_at = now()
  where id = p_order_id;

  insert into public.order_events(order_id, branch_id, event_type, from_status, to_status, actor_user_id)
  values (v_order.id, v_order.branch_id, 'STATUS_CHANGED', v_order.status::text, p_new_status::text, v_user);

  return query
  select o.id,o.order_number,o.table_id,o.branch_id,o.status,o.payment_status,o.payment_method,
         o.subtotal,o.tax,o.discount,o.total,o.created_at,o.updated_at
  from public.orders o where o.id=p_order_id;
end;
$$;
grant execute on function public.transition_order_status(uuid, public.order_status) to authenticated;

-- ---------- Public order creation (hardened replacement) ----------
create or replace function public.create_order_for_table(
  p_table_code text,
  p_items jsonb,
  p_payment_method text default 'PAY_AT_COUNTER',
  p_idempotency_key text default null,
  p_customer_note text default null
)
returns table (
  order_id uuid,
  order_number bigint,
  tracking_token text,
  total numeric,
  payment_status public.payment_status,
  status public.order_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_existing public.orders%rowtype;
  v_order_id uuid;
  v_branch_id uuid;
  v_item jsonb;
  v_menu public.menu_items%rowtype;
  v_qty integer;
  v_subtotal numeric(12,2) := 0;
  v_addon_total numeric(12,2);
  v_idempotency text := nullif(trim(coalesce(p_idempotency_key,'')), '');
  v_payment_method text := upper(trim(coalesce(p_payment_method,'PAY_AT_COUNTER')));
begin
  if not public.allow_rate_limit('order:' || trim(coalesce(p_table_code,'')), 60, 60) then
    raise exception 'Too many order attempts. Please wait a minute and try again.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'Cart must contain between 1 and 50 line items';
  end if;
  if v_payment_method not in ('PAY_NOW','PAY_AT_COUNTER') then raise exception 'Unsupported payment method'; end if;

  select t.* into v_table
  from public.tables t
  join public.branches b on b.id=t.branch_id
  join public.organizations o on o.id=b.organization_id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status
  limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  v_branch_id := v_table.branch_id;

  if v_idempotency is not null then
    select o.* into v_existing from public.orders o
    where o.branch_id=v_branch_id and o.idempotency_key=v_idempotency limit 1;
    if v_existing.id is not null then
      return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.total,v_existing.payment_status,v_existing.status;
      return;
    end if;
  end if;

  -- Serialize orders for a table so two retries cannot create inconsistent table state.
  perform pg_advisory_xact_lock(hashtextextended('tablely-order:'||v_table.id::text,0));

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if not (v_item ? 'menu_item_id') or not (v_item ? 'quantity') then raise exception 'Invalid cart item'; end if;
    begin
      v_qty := (v_item->>'quantity')::integer;
    exception when invalid_text_representation then
      raise exception 'Invalid cart quantity';
    end;
    if v_qty < 1 or v_qty > 50 then raise exception 'Quantity must be between 1 and 50'; end if;

    select m.* into v_menu from public.menu_items m
    where m.id=(v_item->>'menu_item_id')::uuid and m.branch_id=v_branch_id and m.is_available=true;
    if v_menu.id is null then raise exception 'One or more items are unavailable'; end if;

    if jsonb_typeof(coalesce(v_item->'addons','[]'::jsonb)) <> 'array' then raise exception 'Invalid add-ons'; end if;

    -- Every selected add-on must exist on this item, and its price is taken from the database.
    if exists (
      select 1 from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested
      where not exists (
        select 1 from jsonb_array_elements(coalesce(v_menu.addons,'[]'::jsonb)) available
        where lower(available->>'name')=lower(requested->>'name')
      )
    ) then raise exception 'One or more selected add-ons are invalid'; end if;

    select coalesce(sum(coalesce((a->>'price')::numeric,0)),0) into v_addon_total
    from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested
    join jsonb_array_elements(coalesce(v_menu.addons,'[]'::jsonb)) a
      on lower(a->>'name')=lower(requested->>'name');

    if v_addon_total < 0 or v_addon_total > 100000 then raise exception 'Invalid add-on total'; end if;
    v_subtotal := v_subtotal + round((v_menu.price + v_addon_total) * v_qty, 2);
    if v_subtotal > 1000000 then raise exception 'Order amount exceeds the allowed limit'; end if;
  end loop;

  insert into public.orders(branch_id,table_id,status,payment_status,payment_method,subtotal,tax,discount,total,idempotency_key,tracking_token,customer_note)
  values(v_branch_id,v_table.id,'NEW','PENDING',v_payment_method,v_subtotal,0,0,v_subtotal,
    coalesce(v_idempotency, encode(extensions.gen_random_bytes(16),'hex')),
    encode(extensions.gen_random_bytes(16),'hex'),
    nullif(left(trim(coalesce(p_customer_note,'')),300),''))
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    select m.* into v_menu from public.menu_items m
    where m.id=(v_item->>'menu_item_id')::uuid and m.branch_id=v_branch_id;
    v_qty := (v_item->>'quantity')::integer;
    select coalesce(sum(coalesce((a->>'price')::numeric,0)),0) into v_addon_total
    from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) requested
    join jsonb_array_elements(coalesce(v_menu.addons,'[]'::jsonb)) a
      on lower(a->>'name')=lower(requested->>'name');

    insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price,quantity,selected_addons,special_instructions)
    values(v_order_id,v_menu.id,v_menu.name,round(v_menu.price+v_addon_total,2),v_qty,
      coalesce((
        select jsonb_agg(jsonb_build_object('name',a->>'name','price',coalesce((a->>'price')::numeric,0)) order by a->>'name')
        from jsonb_array_elements(coalesce(v_menu.addons,'[]'::jsonb)) a
        where exists(select 1 from jsonb_array_elements(coalesce(v_item->'addons','[]'::jsonb)) req where lower(req->>'name')=lower(a->>'name'))
      ),'[]'::jsonb),
      nullif(left(trim(coalesce(v_item->>'note','')),300),''));
  end loop;

  return query
  select o.id,o.order_number,o.tracking_token,o.total,o.payment_status,o.status
  from public.orders o where o.id=v_order_id;

exception when unique_violation then
  if v_idempotency is not null then
    select o.* into v_existing from public.orders o where o.branch_id=v_branch_id and o.idempotency_key=v_idempotency limit 1;
    if v_existing.id is not null then
      return query select v_existing.id,v_existing.order_number,v_existing.tracking_token,v_existing.total,v_existing.payment_status,v_existing.status;
      return;
    end if;
  end if;
  raise;
end;
$$;
grant execute on function public.create_order_for_table(text,jsonb,text,text,text) to anon, authenticated;

-- ---------- Manual payment RPC ----------
create or replace function public.mark_order_paid(
  p_order_id uuid,
  p_method text,
  p_reference text default null
)
returns table (
  id uuid,
  payment_status public.payment_status,
  payment_method text,
  paid_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_staff public.staff%rowtype;
  v_user uuid := auth.uid();
  v_method text := upper(trim(coalesce(p_method,'CASH')));
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select o.* into v_order from public.orders o where o.id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found'; end if;
  select s.* into v_staff from public.staff s where s.user_id=v_user and s.branch_id=v_order.branch_id
    order by case when s.role='OWNER' then 0 when s.role='MANAGER' then 1 else 2 end limit 1;
  if v_staff.id is null or v_staff.role not in ('OWNER','MANAGER','WAITER') then
    raise exception 'You are not authorized to mark payments';
  end if;
  if v_order.payment_status='PAID' then
    return query select o.id,o.payment_status,o.payment_method,o.paid_at from public.orders o where o.id=p_order_id;
    return;
  end if;
  if v_method not in ('CASH','UPI','CARD') then raise exception 'Unsupported manual payment method'; end if;

  update public.orders as ord
  set payment_status='PAID', payment_method=v_method, paid_at=coalesce(ord.paid_at,now()), updated_at=now()
  where ord.id=p_order_id;

  insert into public.payment_transactions(order_id,branch_id,provider,amount,status,method,raw_metadata)
  values(v_order.id,v_order.branch_id,'MANUAL',v_order.total,'PAID',v_method,
         jsonb_build_object('reference',nullif(left(trim(coalesce(p_reference,'')),120),''),'actor_user_id',v_user::text));
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'PAYMENT_MARKED_PAID',v_user,jsonb_build_object('method',v_method));

  return query select o.id,o.payment_status,o.payment_method,o.paid_at from public.orders o where o.id=p_order_id;
end;
$$;
grant execute on function public.mark_order_paid(uuid,text,text) to authenticated;

-- ---------- Public service requests ----------
create or replace function public.create_service_request_for_table(
  p_table_code text,
  p_type text,
  p_note text default null
)
returns table (
  id uuid,
  branch_id uuid,
  table_id uuid,
  type text,
  status text,
  note text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare v_table public.tables%rowtype; v_type text:=upper(trim(coalesce(p_type,'')));
begin
  if not public.allow_rate_limit('service:'||trim(coalesce(p_table_code,'')),60,10) then raise exception 'Too many service requests. Please wait a moment.'; end if;
  select t.* into v_table from public.tables t join public.branches b on b.id=t.branch_id join public.organizations o on o.id=b.organization_id
  where t.table_code=trim(p_table_code) and t.active=true and o.status='ACTIVE'::public.account_status limit 1;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if v_type not in ('WAITER','WATER','BILL','ASSISTANCE') then raise exception 'Unsupported service request'; end if;
  if exists(select 1 from public.service_requests r where r.table_id=v_table.id and r.type=v_type and r.status in ('OPEN','ACKNOWLEDGED')) then
    raise exception 'This request is already open';
  end if;
  return query
  insert into public.service_requests(branch_id,table_id,type,status,note)
  values(v_table.branch_id,v_table.id,v_type,'OPEN',nullif(left(trim(coalesce(p_note,'')),300),''))
  returning service_requests.id,service_requests.branch_id,service_requests.table_id,service_requests.type,service_requests.status,service_requests.note,service_requests.created_at;
end;
$$;
grant execute on function public.create_service_request_for_table(text,text,text) to anon, authenticated;

-- ---------- Staff service request RPC ----------
create or replace function public.resolve_service_request(p_request_id uuid, p_status text default 'RESOLVED')
returns public.service_requests
language plpgsql
security definer
set search_path = public
as $$
declare v_req public.service_requests%rowtype; v_staff public.staff%rowtype; v_user uuid:=auth.uid(); v_new text:=upper(trim(coalesce(p_status,'RESOLVED')));
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  select r.* into v_req from public.service_requests r where r.id=p_request_id for update;
  if v_req.id is null then raise exception 'Service request not found'; end if;
  select s.* into v_staff from public.staff s where s.user_id=v_user and s.branch_id=v_req.branch_id limit 1;
  if v_staff.id is null or v_staff.role not in ('OWNER','MANAGER','WAITER') then raise exception 'Not authorized' using errcode='42501'; end if;
  if v_new not in ('ACKNOWLEDGED','RESOLVED','CANCELLED') then raise exception 'Invalid service request status'; end if;
  update public.service_requests
  set status=v_new,resolved_by=case when v_new='RESOLVED' then v_user else resolved_by end,resolved_at=case when v_new='RESOLVED' then now() else resolved_at end
  where id=p_request_id;
  select * into v_req from public.service_requests where id=p_request_id;
  return v_req;
end;
$$;
grant execute on function public.resolve_service_request(uuid,text) to authenticated;

-- ---------- Analytics RPC ----------
create or replace function public.get_branch_analytics(
  p_branch_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_allowed boolean; v_result jsonb;
begin
  v_allowed := public.is_branch_member(p_branch_id);
  if not v_allowed then raise exception 'Not authorized' using errcode='42501'; end if;
  select jsonb_build_object(
    'revenue', coalesce(sum(case when o.payment_status='PAID' then o.total else 0 end),0),
    'orders', count(*),
    'completed_orders', count(*) filter(where o.status='COMPLETED'),
    'average_order_value', coalesce(avg(o.total),0),
    'paid_orders', count(*) filter(where o.payment_status='PAID'),
    'cancelled_orders', count(*) filter(where o.status='CANCELLED'),
    'online_revenue', coalesce(sum(case when o.payment_status='PAID' and o.payment_method='PAY_NOW' then o.total else 0 end),0),
    'counter_revenue', coalesce(sum(case when o.payment_status='PAID' and coalesce(o.payment_method,'') not like 'PAY_NOW:%' then o.total else 0 end),0)
  ) into v_result
  from public.orders o
  where o.branch_id=p_branch_id and o.created_at>=p_from and o.created_at<p_to;
  return v_result;
end;
$$;
grant execute on function public.get_branch_analytics(uuid,timestamptz,timestamptz) to authenticated;

-- ---------- RLS ----------
alter table public.order_events enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.service_requests enable row level security;
alter table public.rate_limit_buckets enable row level security;

revoke all on public.order_events, public.payment_transactions, public.service_requests, public.rate_limit_buckets from anon;

drop policy if exists order_events_select_member on public.order_events;
create policy order_events_select_member on public.order_events for select using (public.is_branch_member(branch_id));

drop policy if exists payment_transactions_select_member on public.payment_transactions;
create policy payment_transactions_select_member on public.payment_transactions for select using (public.is_branch_member(branch_id));

drop policy if exists service_requests_select_member on public.service_requests;
create policy service_requests_select_member on public.service_requests for select using (public.is_branch_member(branch_id));
drop policy if exists service_requests_update_member on public.service_requests;
create policy service_requests_update_member on public.service_requests for update using (public.is_branch_member(branch_id)) with check (public.is_branch_member(branch_id));

revoke insert, update, delete on public.payment_transactions from authenticated;
revoke insert, update, delete on public.order_events from authenticated;
revoke insert, update, delete on public.service_requests from authenticated;

grant select on public.order_events, public.payment_transactions, public.service_requests to authenticated;

-- Orders should only be mutated via transition/payment RPCs, not arbitrary browser updates.
revoke update, delete on public.orders from authenticated;
grant select on public.orders to authenticated;

-- ---------- Realtime ----------
-- Postgres Changes for authenticated staff dashboards. Public customer status uses Broadcast.
alter table public.orders replica identity full;
alter table public.service_requests replica identity full;

do $$
begin
  begin alter publication supabase_realtime add table public.orders; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.service_requests; exception when duplicate_object then null; end;
end $$;

-- Customer-safe broadcast topic per opaque tracking token.
create or replace function public.broadcast_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = public, realtime
as $$
begin
  perform realtime.broadcast_changes(
    'tablely:order:' || coalesce(NEW.tracking_token, OLD.tracking_token),
    TG_OP,
    TG_OP,
    TG_TABLE_NAME,
    TG_TABLE_SCHEMA,
    NEW,
    OLD
  );
  return NEW;
end;
$$;

drop trigger if exists orders_broadcast_status on public.orders;
create trigger orders_broadcast_status
after insert or update of status, payment_status, paid_at on public.orders
for each row execute function public.broadcast_order_status_change();

-- Branch staff can receive postgres changes subject to table RLS.
-- Realtime customer public topic is intentionally capability-based via the opaque token.

-- ---------- Helpful cleanup ----------
create index if not exists orders_payment_status_idx on public.orders(branch_id,payment_status,created_at desc);
create index if not exists orders_status_idx on public.orders(branch_id,status,created_at desc);

select pg_notify('pgrst','reload schema');
