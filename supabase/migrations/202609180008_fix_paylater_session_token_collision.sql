-- TABLELY — FIX PAY-LATER SESSION TOKEN COLLISION
--
-- Anonymous visit/device tokens identify guest sessions and are globally
-- unique while open. A customer-owned Pay-Later tab must not claim an
-- existing guest token, because that can raise
-- table_sessions_open_visit_token_uidx on first checkout.

begin;

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
    raise exception 'Customer authentication is required' using errcode = '42501';
  end if;

  select t.*
  into v_table
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  where t.table_code = trim(p_table_code)
    and t.active
    and o.status = 'ACTIVE'::public.account_status;

  if v_table.id is null then
    raise exception 'This table QR is invalid or inactive';
  end if;

  if not public.build23_effective_pay_later_enabled(v_table.branch_id) then
    raise exception 'Pay After Delivery is not enabled for this branch' using errcode = '42501';
  end if;

  select *
  into v_session
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

  -- Do not copy p_session_token or p_device_token here. Those identify an
  -- anonymous browser visit and may already be attached to another open
  -- session. Ownership is established by auth.uid() through v_profile.
  insert into public.table_sessions(
    branch_id,
    table_id,
    status,
    origin,
    owner_customer_id,
    is_pay_later,
    last_seen_at
  )
  values(
    v_table.branch_id,
    v_table.id,
    'ACTIVE',
    'CUSTOMER_SCAN',
    v_profile,
    true,
    now()
  )
  returning * into v_session;

  return v_session;
end;
$$;

revoke execute on function public.open_pay_later_session(text, text, text) from anon, public;
grant execute on function public.open_pay_later_session(text, text, text) to authenticated;
alter function public.open_pay_later_session(text, text, text) set search_path = public;

commit;

notify pgrst, 'reload schema';
