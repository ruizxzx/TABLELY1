-- TABLELY BUILD 21 — THREE ORDERING METHODS FRAMEWORK
--
-- PAY_LATER is configuration groundwork only. It is deliberately not exposed
-- as an operational checkout method and cannot create an order in Build 21.

begin;

alter table public.restaurant_payment_settings
  add column if not exists pay_at_counter_enabled boolean not null default true,
  add column if not exists pay_later_enabled boolean not null default false;

alter table public.restaurant_branch_payment_settings
  add column if not exists pay_at_counter_enabled boolean not null default true,
  add column if not exists pay_later_enabled boolean not null default false;

create or replace function public.build21_effective_counter_enabled(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select rbps.pay_at_counter_enabled
      from public.restaurant_branch_payment_settings rbps
      where rbps.branch_id = p_branch_id
    ),
    (
      select rps.pay_at_counter_enabled
      from public.restaurant_payment_settings rps
      join public.branches b on b.organization_id = rps.organization_id
      where b.id = p_branch_id
    ),
    true
  );
$$;
revoke execute on function public.build21_effective_counter_enabled(uuid) from anon, authenticated, public;

create or replace function public.build21_assert_counter_enabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_method = 'PAY_LATER' then
    raise exception 'PAY_LATER_NOT_YET_AVAILABLE' using errcode = 'P0001';
  end if;
  if new.payment_method = 'PAY_AT_COUNTER'
     and not public.build21_effective_counter_enabled(new.branch_id) then
    raise exception 'Pay at counter is not enabled for this branch' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.build21_assert_counter_enabled() from anon, authenticated, public;

drop trigger if exists orders_enforce_counter_method on public.orders;
create trigger orders_enforce_counter_method
before insert on public.orders
for each row
execute function public.build21_assert_counter_enabled();

-- Versioned public contract: the existing get_public_payment_options() return
-- shape remains unchanged for older consumers.
create or replace function public.get_public_ordering_options(p_table_code text)
returns table(
  pay_at_counter_enabled boolean,
  pay_later_enabled boolean,
  online_payment_enabled boolean,
  pay_later_available boolean,
  plan_id text
)
language sql
security definer
stable
set search_path = public
as $$
  select
    coalesce(rbps.pay_at_counter_enabled, rps.pay_at_counter_enabled, true),
    coalesce(rbps.pay_later_enabled, rps.pay_later_enabled, false),
    (
      public.organization_has_feature(o.id, 'ONLINE_PAYMENTS')
      and coalesce(rbps.enabled, rps.enabled, false)
    ),
    false,
    os.plan_id
  from public.tables t
  join public.branches b on b.id = t.branch_id
  join public.organizations o on o.id = b.organization_id
  left join public.organization_subscriptions os on os.organization_id = o.id
  left join public.restaurant_branch_payment_settings rbps on rbps.branch_id = b.id
  left join public.restaurant_payment_settings rps on rps.organization_id = o.id
  where t.table_code = trim(p_table_code)
    and t.active = true
    and o.status = 'ACTIVE'::public.account_status
  limit 1;
$$;
revoke execute on function public.get_public_ordering_options(text) from public;
grant execute on function public.get_public_ordering_options(text) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
