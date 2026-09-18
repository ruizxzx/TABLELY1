-- TABLELY — FIX RESTAURANT CUSTOMER RELATIONSHIP UPSERT
--
-- The relationship INSERT supplies total_orders and total_spend. It does not
-- have a column named total, so the conflict handler must use excluded.total_spend.

begin;

create or replace function public.build25_sync_customer_relationship()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if new.customer_profile_id is null then
    return new;
  end if;

  select organization_id
  into v_org
  from public.branches
  where id = new.branch_id;

  if v_org is null then
    return new;
  end if;

  insert into public.restaurant_customer_relationships(
    organization_id,
    customer_profile_id,
    total_orders,
    total_spend
  )
  values(
    v_org,
    new.customer_profile_id,
    1,
    coalesce(new.total, 0)
  )
  on conflict (organization_id, customer_profile_id) do update
  set last_order_at = now(),
      total_orders = public.restaurant_customer_relationships.total_orders + 1,
      total_spend = public.restaurant_customer_relationships.total_spend + excluded.total_spend;

  return new;
end;
$$;

alter function public.build25_sync_customer_relationship() set search_path = public;

commit;

notify pgrst, 'reload schema';
