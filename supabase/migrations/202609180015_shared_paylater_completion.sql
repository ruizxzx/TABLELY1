begin;

-- A member who scans the same table must resume the existing shared session,
-- not create a second owner session. Membership is resolved server-side.
create or replace function public.open_pay_later_session(
  p_table_code text,
  p_session_token text default null,
  p_device_token text default null
)
returns public.table_sessions
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_table public.tables%rowtype;
  v_profile uuid := public.build22_current_customer_profile();
  v_session public.table_sessions%rowtype;
begin
  if v_profile is null then
    raise exception 'Customer account login/signup is required for Pay After Delivery' using errcode = '42501';
  end if;

  select t.* into v_table
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active
    and o.status = 'ACTIVE'::public.account_status;
  if v_table.id is null then raise exception 'This table QR is invalid or inactive'; end if;
  if not public.build23_effective_pay_later_enabled(v_table.branch_id) then
    raise exception 'Pay After Delivery is not enabled for this branch' using errcode = '42501';
  end if;

  -- Shared membership takes precedence over creating/resuming an owner tab.
  select s.* into v_session
  from public.table_sessions s
  join public.table_session_members m on m.session_id = s.id
  where s.table_id = v_table.id
    and s.is_pay_later
    and s.status in ('ACTIVE', 'SETTLING')
    and m.customer_profile_id = v_profile
  order by s.opened_at desc
  limit 1
  for update;
  if v_session.id is not null then
    update public.table_sessions
    set last_seen_at = now(), updated_at = now()
    where id = v_session.id
    returning * into v_session;
    return v_session;
  end if;

  select * into v_session
  from public.table_sessions
  where table_id = v_table.id
    and owner_customer_id = v_profile
    and is_pay_later
    and status in ('ACTIVE', 'SETTLING')
  order by opened_at desc
  limit 1
  for update;
  if v_session.id is not null then
    update public.table_sessions
    set last_seen_at = now(), updated_at = now()
    where id = v_session.id
    returning * into v_session;
    return v_session;
  end if;

  insert into public.table_sessions(
    branch_id, table_id, status, origin, owner_customer_id, is_pay_later, last_seen_at
  )
  values(v_table.branch_id, v_table.id, 'ACTIVE', 'CUSTOMER_SCAN', v_profile, true, now())
  returning * into v_session;
  return v_session;
end;
$$;

-- Customer-visible active-tab detail. It returns only sessions for which the
-- authenticated profile is owner/member and derives all totals from orders.
create or replace function public.get_my_pay_later_session_detail(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_profile uuid := public.build22_current_customer_profile();
  v_session public.table_sessions%rowtype;
  v_result jsonb;
begin
  if v_profile is null then
    raise exception 'Customer authentication is required' using errcode = '42501';
  end if;

  select s.* into v_session
  from public.table_sessions s
  where s.id = p_session_id
    and s.is_pay_later
    and s.status in ('ACTIVE', 'SETTLING')
    and (
      s.owner_customer_id = v_profile
      or exists (
        select 1 from public.table_session_members m
        where m.session_id = s.id and m.customer_profile_id = v_profile
      )
    )
  ;
  if v_session.id is null then
    raise exception 'Pay-Later session not found' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'session_id', s.id,
    'status', s.status,
    'opened_at', s.opened_at,
    'restaurant_name', org.name,
    'branch_name', b.name,
    'table_number', t.table_number,
    'role', case when s.owner_customer_id = v_profile then 'OWNER' else 'MEMBER' end,
    'outstanding', coalesce((
      select sum(o.total) from public.orders o
      where o.table_session_id = s.id
        and o.payment_status = 'PENDING'
        and o.status not in ('CANCELLED', 'REJECTED')
    ), 0),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'order_id', o.id,
        'order_number', o.order_number,
        'total', o.total,
        'status', o.status,
        'payment_status', o.payment_status,
        'created_at', o.created_at,
        'customer_name', coalesce(cp.name, 'Customer')
      ) order by o.created_at desc)
      from public.orders o
      left join public.customer_profiles cp on cp.id = o.customer_profile_id
      where o.table_session_id = s.id
    ), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'customer_profile_id', cp.id,
        'name', coalesce(cp.name, 'Customer'),
        'role', m.role,
        'joined_at', m.joined_at
      ) order by m.joined_at)
      from public.table_session_members m
      join public.customer_profiles cp on cp.id = m.customer_profile_id
      where m.session_id = s.id
    ), '[]'::jsonb)
  ) into v_result
  from public.table_sessions s
  join public.tables t on t.id = s.table_id
  join public.branches b on b.id = s.branch_id
  join public.organizations org on org.id = b.organization_id
  where s.id = v_session.id;
  return v_result;
