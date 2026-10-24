-- TABLELY Build 27 — run manually against a disposable/staging Supabase DB
-- AFTER applying 202610240001_build27_stability_foundation.sql.
-- These checks validate privileges and object presence only. They do not
-- replace authenticated tenant/branch RLS tests with real test users.

do $$
declare
  v_rls_enabled boolean;
begin
  select c.relrowsecurity into v_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'payment_transactions';

  if v_rls_enabled is distinct from true then
    raise exception 'payment_transactions RLS is not enabled';
  end if;

  if has_table_privilege('anon', 'public.payment_transactions', 'SELECT')
     or has_table_privilege('authenticated', 'public.payment_transactions', 'SELECT')
     or has_table_privilege('anon', 'public.payment_transactions', 'INSERT')
     or has_table_privilege('authenticated', 'public.payment_transactions', 'INSERT') then
    raise exception 'Browser roles still have direct payment_transactions access';
  end if;

  if not has_table_privilege('service_role', 'public.payment_transactions', 'INSERT') then
    raise exception 'service_role cannot insert payment_transactions';
  end if;

  if not has_function_privilege('authenticated', 'public.get_branch_dashboard_metrics(uuid)', 'EXECUTE') then
    raise exception 'authenticated cannot execute dashboard metrics RPC';
  end if;

  if has_function_privilege('anon', 'public.get_branch_dashboard_metrics(uuid)', 'EXECUTE') then
    raise exception 'anon can execute dashboard metrics RPC';
  end if;

  if not has_function_privilege('service_role', 'public.finalize_legacy_razorpay_order(uuid,text,text,text,bigint,text,text,jsonb)', 'EXECUTE') then
    raise exception 'service_role cannot execute legacy Razorpay finalizer';
  end if;

  if has_function_privilege('authenticated', 'public.finalize_legacy_razorpay_order(uuid,text,text,text,bigint,text,text,jsonb)', 'EXECUTE') then
    raise exception 'authenticated can execute server-only legacy Razorpay finalizer';
  end if;

  if to_regprocedure('public.claim_payment_attempt_razorpay_order(uuid,text)') is null
     or to_regprocedure('public.claim_legacy_razorpay_order(uuid,text)') is null then
    raise exception 'Razorpay order-creation claim RPC is missing';
  end if;
end;
$$;

-- Diagnostic inventory for manual review:
select n.nspname as schema_name,
       c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p')
order by c.relname;

select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

select p.oid::regprocedure as function_name,
       p.prosecdef as security_definer,
       p.proconfig as function_settings,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by p.proname;

-- Migration ledger reconciliation query. The repository now keeps one local
-- file at version 202609180031 and replays both historical changes under unique
-- later versions. Confirm the target ledger's applied state before deployment:
select version, count(*) as applied_rows
from supabase_migrations.schema_migrations
where version = '202609180031'
group by version;
