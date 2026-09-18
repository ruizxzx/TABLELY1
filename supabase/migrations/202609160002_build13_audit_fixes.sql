-- TABLELY BUILD 13 — Audit fixes
--
-- Fixes three issues found during a full read-through of the Build 13
-- authorization migration and the migrations that preceded it:
--
--   1. CRITICAL: an insecure 2-argument overload of
--      request_order_cancellation(uuid, text) was correctly dropped in
--      202609141000, then unintentionally reintroduced (still granted to
--      anon, still with no ownership check) by a later migration
--      (202609142300). Both overloads have coexisted in the database ever
--      since. The secure 3-argument overload (uuid, text tracking_token,
--      text) is the one the app actually calls and is left untouched.
--
--   2. MEDIUM: get_branch_analytics() and get_build12_analytics() counted
--      revenue for any order with payment_status = 'PAID', regardless of
--      whether the order was later cancelled, while
--      get_build12_cross_branch_analytics() excluded cancelled orders from
--      revenue. This made branch-level and cross-branch revenue figures
--      inconsistent for the same underlying data. All three now use the
--      same definition: revenue = paid AND not cancelled.
--
--   3. MEDIUM: staff_permissions could only be read by an organization
--      owner (via can_manage_permissions()), so the app had no safe way to
--      let a Manager's own client know which of their permissions are on,
--      which meant the UI could not hide controls a Manager isn't allowed
--      to use (server/RPC checks still enforced this correctly, but the
--      UI layer was blind to it). This adds a narrow self-read allowance:
--      a staff member may read their own permission rows. It does not
--      change who can read or write anyone else's permissions.

begin;

-- ---------------------------------------------------------------------------
-- 1) Drop the reintroduced insecure cancellation overload (CRITICAL)
-- ---------------------------------------------------------------------------

revoke execute on function public.request_order_cancellation(uuid, text) from anon, authenticated, public;
drop function if exists public.request_order_cancellation(uuid, text);

-- ---------------------------------------------------------------------------
-- 2) Consistent revenue definition across analytics RPCs (MEDIUM)
-- ---------------------------------------------------------------------------

