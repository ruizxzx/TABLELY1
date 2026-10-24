-- Run on a disposable/staging Supabase database after applying the Build 27 migration.
-- Requires at least one active branch whose organization owner has an active OWNER
-- staff row. This performs read-only checks and rolls back all session-local state.
begin;

do $$
declare
  v_branch_id uuid;
  v_owner_id uuid;
  v_metrics jsonb;
  v_gross numeric;
  v_refunds numeric;
  v_net numeric;
  v_outstanding numeric;
begin
  select b.id, o.owner_id
    into v_branch_id, v_owner_id
  from public.branches b
  join public.organizations o on o.id = b.organization_id
  join public.staff s on s.organization_id = o.id
   and s.user_id = o.owner_id
   and s.active = true
   and s.role = 'OWNER'::public.staff_role
  where b.is_active = true
  order by b.created_at
  limit 1;

  if v_branch_id is null or v_owner_id is null then
    raise exception 'Build 27 smoke test requires an active branch and active owner staff record';
  end if;

  perform set_config('request.jwt.claim.sub', v_owner_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_owner_id::text, 'role', 'authenticated')::text, true);

  v_metrics := public.get_branch_dashboard_metrics(v_branch_id);
  if jsonb_typeof(v_metrics) <> 'object' then
    raise exception 'Dashboard metrics RPC did not return a JSON object';
  end if;

  if not (v_metrics ?& array[
    'business_date', 'timezone', 'gross_collected', 'refunds', 'net_collected',
    'outstanding', 'total_orders', 'paid_orders', 'unpaid_orders',
    'active_orders', 'cancelled_orders', 'rejected_orders'
  ]) then
    raise exception 'Dashboard metrics RPC is missing required keys: %', v_metrics;
  end if;

  v_gross := (v_metrics->>'gross_collected')::numeric;
  v_refunds := (v_metrics->>'refunds')::numeric;
  v_net := (v_metrics->>'net_collected')::numeric;
  v_outstanding := (v_metrics->>'outstanding')::numeric;

  if v_gross < 0 or v_refunds < 0 or v_outstanding < 0 then
    raise exception 'Dashboard metrics contains a negative financial total: %', v_metrics;
  end if;
  if abs(v_net - (v_gross - v_refunds)) > 0.01 then
    raise exception 'Net collected does not reconcile to gross less refunds: %', v_metrics;
  end if;

  raise notice 'Build 27 dashboard metrics smoke test passed for branch %: %', v_branch_id, v_metrics;
end;
$$;

rollback;
