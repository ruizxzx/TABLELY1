-- TABLELY BUILD 27 — idempotent replay of the historical cross-organization checkout charge fix.
-- The original migration version collided with another historical migration.
-- Keep the original version file for migration-ledger compatibility and replay
-- this idempotent function patch under a unique version so either possible
-- historical ledger state receives the intended fix.
--
-- Root cause:
-- The charge-selection predicate in older checkout functions compared branch_id
-- but did not constrain charge rows to the organization owning the target branch.
-- An organization-level charge from another restaurant could therefore match a
-- branch that had no branch-specific override.
--
-- Fix:
-- Every checkout charge query is now explicitly scoped to the organization that
-- owns the target branch/session, while preserving the existing inheritance rule:
-- branch-specific enabled charges override organization defaults for that branch.

DO $$
DECLARE
  v_fn record;
  v_sql text;
  v_old text;
  v_new text;
  v_patched boolean;
BEGIN
  FOR v_fn IN
    SELECT n.nspname AS schema_name,
           p.proname,
           p.oid,
           pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'preview_public_checkout_v18',
        'create_order_for_table_v18',
        'create_payment_attempt_for_table_v18',
        'create_order_for_table',
        'create_payment_attempt_for_table',
        'create_pay_later_order_for_table'
      )
  LOOP
    v_sql := v_fn.definition;
    v_patched := false;

    v_old := '(c.branch_id=v_table.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_table.branch_id)))';
    v_new := '(c.organization_id=(select organization_id from public.branches where id=v_table.branch_id) and (c.branch_id=v_table.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_table.branch_id))))';
    IF position(v_old IN v_sql) > 0 THEN
      v_sql := replace(v_sql, v_old, v_new);
      v_patched := true;
    END IF;

    v_old := '(c.branch_id=v_session.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_session.branch_id)))';
    v_new := '(c.organization_id=(select organization_id from public.branches where id=v_session.branch_id) and (c.branch_id=v_session.branch_id or (c.branch_id is null and not exists(select 1 from public.restaurant_charge_settings cb where cb.organization_id=c.organization_id and cb.branch_id=v_session.branch_id))))';
    IF position(v_old IN v_sql) > 0 THEN
      v_sql := replace(v_sql, v_old, v_new);
      v_patched := true;
    END IF;

    IF v_patched THEN
      EXECUTE v_sql;
    END IF;
  END LOOP;
END $$;
