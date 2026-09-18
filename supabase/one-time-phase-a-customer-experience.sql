-- TABLELY Phase A customer migration bundle
-- Run this entire file once in Supabase SQL Editor.
-- Order: Pay-Later online settlement, customer receipts, reviews.
-- Prerequisites: migrations through 202609180019 must already be applied.
-- This bundle is transactional and reloads PostgREST only after success.

begin;

-- Customer-authorized online settlement for an authenticated Pay-Later owner.
-- The amount is snapshotted while the session is locked; clients never
-- submit an amount and existing manual settlement functions are untouched.

create table if not exists public.pay_later_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.table_sessions(id) on delete cascade,
  customer_profile_id uuid not null references public.customer_profiles(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  idempotency_key text not null,
  attempt_token text not null unique,
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','SUCCESS','FAILED','EXPIRED')),
  razorpay_order_id text unique,
  razorpay_payment_id text,
  failure_reason text,
  payment_expires_at timestamptz not null default (now() + interval '15 minutes'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists pay_later_payment_attempts_active_idempotency_uidx
  on public.pay_later_payment_attempts(session_id, idempotency_key)
  where status in ('PENDING','PROCESSING');
create index if not exists pay_later_payment_attempts_expiry_idx
  on public.pay_later_payment_attempts(payment_expires_at)
  where status in ('PENDING','PROCESSING');

alter table public.pay_later_payment_attempts enable row level security;
revoke all on public.pay_later_payment_attempts from anon, authenticated, public;

create or replace function public.create_pay_later_payment_attempt(
  p_session_id uuid,
  p_idempotency_key text
)
returns table(attempt_id uuid, attempt_token text, branch_id uuid, amount numeric, status text, razorpay_order_id text, payment_expires_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare
  v_profile uuid := public.build22_current_customer_profile();
  v_session public.table_sessions%rowtype;
  v_attempt public.pay_later_payment_attempts%rowtype;
  v_amount numeric;
  v_key text := nullif(left(trim(coalesce(p_idempotency_key, '')), 100), '');
begin
  if v_profile is null or v_key is null then
    raise exception 'Authenticated customer and idempotency key are required' using errcode = '42501';
  end if;
  select * into v_session from public.table_sessions
  where id = p_session_id and is_pay_later
    and owner_customer_id = v_profile and status in ('ACTIVE','SETTLING')
  for update;
  if v_session.id is null then raise exception 'Pay-Later session not found' using errcode = '42501'; end if;

  select * into v_attempt from public.pay_later_payment_attempts
  where session_id = p_session_id and idempotency_key = v_key
    and status in ('PENDING','PROCESSING')
  order by created_at desc limit 1 for update;
  if v_attempt.id is not null then
    return query select v_attempt.id, v_attempt.attempt_token, v_attempt.branch_id,
      v_attempt.amount, v_attempt.status, v_attempt.razorpay_order_id, v_attempt.payment_expires_at;
    return;
  end if;

  select coalesce(sum(o.total), 0) into v_amount from public.orders o
  where o.table_session_id = v_session.id and o.payment_status = 'PENDING'
    and o.status not in ('CANCELLED','REJECTED');
  if v_amount <= 0 then raise exception 'There is no outstanding balance' using errcode = 'P0001'; end if;

  insert into public.pay_later_payment_attempts(
    session_id, customer_profile_id, branch_id, idempotency_key, attempt_token, amount
  ) values (
    v_session.id, v_profile, v_session.branch_id, v_key,
    encode(gen_random_bytes(32), 'hex'), v_amount
  ) returning * into v_attempt;
  return query select v_attempt.id, v_attempt.attempt_token, v_attempt.branch_id,
    v_attempt.amount, v_attempt.status, v_attempt.razorpay_order_id, v_attempt.payment_expires_at;
end;
$$;

create or replace function public.set_pay_later_payment_attempt_razorpay_order(
  p_attempt_id uuid, p_attempt_token text, p_razorpay_order_id text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_profile uuid := public.build22_current_customer_profile(); v_updated integer;
begin
  update public.pay_later_payment_attempts
  set razorpay_order_id = nullif(trim(p_razorpay_order_id), ''), status = 'PROCESSING', updated_at = now()
  where id = p_attempt_id and attempt_token = p_attempt_token
    and customer_profile_id = v_profile and status in ('PENDING','PROCESSING')
    and payment_expires_at > now() and razorpay_order_id is null;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function public.finalize_pay_later_payment_attempt(
  p_attempt_id uuid, p_attempt_token text, p_razorpay_payment_id text,
  p_razorpay_order_id text, p_payment_method text default 'ONLINE'
)
returns table(session_id uuid, outstanding numeric, status text)
language plpgsql security definer set search_path = public
as $$
declare
  v_profile uuid := public.build22_current_customer_profile();
  v_attempt public.pay_later_payment_attempts%rowtype;
  v_session public.table_sessions%rowtype;
  v_order public.orders%rowtype;
  v_current_amount numeric;
  v_method text := upper(trim(coalesce(p_payment_method, 'ONLINE')));
begin
  select * into v_attempt from public.pay_later_payment_attempts
  where id = p_attempt_id and attempt_token = p_attempt_token
    and customer_profile_id = v_profile for update;
  if v_attempt.id is null then raise exception 'Payment session not found' using errcode = '42501'; end if;
  if v_attempt.status = 'SUCCESS' then
    return query select v_attempt.session_id,
      coalesce((select sum(total) from public.orders where table_session_id = v_attempt.session_id and payment_status = 'PENDING' and status not in ('CANCELLED','REJECTED')),0),
      (select status::text from public.table_sessions where id = v_attempt.session_id);
    return;
  end if;
  if v_attempt.status in ('FAILED','EXPIRED') then raise exception 'Payment session is no longer valid' using errcode = 'P0001'; end if;
  if v_attempt.payment_expires_at <= now() then
    update public.pay_later_payment_attempts set status='EXPIRED', completed_at=now(), updated_at=now() where id=v_attempt.id;
    raise exception 'Payment session expired' using errcode = 'P0001';
  end if;
  if v_attempt.razorpay_order_id is null or v_attempt.razorpay_order_id <> p_razorpay_order_id then
    raise exception 'Razorpay order mismatch' using errcode = 'P0001';
  end if;
  select * into v_session from public.table_sessions where id = v_attempt.session_id for update;
  if v_session.owner_customer_id <> v_profile or v_session.status not in ('ACTIVE','SETTLING') then
    raise exception 'Pay-Later session is no longer payable' using errcode = 'P0001';
  end if;
  select coalesce(sum(total), 0) into v_current_amount from public.orders
  where table_session_id = v_session.id and payment_status = 'PENDING'
    and status not in ('CANCELLED','REJECTED');
  if v_current_amount <> v_attempt.amount then
    raise exception 'Outstanding balance changed; start a new payment session' using errcode = 'P0001';
  end if;
  if v_method not in ('ONLINE','UPI','CARD') then v_method := 'ONLINE'; end if;

  for v_order in select * from public.orders
    where table_session_id = v_session.id and payment_status = 'PENDING'
      and status not in ('CANCELLED','REJECTED') for update
  loop
    update public.orders set payment_status='PAID', payment_method='PAY_NOW:'||v_method,
      paid_at=coalesce(paid_at,now()), status=case when status='SERVED' then 'COMPLETED' else status end, updated_at=now()
      where id=v_order.id;
    insert into public.payment_transactions(order_id, branch_id, provider, provider_order_id, provider_payment_id, amount, status, method, raw_metadata)
      values(v_order.id, v_order.branch_id, 'RAZORPAY', v_attempt.razorpay_order_id, p_razorpay_payment_id, v_order.total, 'PAID', v_method,
        jsonb_build_object('source','CUSTOMER_PAY_LATER_ONLINE','session_id',v_session.id,'attempt_id',v_attempt.id));
    insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
      values(v_order.id, v_order.branch_id, 'PAY_LATER_SETTLED', null, jsonb_build_object('method',v_method,'source','CUSTOMER_PAY_LATER_ONLINE','session_id',v_session.id));
  end loop;
  if not exists(select 1 from public.orders where table_session_id=v_session.id and status not in ('COMPLETED','CANCELLED','REJECTED')) then
    update public.table_sessions set status='CLOSED', closed_at=now(), updated_at=now() where id=v_session.id;
  end if;
  update public.pay_later_payment_attempts set status='SUCCESS', razorpay_payment_id=p_razorpay_payment_id, completed_at=now(), updated_at=now() where id=v_attempt.id;
  return query select v_session.id,
    coalesce((select sum(total) from public.orders where table_session_id=v_session.id and payment_status='PENDING' and status not in ('CANCELLED','REJECTED')),0),
    (select status::text from public.table_sessions where id=v_session.id);
end;
$$;

grant execute on function public.create_pay_later_payment_attempt(uuid,text) to authenticated;
grant execute on function public.set_pay_later_payment_attempt_razorpay_order(uuid,text,text) to authenticated;
grant execute on function public.finalize_pay_later_payment_attempt(uuid,text,text,text,text) to authenticated;
revoke execute on function public.create_pay_later_payment_attempt(uuid,text) from anon, public;
revoke execute on function public.set_pay_later_payment_attempt_razorpay_order(uuid,text,text) from anon, public;
revoke execute on function public.finalize_pay_later_payment_attempt(uuid,text,text,text,text) from anon, public;

-- Customer-authorized, read-only receipt projection. Totals come directly
-- from the order record so the receipt cannot recalculate or change billing.
create or replace function public.get_my_customer_receipt(p_order_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'restaurant_name', org.name,
    'branch_name', b.name,
    'branch_address', b.address,
    'branch_phone', b.phone,
    'created_at', o.created_at,
    'status', o.status,
    'payment_status', o.payment_status,
    'payment_method', o.payment_method,
    'subtotal', o.subtotal,
    'tax', o.tax,
    'additional_charges', o.additional_charges,
    'discount', o.discount,
    'coupon_code', o.coupon_code_snapshot,
    'total', o.total,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', oi.id,
        'item_name_snapshot', oi.item_name_snapshot,
        'quantity', oi.quantity,
        'unit_price', oi.unit_price,
        'line_total', oi.line_total,
        'selected_addons', oi.selected_addons,
        'selected_options', oi.selected_options,
        'special_instructions', oi.special_instructions
      ) order by oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  join public.branches b
    on b.id = o.branch_id
  join public.organizations org
    on org.id = b.organization_id
  join public.customer_profiles cp
    on cp.id = o.customer_profile_id
   and cp.auth_user_id = auth.uid()
  where o.id = p_order_id;
$$;

revoke execute on function public.get_my_customer_receipt(uuid) from anon, public;
grant execute on function public.get_my_customer_receipt(uuid) to authenticated;

create table if not exists public.restaurant_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  customer_profile_id uuid not null references public.customer_profiles(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists restaurant_reviews_branch_created_idx
  on public.restaurant_reviews(branch_id, created_at desc);

alter table public.restaurant_reviews enable row level security;
revoke all on public.restaurant_reviews from anon, public;
grant select on public.restaurant_reviews to authenticated;

drop policy if exists restaurant_reviews_select_branch_member on public.restaurant_reviews;
create policy restaurant_reviews_select_branch_member on public.restaurant_reviews
  for select to authenticated using (public.is_branch_member(branch_id));

create or replace function public.submit_customer_review(
  p_order_id uuid,
  p_rating integer,
  p_comment text default null
)
returns public.restaurant_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile uuid := public.build22_current_customer_profile();
  v_order public.orders%rowtype;
  v_review public.restaurant_reviews%rowtype;
begin
  if v_profile is null then
    raise exception 'Customer account required' using errcode = '42501';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Rating must be between 1 and 5' using errcode = '22023';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and customer_profile_id = v_profile
  for update;
  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if v_order.status::text not in ('SERVED', 'COMPLETED') or v_order.payment_status::text <> 'PAID' then
    raise exception 'Only served or completed paid orders can be reviewed' using errcode = '42501';
  end if;
  if exists (select 1 from public.restaurant_reviews where order_id = v_order.id) then
    raise exception 'This order has already been reviewed' using errcode = '23505';
  end if;

  insert into public.restaurant_reviews(order_id, branch_id, customer_profile_id, rating, comment)
  values (v_order.id, v_order.branch_id, v_profile, p_rating,
          nullif(left(trim(coalesce(p_comment, '')), 1000), ''))
  returning * into v_review;
  return v_review;
end;
$$;

revoke execute on function public.submit_customer_review(uuid, integer, text) from anon, public;
grant execute on function public.submit_customer_review(uuid, integer, text) to authenticated;

create or replace function public.get_my_customer_order_detail(p_order_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'order_id', o.id,
    'order_number', o.order_number,
    'restaurant_name', org.name,
    'branch_name', b.name,
    'created_at', o.created_at,
    'status', o.status,
    'payment_status', o.payment_status,
    'payment_method', o.payment_method,
    'total', o.total,
    'review', (select jsonb_build_object('id', r.id, 'rating', r.rating, 'comment', r.comment, 'created_at', r.created_at)
               from public.restaurant_reviews r where r.order_id = o.id),
    'items', coalesce((
      select jsonb_agg(to_jsonb(oi) order by oi.id)
      from public.order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  join public.branches b on b.id = o.branch_id
  join public.organizations org on org.id = b.organization_id
  join public.customer_profiles cp on cp.id = o.customer_profile_id and cp.auth_user_id = auth.uid()
  where o.id = p_order_id;
$$;

revoke execute on function public.get_my_customer_order_detail(uuid) from anon, public;
grant execute on function public.get_my_customer_order_detail(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';

select 'TABLELY Phase A customer migration bundle completed' as result;