create or replace function public.get_branch_analytics(
  p_branch_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_result jsonb;
begin
  select b.organization_id into v_org
  from public.branches b
  where b.id = p_branch_id
    and b.is_active = true;

  if v_org is null or not public.is_branch_member(p_branch_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  if not public.organization_has_feature(v_org, 'ANALYTICS') then
    raise exception 'Analytics are not available on the current Tablely plan' using errcode = '42501';
  end if;

  if not public.current_user_has_permission_for_branch(p_branch_id, 'ANALYTICS') then
    raise exception 'You do not have analytics permission for this branch' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'revenue', coalesce(sum(case when o.payment_status = 'PAID' and o.status <> 'CANCELLED' then o.total else 0 end), 0),
    'orders', count(*),
    'completed_orders', count(*) filter (where o.status = 'COMPLETED'),
    'average_order_value', coalesce(avg(o.total) filter (where o.payment_status = 'PAID' and o.status <> 'CANCELLED'), 0),
    'paid_orders', count(*) filter (where o.payment_status = 'PAID'),
    'cancelled_orders', count(*) filter (where o.status = 'CANCELLED'),
    'online_revenue', coalesce(sum(case when o.payment_status = 'PAID' and o.status <> 'CANCELLED' and o.payment_method like 'PAY_NOW:%' then o.total else 0 end), 0),
    'counter_revenue', coalesce(sum(case when o.payment_status = 'PAID' and o.status <> 'CANCELLED' and coalesce(o.payment_method, '') not like 'PAY_NOW:%' then o.total else 0 end), 0)
  )
  into v_result
  from public.orders o
  where o.branch_id = p_branch_id
    and o.created_at >= p_from
    and o.created_at < p_to;

  return v_result;
end;
$$;

grant execute on function public.get_branch_analytics(uuid,timestamptz,timestamptz) to authenticated;
revoke execute on function public.get_branch_analytics(uuid,timestamptz,timestamptz) from anon, public;

create or replace function public.get_build12_analytics(p_branch_id uuid,p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_org uuid; v_result jsonb;
begin
  select organization_id into v_org from public.branches where id=p_branch_id and is_active;
  if v_org is null or not public.is_branch_member(p_branch_id) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if not public.organization_has_feature(v_org,'ADVANCED_ANALYTICS') then
    raise exception 'Advanced analytics are not available on the current Tablely plan' using errcode='42501';
  end if;
  if not public.current_user_has_permission_for_branch(p_branch_id, 'ANALYTICS') then
    raise exception 'You do not have analytics permission for this branch' using errcode='42501';
  end if;
  with scoped as (
    select o.* from public.orders o where o.branch_id=p_branch_id and o.created_at>=p_from and o.created_at<p_to
  ), item_rank as (
    select oi.item_name_snapshot name, sum(oi.quantity)::int quantity, sum(oi.line_total)::numeric revenue
    from public.order_items oi join scoped s on s.id=oi.order_id group by oi.item_name_snapshot order by revenue desc limit 10
  ), peak as (
    select extract(hour from created_at)::int as hour, count(*)::int as orders, coalesce(sum(total) filter(where payment_status='PAID' and status<>'CANCELLED'),0)::numeric as revenue
    from scoped group by 1 order by orders desc limit 8
  ), prep as (
    select avg(extract(epoch from (coalesce(rr.ready_at,c.completed_at)-r.created_at))/60.0) avg_minutes
    from (select order_id,min(created_at) created_at from public.order_events where branch_id=p_branch_id and event_type='STATUS' and to_status='ACCEPTED' group by order_id) r
    left join lateral(select min(oe.created_at) ready_at from public.order_events oe where oe.order_id=r.order_id and oe.to_status='READY') rr on true
    left join lateral(select min(oe.created_at) completed_at from public.order_events oe where oe.order_id=r.order_id and oe.to_status='COMPLETED') c on true
  ), service as (
    select avg(extract(epoch from (resolved_at-created_at))/60.0) avg_minutes
    from public.service_requests where branch_id=p_branch_id and created_at>=p_from and created_at<p_to and resolved_at is not null
  ), table_usage as (
    select count(distinct table_id)::int used_tables, (select count(*) from public.tables where branch_id=p_branch_id and active)::int total_tables from scoped
  )
  select jsonb_build_object(
    'peak_hours',coalesce((select jsonb_agg(to_jsonb(peak) order by orders desc) from peak),'[]'::jsonb),
    'top_products',coalesce((select jsonb_agg(to_jsonb(item_rank) order by revenue desc) from item_rank),'[]'::jsonb),
    'cancellation_rate',coalesce((select round(count(*) filter(where status='CANCELLED')::numeric/nullif(count(*),0)*100,2) from scoped),0),
    'average_preparation_minutes',coalesce((select round(avg_minutes::numeric,1) from prep),0),
    'average_service_response_minutes',coalesce((select round(avg_minutes::numeric,1) from service),0),
    'table_utilization_percent',coalesce((select round(used_tables::numeric/nullif(total_tables,0)*100,1) from table_usage),0),
    'used_tables',coalesce((select used_tables from table_usage),0),
    'total_tables',coalesce((select total_tables from table_usage),0),
    'revenue',coalesce((select sum(total) from scoped where payment_status='PAID' and status<>'CANCELLED'),0),
    'orders',coalesce((select count(*) from scoped),0)
  ) into v_result;
  return v_result;
end; $$;
grant execute on function public.get_build12_analytics(uuid,timestamptz,timestamptz) to authenticated;
revoke execute on function public.get_build12_analytics(uuid,timestamptz,timestamptz) from anon, public;

-- get_build12_cross_branch_analytics already excluded cancelled orders from
-- revenue/AOV; it is left as-is and is now consistent with the two
-- functions above.

-- ---------------------------------------------------------------------------
-- 3) Let staff read their own permission rows (for UI gating only) (MEDIUM)
-- ---------------------------------------------------------------------------

drop policy if exists staff_permissions_select on public.staff_permissions;
create policy staff_permissions_select on public.staff_permissions
for select to authenticated
using (
  public.can_manage_permissions(staff_permissions.staff_id)
  or exists (
    select 1
    from public.staff s
    where s.id = staff_permissions.staff_id
      and s.user_id = auth.uid()
      and s.active = true
  )
);

-- Write access is unchanged: only an authorized owner can modify permissions.
-- (staff_permissions_write policy from 202609160001 already enforces this.)

commit;

select pg_notify('pgrst','reload schema');
