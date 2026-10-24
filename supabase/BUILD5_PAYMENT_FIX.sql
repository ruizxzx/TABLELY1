-- TABLELY Build 5-8 payment repair for an existing project
-- Safe/additive: no DROP ... CASCADE.

create extension if not exists pgcrypto with schema extensions;

-- Make an older/pre-existing payment_transactions table compatible with Build 7.
alter table public.payment_transactions add column if not exists branch_id uuid;
alter table public.payment_transactions add column if not exists provider text not null default 'MANUAL';
alter table public.payment_transactions add column if not exists provider_order_id text;
alter table public.payment_transactions add column if not exists provider_payment_id text;
alter table public.payment_transactions add column if not exists amount numeric(12,2);
alter table public.payment_transactions add column if not exists currency text not null default 'INR';
alter table public.payment_transactions add column if not exists status text not null default 'PENDING';
alter table public.payment_transactions add column if not exists method text;
alter table public.payment_transactions add column if not exists failure_reason text;
alter table public.payment_transactions add column if not exists raw_metadata jsonb not null default '{}'::jsonb;
alter table public.payment_transactions add column if not exists created_at timestamptz not null default now();
alter table public.payment_transactions add column if not exists updated_at timestamptz not null default now();

-- The RPC previously used an unqualified `id` in UPDATE/return contexts.
-- Output-column names in RETURNS TABLE become PL/pgSQL variables, so qualify table columns.
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
  if v_user is null then
    raise exception 'Not authenticated' using errcode='42501';
  end if;

  select ord.* into v_order
  from public.orders as ord
  where ord.id = p_order_id
  for update;

  if v_order.id is null then
    raise exception 'Order not found';
  end if;

  select st.* into v_staff
  from public.staff as st
  where st.user_id = v_user
    and st.branch_id = v_order.branch_id
  order by case when st.role='OWNER' then 0 when st.role='MANAGER' then 1 else 2 end
  limit 1;

  if v_staff.id is null or v_staff.role not in ('OWNER','MANAGER','WAITER') then
    raise exception 'You are not authorized to mark payments';
  end if;

  if v_order.payment_status = 'PAID' then
    return query
      select ord.id, ord.payment_status, ord.payment_method, ord.paid_at
      from public.orders as ord
      where ord.id = p_order_id;
    return;
  end if;

  if v_method not in ('CASH','UPI','CARD') then
    raise exception 'Unsupported manual payment method';
  end if;

  update public.orders as ord
  set payment_status = 'PAID',
      payment_method = v_method,
      paid_at = coalesce(ord.paid_at, now()),
      updated_at = now()
  where ord.id = p_order_id;

  insert into public.payment_transactions
    (order_id, branch_id, provider, amount, status, method, raw_metadata)
  values
    (v_order.id, v_order.branch_id, 'MANUAL', v_order.total, 'PAID', v_method,
     jsonb_build_object(
       'reference', nullif(left(trim(coalesce(p_reference,'')),120),''),
       'actor_user_id', v_user::text
     ));

  insert into public.order_events
    (order_id, branch_id, event_type, actor_user_id, metadata)
  values
    (v_order.id, v_order.branch_id, 'PAYMENT_MARKED_PAID', v_user,
     jsonb_build_object('method', v_method));

  return query
    select ord.id, ord.payment_status, ord.payment_method, ord.paid_at
    from public.orders as ord
    where ord.id = p_order_id;
end;
$$;

grant execute on function public.mark_order_paid(uuid,text,text) to authenticated;

select pg_notify('pgrst','reload schema');
