import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Orders groups session work by session ID and links orders to authorized session details', async () => {
  const page = await read('app/orders/page.tsx');
  const panel = await read('components/orders/SessionManagementPanel.tsx');

  assert.match(page, /SessionManagementPanel/);
  assert.match(page, /onClick=\{\(\)=>setRequestedSessionId\(o\.table_session_id\)\}/);
  assert.match(page, /table_sessions/);
  assert.match(panel, /\.in\('status', \['ACTIVE', 'SETTLING'\]\)/);
  assert.match(panel, /get_table_session_management/);
  assert.match(panel, /Ready to close/);
  assert.match(panel, /In progress/);
  assert.match(panel, /Session details/);
  assert.match(panel, /Payment history/);
});

test('session roster exposes compact live status, duration, financials, and closure blockers', async () => {
  const panel = await read('components/orders/SessionManagementPanel.tsx');
  const styles = await read('components/orders/SessionManagementPanel.module.css');

  assert.match(panel, /data-status=\{liveStatus\}/);
  assert.match(panel, /setLiveStatus\(nextStatus\)/);
  assert.match(panel, /Open \{formatElapsed\(session\.opened_at\)\} ago/);
  assert.match(panel, /<b>Orders<\/b>\{session\.order_count\}/);
  assert.match(panel, /<b>Collected<\/b>\{amount\(session\.collected\)\}/);
  assert.match(panel, /<b>Outstanding<\/b>\{amount\(session\.outstanding\)\}/);
  assert.match(panel, /session\.reasons\.join\(' '\)/);
  assert.match(panel, /<b>Active<\/b>\{activeOrderCount\}/);
  assert.match(styles, /grid-template-areas:[\s\S]*"head metrics actions"[\s\S]*"blocker blocker actions"/);
  assert.match(styles, /@media \(max-width: 850px\)/);
});

test('session management displays PostgREST error messages instead of hiding them behind fallbacks', async () => {
  const panel = await read('components/orders/SessionManagementPanel.tsx');

  assert.match(panel, /typeof error === 'object' && error !== null/);
  assert.match(panel, /'message' in error && typeof error\.message === 'string'/);
  assert.match(panel, /getErrorMessage\(caught, 'Could not load session management\.'\)/);
  assert.match(panel, /!details && actionError/);
  assert.match(panel, /error\.code === 'PGRST202'/);
  assert.match(panel, /Apply migration 20261024100000_build317_orders_session_management\.sql/);
  assert.match(panel, /\{error \? null : loading \?/);
});

test('session close readiness is server-derived, branch-authorized, and checks all blockers', async () => {
  const sql = await read('supabase/migrations/20261024100000_build317_orders_session_management.sql');
  const readiness = sql.slice(sql.indexOf('create or replace function public.get_table_session_management'));
  const closeCore = sql.slice(sql.indexOf('create or replace function public.build20_close_session_core'));

  assert.match(readiness, /current_user_has_permission_for_branch\(v_session\.branch_id, 'EDIT_ORDERS'\)/);
  assert.match(readiness, /payment_status <> 'PAID'/);
  assert.match(readiness, /payment_attempts/);
  assert.match(readiness, /payment_expires_at > now\(\)/);
  assert.match(readiness, /service_requests/);
  assert.match(readiness, /'can_close', jsonb_array_length\(v_reasons\) = 0/);
  assert.match(readiness, /payment_transactions/);
  assert.match(readiness, /'customer_phone', v_session\.customer_phone/);
  assert.match(closeCore, /for update/);
  assert.match(closeCore, /Payment verification is still pending/);
  assert.match(closeCore, /Cancelled or rejected orders have unresolved payment state/);
  assert.match(closeCore, /closed_by = p_actor_user_id/);
  assert.match(closeCore, /build17_sync_table_operational_state\(v_table\.id\)/);
  assert.match(sql, /grant execute on function public\.get_table_session_management\(uuid\) to authenticated/);
  assert.match(sql, /revoke execute on function public\.get_table_session_management\(uuid\) from anon, public/);
});

test('closing a visit preserves independent sessions on its physical table', async () => {
  const sql = await read('supabase/migrations/20261024100000_build317_orders_session_management.sql');
  const multiSession = await read('supabase/migrations/202609170015_build19_multi_session_table_handoff.sql');

  assert.match(sql, /set status = 'CLOSED'[\s\S]*?where id = v_session\.id/);
  assert.match(sql, /where table_id = v_table\.id\s+and session_id = v_session\.id/);
  assert.match(sql, /perform public\.build17_sync_table_operational_state\(v_table\.id\)/);
  assert.match(multiSession, /Closes EXACTLY the requested session/);
  assert.match(multiSession, /table_id=v_session\.table_id and ts\.status in \('ACTIVE','SETTLING'\)/);
});

test('cancelled-order closure override is manual, reasoned, audited, and cannot bypass other blockers', async () => {
  const migration = await read('supabase/migrations/20261024120000_build317_audited_cancelled_session_close.sql');
  const panel = await read('components/orders/SessionManagementPanel.tsx');

  assert.match(migration, /create table if not exists public\.table_session_close_overrides/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.table_session_close_overrides from public, anon, authenticated/);
  assert.match(migration, /current_user_has_permission_for_branch\(v_session\.branch_id, 'EDIT_ORDERS'\)/);
  assert.match(migration, /p_reason text/);
  assert.match(migration, /char_length\(v_reason\) < 10 or char_length\(v_reason\) > 500/);
  assert.match(migration, /Payment verification is still pending; this blocker cannot be force-closed/);
  assert.match(migration, /Unpaid active orders must be settled before closing the session/);
  assert.match(migration, /Outstanding service requests must be resolved before closing the session/);
  assert.match(migration, /cancelled_order_snapshot/);
  assert.match(migration, /FORCED_CANCELLED_ORDER_REVIEW/);
  assert.match(migration, /v_unresolved_cancelled_payment > 0 and not v_has_cancelled_override/);
  assert.match(panel, /force_close_table_session_for_cancelled_orders/);
  assert.match(panel, /Same-visit reorders remain linked to this session until you explicitly close it/);
  assert.match(panel, /forceAcknowledged/);
  assert.match(panel, /canForceCloseForCancelledOrders/);
});
