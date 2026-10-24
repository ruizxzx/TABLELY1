-- TABLELY Build 29 foundation: auditable split allocations and reconciliation notes.
-- The existing orders/payment_transactions tables remain the financial source of truth.
begin;

create table if not exists public.order_split_bills (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  split_method text not null check (split_method in ('EQUAL','CUSTOM')),
  currency text not null default 'INR' check (currency = 'INR'),
  expected_amount_paise bigint not null check (expected_amount_paise > 0),
  status text not null default 'OPEN' check (status in ('OPEN','SETTLED','CANCELLED')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_split_participants (
  id uuid primary key default gen_random_uuid(),
  split_bill_id uuid not null references public.order_split_bills(id) on delete cascade,
  participant_key text not null,
  display_name text not null check (length(display_name) between 1 and 80),
  allocated_amount_paise bigint not null check (allocated_amount_paise > 0),
  paid_amount_paise bigint not null default 0 check (paid_amount_paise >= 0 and paid_amount_paise <= allocated_amount_paise),
  status text not null default 'PENDING' check (status in ('PENDING','PARTIAL','PAID','CANCELLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (split_bill_id, participant_key)
);

create index if not exists order_split_participants_bill_idx
  on public.order_split_participants(split_bill_id, created_at);

create table if not exists public.payment_reconciliation_notes (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  payment_transaction_id uuid references public.payment_transactions(id) on delete set null,
  action text not null check (action in ('NOTE','REVIEWED','ESCALATED')),
  note text not null check (length(note) between 1 and 2000),
  actor_user_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (order_id is not null or payment_transaction_id is not null)
);

create index if not exists payment_reconciliation_notes_branch_created_idx
  on public.payment_reconciliation_notes(branch_id, created_at desc);
create unique index if not exists payment_transactions_split_idempotency_uidx
  on public.payment_transactions ((raw_metadata->>'idempotency_key'))
  where provider='MANUAL_SPLIT' and raw_metadata ? 'idempotency_key';

alter table public.order_split_bills enable row level security;
alter table public.order_split_participants enable row level security;
alter table public.payment_reconciliation_notes enable row level security;
revoke all on public.order_split_bills, public.order_split_participants, public.payment_reconciliation_notes from anon, authenticated, public;

create or replace function public.configure_order_split(
  p_order_id uuid,
  p_method text,
  p_participants jsonb
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_order public.orders%rowtype;
  v_split public.order_split_bills%rowtype;
  v_method text := upper(trim(coalesce(p_method,'')));
  v_total bigint;
  v_sum bigint;
  v_count integer;
  v_user uuid := auth.uid();
  v_item jsonb;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  if v_method not in ('EQUAL','CUSTOM') or jsonb_typeof(p_participants) <> 'array' then raise exception 'Invalid split request'; end if;
  if jsonb_array_length(p_participants) < 2 or jsonb_array_length(p_participants) > 20 then raise exception 'A split needs 2 to 20 participants'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if v_order.id is null then raise exception 'Order not found' using errcode='P0002'; end if;
  if not public.current_user_has_permission_for_branch(v_order.branch_id,'BILLING') then raise exception 'Billing permission required' using errcode='42501'; end if;
  if v_order.payment_status <> 'PENDING' then raise exception 'Only unpaid orders can be split'; end if;
  v_total := round(v_order.total * 100)::bigint;
  select count(*),coalesce(sum((x->>'amount_paise')::bigint),0)
    into v_count,v_sum from jsonb_array_elements(p_participants) x;
  if exists(select 1 from jsonb_array_elements(p_participants) x
      where coalesce(length(trim(x->>'key')),0) not between 1 and 80
         or coalesce(length(trim(x->>'name')),0) not between 1 and 80
         or coalesce((x->>'amount_paise')::bigint,0) <= 0) then
    raise exception 'Participant names, keys and amounts must be valid';
  end if;
  if v_sum <> v_total then raise exception 'Split allocations must equal the current order total in paise'; end if;
  if v_method='EQUAL' and exists(
      select 1 from (
        select (x->>'amount_paise')::bigint amount_paise,
          row_number() over(order by ordinal) participant_number
        from jsonb_array_elements(p_participants) with ordinality as p(x,ordinal)
      ) allocations
      where amount_paise <> v_total / v_count + case when participant_number <= mod(v_total,v_count) then 1 else 0 end
    ) then
    raise exception 'Equal split amounts do not match the order total';
  end if;

  select * into v_split from public.order_split_bills where order_id=p_order_id for update;
  if v_split.id is not null and exists(select 1 from public.order_split_participants where split_bill_id=v_split.id and paid_amount_paise>0) then
    raise exception 'A split with collected payments cannot be reconfigured';
  end if;
  if v_split.id is null then
    insert into public.order_split_bills(order_id,branch_id,split_method,expected_amount_paise,created_by)
    values(p_order_id,v_order.branch_id,v_method,v_total,v_user) returning * into v_split;
  else
    update public.order_split_bills set split_method=v_method,expected_amount_paise=v_total,status='OPEN',updated_at=now()
    where id=v_split.id returning * into v_split;
    delete from public.order_split_participants where split_bill_id=v_split.id;
  end if;
  for v_item in select * from jsonb_array_elements(p_participants) loop
    insert into public.order_split_participants(split_bill_id,participant_key,display_name,allocated_amount_paise)
    values(v_split.id,trim(v_item->>'key'),trim(v_item->>'name'),(v_item->>'amount_paise')::bigint);
  end loop;
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  values(p_order_id,v_order.branch_id,'SPLIT_BILL_CONFIGURED',v_user,jsonb_build_object('split_bill_id',v_split.id,'method',v_method,'participants',v_count,'amount_paise',v_total));
  return jsonb_build_object('id',v_split.id,'order_id',p_order_id,'method',v_method,'expected_amount_paise',v_total,'participants',
    (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'key',p.participant_key,'name',p.display_name,'allocated_amount_paise',p.allocated_amount_paise,'paid_amount_paise',p.paid_amount_paise,'status',p.status) order by p.created_at), '[]'::jsonb) from public.order_split_participants p where p.split_bill_id=v_split.id));
end;
$$;

create or replace function public.collect_split_counter_payment(
  p_participant_id uuid,
  p_amount_paise bigint,
  p_method text,
  p_idempotency_key text
) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_part public.order_split_participants%rowtype;
  v_split public.order_split_bills%rowtype;
  v_order public.orders%rowtype;
  v_method text := upper(trim(coalesce(p_method,'')));
  v_new_paid bigint;
  v_transaction_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  if p_amount_paise <= 0 or nullif(trim(p_idempotency_key),'') is null then raise exception 'Invalid amount or idempotency key'; end if;
  if v_method not in ('CASH','UPI','CARD') then raise exception 'Unsupported counter payment method'; end if;
  select p.* into v_part from public.order_split_participants p where p.id=p_participant_id for update;
  if v_part.id is null then raise exception 'Split participant not found'; end if;
  select * into v_split from public.order_split_bills where id=v_part.split_bill_id for update;
  select * into v_order from public.orders where id=v_split.order_id for update;
  if not public.current_user_has_permission_for_branch(v_order.branch_id,'PAYMENTS') then raise exception 'Payments permission required' using errcode='42501'; end if;
  if v_split.status <> 'OPEN' or v_order.payment_status <> 'PENDING' then raise exception 'Split bill is no longer open'; end if;
  if exists(select 1 from public.payment_transactions where raw_metadata->>'idempotency_key'=p_idempotency_key) then
    return jsonb_build_object('ok',true,'duplicate',true,'paid_amount_paise',v_part.paid_amount_paise);
  end if;
  v_new_paid := v_part.paid_amount_paise + p_amount_paise;
  if v_new_paid > v_part.allocated_amount_paise then raise exception 'Payment exceeds this participant allocation'; end if;
  insert into public.payment_transactions(order_id,branch_id,provider,amount,currency,status,method,raw_metadata)
  values(v_order.id,v_order.branch_id,'MANUAL_SPLIT',p_amount_paise::numeric/100,'INR','PAID',v_method,
    jsonb_build_object('split_bill_id',v_split.id,'participant_id',v_part.id,'idempotency_key',p_idempotency_key,'actor_user_id',auth.uid()))
  on conflict ((raw_metadata->>'idempotency_key')) where provider='MANUAL_SPLIT' and raw_metadata ? 'idempotency_key' do nothing
  returning id into v_transaction_id;
  if v_transaction_id is null then
    return jsonb_build_object('ok',true,'duplicate',true,'paid_amount_paise',v_part.paid_amount_paise);
  end if;
  update public.order_split_participants set paid_amount_paise=v_new_paid,
    status=case when v_new_paid=allocated_amount_paise then 'PAID' else 'PARTIAL' end,updated_at=now()
    where id=v_part.id returning * into v_part;
  if not exists(select 1 from public.order_split_participants where split_bill_id=v_split.id and status<>'PAID') then
    update public.orders set payment_status='PAID',payment_method='SPLIT',paid_at=coalesce(paid_at,now()),updated_at=now() where id=v_order.id and payment_status='PENDING';
    update public.order_split_bills set status='SETTLED',updated_at=now() where id=v_split.id;
  end if;
  insert into public.order_events(order_id,branch_id,event_type,actor_user_id,metadata)
  values(v_order.id,v_order.branch_id,'SPLIT_PAYMENT_COLLECTED',auth.uid(),jsonb_build_object('participant_id',v_part.id,'amount_paise',p_amount_paise,'method',v_method));
  return jsonb_build_object('ok',true,'paid_amount_paise',v_part.paid_amount_paise,'allocated_amount_paise',v_part.allocated_amount_paise,
    'outstanding_amount_paise',v_part.allocated_amount_paise-v_part.paid_amount_paise,
    'order_outstanding_paise',(select coalesce(sum(allocated_amount_paise-paid_amount_paise),0) from public.order_split_participants where split_bill_id=v_split.id));
end;
$$;

create or replace function public.add_payment_reconciliation_note(
  p_order_id uuid,
  p_transaction_id uuid,
  p_action text,
  p_note text
) returns uuid
language plpgsql security definer set search_path=public as $$
declare v_branch uuid; v_id uuid; v_action text:=upper(trim(coalesce(p_action,'')));
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  if v_action not in ('NOTE','REVIEWED','ESCALATED') or length(trim(coalesce(p_note,''))) not between 1 and 2000 then raise exception 'Invalid reconciliation note'; end if;
  if p_order_id is not null then select branch_id into v_branch from public.orders where id=p_order_id; end if;
  if p_transaction_id is not null then
    if v_branch is null then select branch_id into v_branch from public.payment_transactions where id=p_transaction_id;
    elsif not exists(select 1 from public.payment_transactions where id=p_transaction_id and branch_id=v_branch and (p_order_id is null or order_id=p_order_id)) then raise exception 'Transaction does not match order'; end if;
  end if;
  if v_branch is null or not public.current_user_has_permission_for_branch(v_branch,'PAYMENTS') then raise exception 'Payments permission required' using errcode='42501'; end if;
  insert into public.payment_reconciliation_notes(branch_id,order_id,payment_transaction_id,action,note,actor_user_id)
  values(v_branch,p_order_id,p_transaction_id,v_action,trim(p_note),auth.uid()) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.get_payment_reconciliation_dashboard(
  p_branch_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_search text default null,
  p_method text default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
) returns jsonb
language plpgsql security definer stable set search_path=public as $$
declare v_result jsonb; v_search text:=nullif(trim(coalesce(p_search,'')),'');
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  if not public.current_user_has_permission_for_branch(p_branch_id,'PAYMENTS') then raise exception 'Payments permission required' using errcode='42501'; end if;
  if p_limit < 1 or p_limit > 100 or p_offset < 0 then raise exception 'Invalid pagination'; end if;
  with filtered_orders as (
    select o.* from public.orders o where o.branch_id=p_branch_id
      and (p_from is null or o.created_at>=p_from) and (p_to is null or o.created_at<p_to)
  ), ledger as (
    select t.id transaction_id,t.order_id,o.order_number,o.customer_name,o.customer_phone,o.total expected_total,
      t.amount actual_amount,t.currency,t.provider,t.provider_order_id,t.provider_payment_id,t.method,
      t.status transaction_status,o.payment_status order_payment_status,o.status order_status,
      t.created_at transaction_date,o.created_at order_date,o.paid_at,o.razorpay_payment_id,
      (t.provider_payment_id is not null and count(*) over(partition by t.provider_payment_id)>1) duplicate_reference,
      case
        when upper(t.status) in ('CAPTURED','SUCCEEDED','SUCCESS','PAID') and o.payment_status::text<>'PAID' then 'GATEWAY_CAPTURED_ORDER_UNPAID'
        when o.payment_status::text='PAID' and upper(t.status) in ('FAILED','CANCELLED') then 'ORDER_PAID_TRANSACTION_FAILED'
        when upper(t.status) in ('CAPTURED','SUCCEEDED','SUCCESS','PAID') and abs(t.amount-o.total)>0.009 then 'AMOUNT_MISMATCH'
        when t.provider_payment_id is null and upper(t.status) in ('CAPTURED','SUCCEEDED','SUCCESS','PAID') then 'MISSING_PAYMENT_REFERENCE'
        when t.currency<>'INR' then 'CURRENCY_MISMATCH'
        when t.provider_payment_id is not null and count(*) over(partition by t.provider_payment_id)>1 then 'DUPLICATE_REFERENCE'
        else null end issue
    from public.payment_transactions t join filtered_orders o on o.id=t.order_id
    union all
    select null::uuid,o.id,o.order_number,o.customer_name,o.customer_phone,o.total,null::numeric,'INR',
      coalesce(o.payment_method,'UNKNOWN'),null::text,o.razorpay_payment_id,o.payment_method,
      case when o.payment_status::text='PAID' then 'UNRECORDED' else o.payment_status::text end,
      o.payment_status::text,o.status::text,o.created_at,o.created_at,o.paid_at,o.razorpay_payment_id,false,
      case when o.payment_status::text='PAID' and (o.razorpay_payment_id is null or not exists(select 1 from public.payment_transactions t where t.order_id=o.id)) then 'PAID_WITHOUT_TRANSACTION' else null end
    from filtered_orders o where not exists(select 1 from public.payment_transactions t where t.order_id=o.id)
  ), filtered_ledger as (
    select l.* from ledger l where (p_method is null or upper(coalesce(l.method,''))=upper(p_method))
      and (p_status is null or upper(coalesce(l.transaction_status,l.order_payment_status,''))=upper(p_status))
      and (v_search is null or l.order_number::text ilike '%'||v_search||'%'
        or coalesce(l.customer_name,'') ilike '%'||v_search||'%'
        or coalesce(l.customer_phone,'') ilike '%'||v_search||'%'
        or coalesce(l.provider_payment_id,'') ilike '%'||v_search||'%'
        or coalesce(l.provider_order_id,'') ilike '%'||v_search||'%'
        or l.order_id::text ilike '%'||v_search||'%')
  ), page as (
    select * from filtered_ledger order by transaction_date desc,order_id desc offset p_offset limit p_limit
  ), summary as (
    select
      coalesce(sum(total) filter(where payment_status::text='PAID'),0) gross_collected,
      coalesce(sum(total) filter(where payment_status::text='REFUNDED'),0) refunds,
      coalesce(sum(total) filter(where payment_status::text in ('PENDING','PARTIALLY_PAID')),0) outstanding,
      count(*) filter(where payment_status::text='PENDING') pending_orders,
      count(*) filter(where payment_status::text='FAILED') failed_orders,
      count(*) filter(where payment_status::text='PARTIALLY_PAID') partial_orders,
      coalesce(sum(total) filter(where payment_status::text='PAID' and (payment_method='CASH')),0) cash_collected,
      coalesce(sum(total) filter(where payment_status::text='PAID' and (payment_method='UPI')),0) counter_upi_collected,
      coalesce(sum(total) filter(where payment_status::text='PAID' and (payment_method='PAY_NOW' or payment_method like 'PAY_NOW:%')),0) online_collected,
      count(*) total_orders
    from filtered_orders
  )
  select jsonb_build_object(
    'summary',(select to_jsonb(s) from summary s),
    'total_rows',(select count(*) from filtered_ledger),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by transaction_date desc) from page),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.get_my_customer_history_page(
  p_query text default null,
  p_limit integer default 20,
  p_offset integer default 0
) returns jsonb
language plpgsql security definer stable set search_path=public as $$
declare v_result jsonb; v_query text:=nullif(trim(coalesce(p_query,'')),'');
begin
  if auth.uid() is null then raise exception 'Not authenticated' using errcode='42501'; end if;
  if p_limit<1 or p_limit>50 or p_offset<0 then raise exception 'Invalid pagination'; end if;
  with customer_orders as (
    select o.id order_id,o.order_number,org.name restaurant_name,b.name branch_name,o.created_at,o.total,
      o.status::text order_status,o.payment_status::text payment_status,
      (select count(*) from public.order_items oi where oi.order_id=o.id) item_count,
      cp.auth_user_id
    from public.orders o join public.branches b on b.id=o.branch_id
    join public.organizations org on org.id=b.organization_id
    join public.customer_profiles cp on cp.id=o.customer_profile_id
    where cp.auth_user_id=auth.uid()
      and (v_query is null or o.order_number::text ilike '%'||v_query||'%' or org.name ilike '%'||v_query||'%' or b.name ilike '%'||v_query||'%')
  ), page as (
    select order_id,order_number,restaurant_name,branch_name,created_at,total,order_status,payment_status,item_count
    from customer_orders order by created_at desc offset p_offset limit p_limit
  )
  select jsonb_build_object('total_rows',(select count(*) from customer_orders),
    'rows',coalesce((select jsonb_agg(to_jsonb(page) order by created_at desc) from page),'[]'::jsonb)) into v_result;
  return v_result;
end;
$$;

create or replace function public.get_my_customer_receipt_v29(p_order_id uuid)
returns jsonb
language sql security definer stable set search_path=public as $$
  select jsonb_build_object(
    'order_id',o.id,'order_number',o.order_number,
    'receipt_number',concat('TLY-',to_char(o.created_at at time zone coalesce(b.timezone,'Asia/Kolkata'),'YYYYMMDD'),'-',left(replace(b.id::text,'-',''),4),'-',lpad(o.order_number::text,5,'0')),
    'restaurant_name',org.name,'restaurant_logo',coalesce(b.brand_logo_url,org.brand_logo_url),
    'branch_name',b.name,'branch_address',b.address,'branch_phone',b.phone,
    'created_at',o.created_at,'paid_at',o.paid_at,'status',o.status,'payment_status',o.payment_status,
    'payment_method',o.payment_method,'subtotal',o.subtotal,'tax',o.tax,'additional_charges',o.additional_charges,
    'discount',o.discount,'coupon_code',o.coupon_code_snapshot,'total',o.total,
    'collected_amount',case when o.payment_status='PAID'::public.payment_status then o.total else coalesce((
      select sum(t.amount) from public.payment_transactions t where t.order_id=o.id and upper(t.status) in ('PAID','CAPTURED','SUCCEEDED','SUCCESS')
    ),0) end,
    'refund_amount',coalesce((select sum(t.amount) from public.payment_transactions t where t.order_id=o.id and upper(t.status)='REFUNDED'),0),
    'outstanding_amount',greatest(o.total-case when o.payment_status='PAID'::public.payment_status then o.total else coalesce((
      select sum(t.amount) from public.payment_transactions t where t.order_id=o.id and upper(t.status) in ('PAID','CAPTURED','SUCCEEDED','SUCCESS')
    ),0) end,0),
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',oi.id,'item_name_snapshot',oi.item_name_snapshot,'quantity',oi.quantity,
      'unit_price',oi.unit_price,'line_total',oi.line_total,'selected_addons',oi.selected_addons,'selected_options',oi.selected_options,
      'special_instructions',oi.special_instructions) order by oi.id) from public.order_items oi where oi.order_id=o.id),'[]'::jsonb),
    'transactions',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'provider',t.provider,'provider_payment_id',t.provider_payment_id,
      'amount',t.amount,'currency',t.currency,'status',t.status,'method',t.method,'created_at',t.created_at) order by t.created_at)
      from public.payment_transactions t where t.order_id=o.id),'[]'::jsonb)
  )
  from public.orders o join public.branches b on b.id=o.branch_id join public.organizations org on org.id=b.organization_id
  join public.customer_profiles cp on cp.id=o.customer_profile_id and cp.auth_user_id=auth.uid()
  where o.id=p_order_id;
$$;

revoke all on function public.configure_order_split(uuid,text,jsonb) from public,anon;
revoke all on function public.collect_split_counter_payment(uuid,bigint,text,text) from public,anon;
revoke all on function public.add_payment_reconciliation_note(uuid,uuid,text,text) from public,anon;
revoke all on function public.get_payment_reconciliation_dashboard(uuid,timestamptz,timestamptz,text,text,text,integer,integer) from public,anon;
revoke all on function public.get_my_customer_history_page(text,integer,integer) from public,anon;
revoke all on function public.get_my_customer_receipt_v29(uuid) from public,anon;
grant execute on function public.configure_order_split(uuid,text,jsonb) to authenticated;
grant execute on function public.collect_split_counter_payment(uuid,bigint,text,text) to authenticated;
grant execute on function public.add_payment_reconciliation_note(uuid,uuid,text,text) to authenticated;
grant execute on function public.get_payment_reconciliation_dashboard(uuid,timestamptz,timestamptz,text,text,text,integer,integer) to authenticated;
grant execute on function public.get_my_customer_history_page(text,integer,integer) to authenticated;
grant execute on function public.get_my_customer_receipt_v29(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
