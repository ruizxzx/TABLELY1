-- TABLELY BUILD 27 — stability and technical foundation.
-- Additive/data-preserving only. This migration is NOT applied to any remote database
-- by this development task; reconcile the pre-existing 202609180031 filename collision
-- with the live Supabase migration ledger before running `supabase db push`.

begin;

-- Payment transaction rows contain provider identifiers and financial metadata.
-- Application code does not read this table directly; it uses authorized SECURITY
-- DEFINER functions and server-role APIs. Block direct browser-role access.
alter table public.payment_transactions enable row level security;
revoke all on table public.payment_transactions from public, anon, authenticated;
grant all on table public.payment_transactions to service_role;

-- Return an all-orders, branch-local business-day financial summary. The prior
-- dashboard's 50-order preview is kept for display only; financial totals are
-- calculated here from the complete scoped order/payment ledger.
create or replace function public.get_branch_dashboard_metrics(p_branch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_organization_id uuid;
  v_timezone text;
  v_business_date date;
  v_result jsonb;
begin
  if auth.uid() is null or p_branch_id is null then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  select b.organization_id, coalesce(nullif(trim(b.timezone), ''), 'Asia/Kolkata')
    into v_organization_id, v_timezone
  from public.branches b
  where b.id = p_branch_id and b.is_active = true;

  if v_organization_id is null then
    raise exception 'Branch not found' using errcode = 'P0002';
  end if;

  -- Reuse TABLELY's established per-branch permission model instead of
  -- hard-coding OWNER/MANAGER roles. Owners retain the existing bypass;
  -- other staff need the configured ANALYTICS permission for this branch.
  if not public.current_user_has_permission_for_branch(p_branch_id, 'ANALYTICS') then
    raise exception 'Not authorized for this branch' using errcode = '42501';
  end if;

  if not exists (select 1 from pg_timezone_names where name = v_timezone) then
    v_timezone := 'Asia/Kolkata';
  end if;
  v_business_date := (now() at time zone v_timezone)::date;

  with scoped_orders as (
    select
      o.id,
      o.total::numeric(12,2) as total,
      o.status::text as order_status,
      o.payment_status::text as payment_status
    from public.orders o
    where o.branch_id = p_branch_id
      and coalesce(o.order_business_date, (o.created_at at time zone v_timezone)::date) = v_business_date
  ), transaction_totals as (
    select
      pt.order_id,
      count(*)::bigint as transaction_count,
      coalesce(sum(abs(pt.amount)) filter (
        where upper(pt.status) in ('PAID', 'CAPTURED', 'SUCCESS')
          and upper(coalesce(pt.currency, 'INR')) = 'INR'
      ), 0)::numeric(12,2) as gross_amount,
      coalesce(sum(abs(pt.amount)) filter (
        where upper(pt.status) in ('REFUNDED', 'REFUND', 'REVERSED')
          and upper(coalesce(pt.currency, 'INR')) = 'INR'
      ), 0)::numeric(12,2) as refund_amount
    from public.payment_transactions pt
    join scoped_orders so on so.id = pt.order_id
    where pt.branch_id = p_branch_id
    group by pt.order_id
  ), per_order as (
    select
      so.*,
      case
        when coalesce(tt.gross_amount, 0) > 0 then tt.gross_amount
        when coalesce(tt.refund_amount, 0) > 0 then tt.refund_amount
        -- Historical orders may have only a FAILED transaction row (for example,
        -- a failed online attempt followed by an older counter settlement). The
        -- authoritative order state still records the completed collection.
        -- Do not require transaction_count = 0 for this compatibility fallback.
        when so.payment_status in ('PAID', 'REFUNDED') then so.total
        else 0::numeric
      end as gross_collected,
      case
        when coalesce(tt.refund_amount, 0) > 0 then tt.refund_amount
        when so.payment_status = 'REFUNDED' then so.total
        else 0::numeric
      end as refunded,
      case
        when so.order_status not in ('CANCELLED', 'REJECTED')
          and so.payment_status not in ('PAID', 'REFUNDED')
        then greatest(so.total - coalesce(tt.gross_amount, 0), 0::numeric)
        else 0::numeric
      end as outstanding_amount
    from scoped_orders so
    left join transaction_totals tt on tt.order_id = so.id
  )
  select jsonb_build_object(
    'business_date', v_business_date,
    'timezone', v_timezone,
    'gross_collected', coalesce(sum(gross_collected), 0),
    'refunds', coalesce(sum(refunded), 0),
    'net_collected', coalesce(sum(gross_collected - refunded), 0),
    'outstanding', coalesce(sum(outstanding_amount), 0),
    'total_orders', count(*),
    'paid_orders', count(*) filter (where payment_status = 'PAID'),
    'unpaid_orders', count(*) filter (
      where payment_status not in ('PAID', 'REFUNDED')
        and order_status not in ('CANCELLED', 'REJECTED')
    ),
    'active_orders', count(*) filter (where order_status in ('NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED')),
    'cancelled_orders', count(*) filter (where order_status = 'CANCELLED'),
    'rejected_orders', count(*) filter (where order_status = 'REJECTED')
  )
  into v_result
  from per_order;

  return v_result;
end;
$$;

revoke all on function public.get_branch_dashboard_metrics(uuid) from public, anon;
grant execute on function public.get_branch_dashboard_metrics(uuid) to authenticated;

-- Atomically record and settle legacy PAY_NOW orders. The current payment-attempt
-- path continues to use finalize_payment_attempt_v18; this RPC only protects the
-- compatibility path that already has an order row before payment verification.
create or replace function public.finalize_legacy_razorpay_order(
  p_order_id uuid,
  p_tracking_token text,
  p_razorpay_order_id text,
  p_razorpay_payment_id text,
  p_amount_in_paise bigint,
  p_currency text,
  p_method text,
  p_metadata jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.orders%rowtype;
  v_expected_amount_in_paise bigint;
  v_method text;
  v_rows integer;
begin
  if p_order_id is null
     or nullif(trim(coalesce(p_razorpay_order_id, '')), '') is null
     or nullif(trim(coalesce(p_razorpay_payment_id, '')), '') is null then
    raise exception 'Invalid payment reference' using errcode = '22023';
  end if;

  select o.* into v_order
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;

  if p_tracking_token is not null and v_order.tracking_token is distinct from p_tracking_token then
    raise exception 'Order tracking token mismatch' using errcode = '42501';
  end if;

  if v_order.razorpay_order_id is distinct from p_razorpay_order_id then
    raise exception 'Razorpay order mismatch' using errcode = '22023';
  end if;

  if upper(trim(coalesce(p_currency, ''))) <> 'INR' then
    raise exception 'Unsupported payment currency' using errcode = '22023';
  end if;

  v_expected_amount_in_paise := round(v_order.total * 100)::bigint;
  if p_amount_in_paise is null or p_amount_in_paise <> v_expected_amount_in_paise then
    raise exception 'Payment amount mismatch' using errcode = '22023';
  end if;

  if not (v_order.payment_method = 'PAY_NOW' or left(coalesce(v_order.payment_method, ''), 8) = 'PAY_NOW:') then
    raise exception 'Order is not configured for online payment' using errcode = 'P0001';
  end if;

  v_method := coalesce(nullif(left(upper(trim(coalesce(p_method, ''))), 32), ''), 'ONLINE');

  if v_order.payment_status::text = 'PAID' then
    if v_order.razorpay_payment_id is distinct from p_razorpay_payment_id then
      raise exception 'Order is already settled by a different payment' using errcode = 'P0001';
    end if;
  else
    if v_order.status::text in ('CANCELLED', 'REJECTED', 'COMPLETED') then
      raise exception 'Order cannot be settled in its current state' using errcode = 'P0001';
    end if;
    if v_order.payment_status::text <> 'PENDING' then
      raise exception 'Order is not awaiting online payment' using errcode = 'P0001';
    end if;
  end if;

  insert into public.payment_transactions (
    order_id, branch_id, provider, provider_order_id, provider_payment_id,
    amount, currency, status, method, raw_metadata
  ) values (
    v_order.id, v_order.branch_id, 'RAZORPAY', p_razorpay_order_id, p_razorpay_payment_id,
    v_order.total, 'INR', 'CAPTURED', v_method, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (provider_order_id) where provider_order_id is not null
  do update set
    provider_payment_id = excluded.provider_payment_id,
    amount = excluded.amount,
    currency = excluded.currency,
    status = 'CAPTURED',
    method = excluded.method,
    raw_metadata = excluded.raw_metadata,
    updated_at = now()
  where payment_transactions.order_id = excluded.order_id
    and payment_transactions.branch_id = excluded.branch_id
    and (payment_transactions.status not in ('PAID', 'CAPTURED')
         or payment_transactions.provider_payment_id = excluded.provider_payment_id);

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Payment reference is already associated with another settlement' using errcode = '23505';
  end if;

  if v_order.payment_status::text <> 'PAID' then
    update public.orders
    set payment_status = 'PAID',
        payment_method = concat('PAY_NOW:', v_method),
        razorpay_payment_id = p_razorpay_payment_id,
        paid_at = coalesce(paid_at, now()),
        updated_at = now()
    where id = v_order.id;
  end if;

  return true;
end;
$$;

revoke all on function public.finalize_legacy_razorpay_order(uuid,text,text,text,bigint,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.finalize_legacy_razorpay_order(uuid,text,text,text,bigint,text,text,jsonb) to service_role;


-- Serialize concurrent Razorpay order creation for a single payment attempt.
-- This closes the gap where two duplicate API requests could both create a
-- provider order before either had persisted its ID locally.
alter table public.payment_attempts
  add column if not exists razorpay_order_creation_started_at timestamptz,
  add column if not exists razorpay_order_creation_token uuid;

create or replace function public.claim_payment_attempt_razorpay_order(
  p_payment_attempt_id uuid,
  p_attempt_token text
)
returns table(claimed boolean, existing_razorpay_order_id text, creation_in_progress boolean, creation_token uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attempt public.payment_attempts%rowtype;
  v_claim_token uuid;
begin
  select * into v_attempt
  from public.payment_attempts
  where id = p_payment_attempt_id and attempt_token = p_attempt_token
  for update;

  if v_attempt.id is null then
    raise exception 'Payment attempt not found' using errcode = 'P0002';
  end if;
  if v_attempt.status in ('FAILED', 'EXPIRED', 'SUCCESS') then
    raise exception 'Payment attempt is no longer active' using errcode = 'P0001';
  end if;
  if v_attempt.payment_expires_at <= now() then
    update public.payment_attempts
      set status = 'EXPIRED', failure_reason = 'Payment session expired',
          completed_at = now(), updated_at = now()
    where id = v_attempt.id;
    raise exception 'Payment session expired. Please place a new order.' using errcode = 'P0001';
  end if;

  if v_attempt.razorpay_order_id is not null then
    return query select false, v_attempt.razorpay_order_id, false, null::uuid;
    return;
  end if;

  if v_attempt.razorpay_order_creation_started_at is not null
     and v_attempt.razorpay_order_creation_started_at > now() - interval '90 seconds' then
    return query select false, null::text, true, null::uuid;
    return;
  end if;

  v_claim_token := gen_random_uuid();
  update public.payment_attempts
    set razorpay_order_creation_started_at = now(), razorpay_order_creation_token = v_claim_token,
        status = 'PROCESSING', updated_at = now()
  where id = v_attempt.id;

  return query select true, null::text, false, v_claim_token;
end;
$$;

create or replace function public.set_payment_attempt_razorpay_order(
  p_payment_attempt_id uuid,
  p_attempt_token text,
  p_razorpay_order_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attempt public.payment_attempts%rowtype;
begin
  select * into v_attempt
  from public.payment_attempts
  where id = p_payment_attempt_id and attempt_token = p_attempt_token
  for update;
  if v_attempt.id is null then raise exception 'Payment attempt not found' using errcode = 'P0002'; end if;
  if v_attempt.status in ('FAILED', 'EXPIRED', 'SUCCESS') then return false; end if;
  if v_attempt.payment_expires_at <= now() then return false; end if;
  if v_attempt.razorpay_order_id is not null then
    return v_attempt.razorpay_order_id = p_razorpay_order_id;
  end if;
  if p_claim_token is null or v_attempt.razorpay_order_creation_token is distinct from p_claim_token then
    return false;
  end if;
  update public.payment_attempts
    set razorpay_order_id = p_razorpay_order_id,
        razorpay_order_creation_started_at = null,
        razorpay_order_creation_token = null,
        status = 'PROCESSING',
        updated_at = now()
  where id = v_attempt.id and razorpay_order_id is null
    and razorpay_order_creation_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.release_payment_attempt_razorpay_order_claim(
  p_payment_attempt_id uuid,
  p_attempt_token text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.payment_attempts
  set razorpay_order_creation_started_at = null, razorpay_order_creation_token = null, updated_at = now()
  where id = p_payment_attempt_id
    and attempt_token = p_attempt_token
    and razorpay_order_id is null
    and razorpay_order_creation_token = p_claim_token
    and status in ('PENDING', 'PROCESSING');
  return found;
end;
$$;

revoke all on function public.claim_payment_attempt_razorpay_order(uuid,text) from public, anon, authenticated;
revoke all on function public.set_payment_attempt_razorpay_order(uuid,text,text,uuid) from public, anon, authenticated;
revoke all on function public.release_payment_attempt_razorpay_order_claim(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.claim_payment_attempt_razorpay_order(uuid,text) to service_role;
grant execute on function public.set_payment_attempt_razorpay_order(uuid,text,text,uuid) to service_role;
grant execute on function public.release_payment_attempt_razorpay_order_claim(uuid,text,uuid) to service_role;

-- The legacy order-first compatibility route also needs a creation lease.
-- New payment-first checkouts use payment_attempts above; these helpers only
-- protect orders created by the older PAY_NOW flow.
alter table public.orders
  add column if not exists razorpay_order_creation_started_at timestamptz,
  add column if not exists razorpay_order_creation_token uuid;

create or replace function public.claim_legacy_razorpay_order(
  p_order_id uuid,
  p_tracking_token text
)
returns table(claimed boolean, existing_razorpay_order_id text, creation_in_progress boolean, creation_token uuid)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.orders%rowtype;
  v_claim_token uuid;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and tracking_token = p_tracking_token
  for update;

  if v_order.id is null then
    raise exception 'Order not found' using errcode = 'P0002';
  end if;
  if not (v_order.payment_method = 'PAY_NOW' or left(coalesce(v_order.payment_method, ''), 8) = 'PAY_NOW:') then
    raise exception 'Order is not configured for online payment' using errcode = 'P0001';
  end if;
  if v_order.payment_status::text <> 'PENDING'
     or v_order.status::text in ('CANCELLED', 'REJECTED', 'COMPLETED') then
    raise exception 'Order is not awaiting online payment' using errcode = 'P0001';
  end if;

  if v_order.razorpay_order_id is not null then
    return query select false, v_order.razorpay_order_id, false, null::uuid;
    return;
  end if;

  if v_order.razorpay_order_creation_started_at is not null
     and v_order.razorpay_order_creation_started_at > now() - interval '90 seconds' then
    return query select false, null::text, true, null::uuid;
    return;
  end if;

  v_claim_token := gen_random_uuid();
  update public.orders
  set razorpay_order_creation_started_at = now(), razorpay_order_creation_token = v_claim_token, updated_at = now()
  where id = v_order.id;
  return query select true, null::text, false, v_claim_token;
end;
$$;

create or replace function public.set_legacy_razorpay_order(
  p_order_id uuid,
  p_tracking_token text,
  p_razorpay_order_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if nullif(trim(coalesce(p_razorpay_order_id, '')), '') is null then return false; end if;
  update public.orders
  set razorpay_order_id = p_razorpay_order_id,
      razorpay_order_creation_started_at = null,
      razorpay_order_creation_token = null,
      updated_at = now()
  where id = p_order_id
    and tracking_token = p_tracking_token
    and payment_status::text = 'PENDING'
    and status::text not in ('CANCELLED', 'REJECTED', 'COMPLETED')
    and razorpay_order_id is null
    and razorpay_order_creation_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.release_legacy_razorpay_order_claim(
  p_order_id uuid,
  p_tracking_token text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.orders
  set razorpay_order_creation_started_at = null, razorpay_order_creation_token = null, updated_at = now()
  where id = p_order_id
    and tracking_token = p_tracking_token
    and razorpay_order_id is null
    and razorpay_order_creation_token = p_claim_token
    and payment_status::text = 'PENDING'
    and status::text not in ('CANCELLED', 'REJECTED', 'COMPLETED');
  return found;
end;
$$;

revoke all on function public.claim_legacy_razorpay_order(uuid,text) from public, anon, authenticated;
revoke all on function public.set_legacy_razorpay_order(uuid,text,text,uuid) from public, anon, authenticated;
revoke all on function public.release_legacy_razorpay_order_claim(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.claim_legacy_razorpay_order(uuid,text) to service_role;
grant execute on function public.set_legacy_razorpay_order(uuid,text,text,uuid) to service_role;
grant execute on function public.release_legacy_razorpay_order_claim(uuid,text,uuid) to service_role;

notify pgrst, 'reload schema';
commit;
