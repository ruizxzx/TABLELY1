begin;

create or replace function public.process_restaurant_loyalty_expiry(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path=public
as $$
declare
  v_inserted integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'Expiry batch size must be between 1 and 5000';
  end if;

  with expired as (
    select
      earning.id,
      earning.organization_id,
      earning.branch_id,
      earning.customer_id,
      earning.order_id,
      earning.points,
      earning.amount,
      greatest(
        0,
        earning.points + coalesce((
          select sum(entry.points)
          from public.restaurant_loyalty_ledger entry
          where entry.reverses_entry_id=earning.id
        ), 0) + coalesce((
          select sum(entry.points)
          from public.restaurant_loyalty_ledger entry
          where entry.entry_type='REFUND_REVERSAL'
            and entry.order_id=earning.order_id
            and entry.customer_id=earning.customer_id
            and entry.reverses_entry_id is null
        ), 0)
      ) as outstanding_points
    from public.restaurant_loyalty_ledger earning
    where earning.entry_type='EARN'
      and earning.expires_at is not null
      and earning.expires_at <= now()
      and not exists (
        select 1
        from public.restaurant_loyalty_ledger expiry
        where expiry.organization_id=earning.organization_id
          and expiry.event_key='expiry:'||earning.id::text
      )
    order by earning.expires_at, earning.id
    limit p_limit
    for update of earning skip locked
  )
  insert into public.restaurant_loyalty_ledger(
    organization_id,branch_id,customer_id,order_id,event_key,entry_type,points,
    amount,reverses_entry_id
  )
  select
    expired.organization_id,expired.branch_id,expired.customer_id,expired.order_id,
    'expiry:'||expired.id::text,'EXPIRY',-expired.outstanding_points,
    -expired.amount*expired.outstanding_points/nullif(expired.points,0),expired.id
  from expired
  where expired.outstanding_points > 0
  on conflict(organization_id,event_key) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.process_restaurant_loyalty_expiry(integer) from public,anon,authenticated;
grant execute on function public.process_restaurant_loyalty_expiry(integer) to service_role;

commit;