end;
$$;

drop function if exists public.get_my_active_pay_later_sessions();
create function public.get_my_active_pay_later_sessions()
returns table(session_id uuid, table_id uuid, table_number integer, restaurant_name text, outstanding numeric, status text, role text)
language sql
security definer
stable
set search_path = public
as $$
  select s.id, s.table_id, t.table_number, o.name,
    coalesce((
      select sum(ord.total) from public.orders ord
      where ord.table_session_id = s.id
        and ord.payment_status = 'PENDING'
        and ord.status not in ('CANCELLED', 'REJECTED')
    ), 0),
    s.status,
    case when s.owner_customer_id = public.build22_current_customer_profile() then 'OWNER' else 'MEMBER' end
  from public.table_sessions s
  join public.tables t on t.id = s.table_id
  join public.branches b on b.id = s.branch_id
  join public.organizations o on o.id = b.organization_id
  where s.is_pay_later
    and s.status in ('ACTIVE', 'SETTLING')
    and (
      s.owner_customer_id = public.build22_current_customer_profile()
      or exists (
        select 1 from public.table_session_members m
        where m.session_id = s.id
          and m.customer_profile_id = public.build22_current_customer_profile()
      )
    )
  order by s.opened_at desc;
$$;

-- Fix settlement billing semantics: rejected orders are never billable, and
-- the returned balance is the post-settlement balance.
create or replace function public.settle_pay_later_session(p_session_id uuid, p_method text)
returns table(session_id uuid, outstanding numeric, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile uuid := public.build22_current_customer_profile();
  v_session public.table_sessions%rowtype;
  v_order public.orders%rowtype;
  v_method text := upper(trim(coalesce(p_method, '')));
begin
  if v_profile is null or v_method not in ('CASH', 'UPI') then
    raise exception 'Authenticated customer and CASH or UPI are required' using errcode = '42501';
  end if;
  select * into v_session
  from public.table_sessions
  where id = p_session_id
    and is_pay_later
    and owner_customer_id = v_profile
    and status in ('ACTIVE', 'SETTLING')
  for update;
  if v_session.id is null then raise exception 'Pay-Later session not found'; end if;

  for v_order in
    select * from public.orders
    where table_session_id = v_session.id
      and payment_status = 'PENDING'
      and status not in ('CANCELLED', 'REJECTED')
    for update
  loop
    update public.orders
    set payment_status = 'PAID',
        payment_method = v_method,
        paid_at = coalesce(paid_at, now()),
        status = case when status = 'SERVED'::public.order_status then 'COMPLETED'::public.order_status else status end,
        updated_at = now()
    where id = v_order.id;
    insert into public.payment_transactions(order_id, branch_id, provider, amount, status, method, raw_metadata)
    values(v_order.id, v_order.branch_id, 'MANUAL', v_order.total, 'PAID', v_method,
      jsonb_build_object('source', 'PAY_LATER_SETTLEMENT', 'session_id', v_session.id));
    insert into public.order_events(order_id, branch_id, event_type, actor_user_id, metadata)
    values(v_order.id, v_order.branch_id, 'PAY_LATER_SETTLED', auth.uid(),
      jsonb_build_object('method', v_method, 'session_id', v_session.id));
  end loop;

  if not exists(
    select 1 from public.orders
    where table_session_id = v_session.id
      and status not in ('COMPLETED', 'CANCELLED', 'REJECTED')
  ) then
    update public.table_sessions
    set status = 'CLOSED', closed_at = now(), updated_at = now()
    where id = v_session.id;
  end if;

  return query
  select v_session.id,
    coalesce((
      select sum(o.total) from public.orders o
      where o.table_session_id = v_session.id
        and o.payment_status = 'PENDING'
        and o.status not in ('CANCELLED', 'REJECTED')
    ), 0),
    (select s.status from public.table_sessions s where s.id = v_session.id);
end;
$$;

revoke execute on function public.get_my_pay_later_session_detail(uuid) from anon, public;
grant execute on function public.get_my_pay_later_session_detail(uuid) to authenticated;
revoke execute on function public.open_pay_later_session(text, text, text) from anon, public;
grant execute on function public.open_pay_later_session(text, text, text) to authenticated;
revoke execute on function public.get_my_active_pay_later_sessions() from anon, public;
grant execute on function public.get_my_active_pay_later_sessions() to authenticated;
revoke execute on function public.settle_pay_later_session(uuid, text) from anon, public;
grant execute on function public.settle_pay_later_session(uuid, text) to authenticated;

commit;
notify pgrst, 'reload schema';
