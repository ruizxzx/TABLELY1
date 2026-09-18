-- Route legacy Build 10 integration points through the central entitlement engine.

create or replace function public.get_public_payment_options(p_table_code text)
returns table(online_payment_enabled boolean, plan_id text)
language sql
security definer
set search_path = public
as $$
  select public.organization_has_feature(o.id, 'ONLINE_PAYMENTS'), os.plan_id
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  left join public.organization_subscriptions os on os.organization_id = o.id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;
$$;
grant execute on function public.get_public_payment_options(text) to anon, authenticated;

create or replace function public.enforce_online_payment_choice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_allowed boolean;
begin
  if new.payment_method = 'PAY_NOW' then
    select public.organization_has_feature(o.id, 'ONLINE_PAYMENTS')
    into v_allowed
    from public.branches b
    join public.organizations o on o.id = b.organization_id
    where b.id = new.branch_id;
    if not coalesce(v_allowed, false) then
      raise exception 'Online payment is not available on the current Tablely plan' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop policy if exists service_requests_select_member on public.service_requests;
create policy service_requests_select_member on public.service_requests
for select to authenticated
using (
  public.is_branch_member(branch_id)
  and public.organization_has_feature((select b.organization_id from public.branches b where b.id = service_requests.branch_id), 'SERVICE_REQUESTS')
);

drop policy if exists service_requests_update_member on public.service_requests;
create policy service_requests_update_member on public.service_requests
for update to authenticated
using (
  public.is_branch_member(branch_id)
  and public.organization_has_feature((select b.organization_id from public.branches b where b.id = service_requests.branch_id), 'SERVICE_REQUESTS')
)
with check (
  public.is_branch_member(branch_id)
  and public.organization_has_feature((select b.organization_id from public.branches b where b.id = service_requests.branch_id), 'SERVICE_REQUESTS')
);
