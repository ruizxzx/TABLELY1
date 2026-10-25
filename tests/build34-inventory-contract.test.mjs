import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Build 34 migrations have unique, ordered versions within the current migration batch', async () => {
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter((name) => /build34/.test(name))
    .sort();
  const versions = names.map((name) => name.match(/^(\d{14})/));
  assert.ok(names.length >= 6);
  assert.ok(versions.every(Boolean));
  assert.equal(new Set(versions.map((match) => match[1])).size, versions.length);
  assert.deepEqual(versions.map((match) => match[1]), [...versions.map((match) => match[1])].sort());
});

test('inventory permissions default off for non-owners', async () => {
  const sql = await read('supabase/migrations/20261025030000_build34_1_inventory_foundation.sql');
  assert.match(sql, /v_inventory text\[\] := array\[[\s\S]*?'INVENTORY_VIEW'[\s\S]*?'INVENTORY_TRANSFER'[\s\S]*?\];/);
  assert.match(sql, /select new\.id, p, false from unnest\(v_sensitive \|\| v_inventory\) p/);
});

test('inventory item creation uses one value for each item column', async () => {
  const sql = await read('supabase/migrations/20261025040000_build34_2_inventory_item_rpcs.sql');
  assert.match(sql, /organization_id, name, sku, description, category_id,[\s\S]*?\) values \([\s\S]*?p_organization_id, trim\(p_name\), nullif\(trim\(coalesce\(p_sku,''\)\), ''\),[\s\S]*?nullif\(trim\(coalesce\(p_description,''\)\), ''\), p_category_id,[\s\S]*?coalesce\(p_is_active, true\), auth\.uid\(\)\s*\) returning \* into v_item;/);
});

test('stock movements are append-only and cache writers are not callable by staff', async () => {
  const sql = await read('supabase/migrations/20261025030000_build34_1_inventory_foundation.sql');
  const movements = sql.slice(sql.indexOf('create table if not exists public.inventory_stock_movements'), sql.indexOf('-- 11) Order reservations'));
  assert.match(movements, /using \(public\.current_user_has_permission_for_branch\(branch_id, 'INVENTORY_COST_VIEW'\)\)/);
  assert.doesNotMatch(movements, /create policy inventory_movements_insert/);
  assert.doesNotMatch(movements, /grant select, insert on public\.inventory_stock_movements/);
  assert.match(sql, /revoke all on function public\.inventory_update_balance\([\s\S]*?from public, anon, authenticated;/);
  assert.match(sql, /revoke all on function public\.inventory_update_reservation\([\s\S]*?from public, anon, authenticated;/);
});

test('inventory cost and supplier details are redacted or permission-gated', async () => {
  const foundation = await read('supabase/migrations/20261025030000_build34_1_inventory_foundation.sql');
  const items = await read('supabase/migrations/20261025040000_build34_2_inventory_item_rpcs.sql');
  const reports = await read('supabase/migrations/20261025080000_build34_6_wastage_counts_reports.sql');
  assert.match(foundation, /inventory_item_suppliers_select[\s\S]*?INVENTORY_PURCHASE[\s\S]*?INVENTORY_COST_VIEW/);
  assert.match(foundation, /inventory_balances_select[\s\S]*?INVENTORY_COST_VIEW/);
  assert.doesNotMatch(foundation, /current_user_is_branch_operator/);
  assert.match(items, /case when public\.current_user_has_permission_for_branch\(p_branch_id, 'INVENTORY_COST_VIEW'\)[\s\S]*?ib\.avg_unit_cost_paise/);
  assert.match(items, /to_jsonb\(v_balance\) - 'avg_unit_cost_paise' - 'stock_value_paise'/);
  assert.match(items, /to_jsonb\(m\) - 'unit_cost_paise' - 'total_cost_paise'/);
  assert.match(items, /to_jsonb\(s\) - 'unit_price_paise'/);
  assert.match(reports, /case when v_can_view_cost then m\.unit_cost_paise else null end/);
  assert.match(foundation, /inventory_wastage_select[\s\S]*?INVENTORY_COST_VIEW/);
});

test('order lifecycle helpers are internal and preserve strict stock failures', async () => {
  const sql = await read('supabase/migrations/20261025070000_build34_5_order_consumption.sql');
  const foundation = await read('supabase/migrations/20261025030000_build34_1_inventory_foundation.sql');
  assert.match(sql, /stock_mode = 'STRICT' and coalesce\(v_available_qty, 0\) < v_needed_qty/);
  assert.match(sql, /revoke all on function public\.inventory_reserve_for_order\(uuid\) from anon, public, authenticated/);
  assert.match(sql, /revoke all on function public\.inventory_consume_for_order\(uuid\) from anon, public, authenticated/);
  assert.match(sql, /revoke all on function public\.inventory_release_reservation\(uuid\) from anon, public, authenticated/);
  assert.doesNotMatch(sql, /exception when others then/);
  assert.match(foundation, /v_new_on_hand := v_current\.on_hand_qty \+ p_qty_delta/);
});

test('restaurant navigation gates Inventory by its branch permission and entitlement', async () => {
  const shell = await read('components/StudioShell.tsx');
  assert.match(shell, /'\/inventory': 'INVENTORY_VIEW'/);
  assert.match(shell, /features\.INVENTORY === false/);
  assert.match(shell, /entitlements\.INVENTORY !== false/);
});

test('inventory overview and settings use authorized RPCs and expose management controls conditionally', async () => {
  const page = await read('app/inventory/page.tsx');
  const settings = await read('app/inventory/settings/page.tsx');
  assert.match(page, /inventory_get_overview/);
  assert.match(page, /inventory_list_items/);
  assert.match(page, /current_user_has_permission_for_branch/);
  assert.match(page, /canViewCost && <th>Unit cost/);
  assert.match(page, /canManage && \(/);
  assert.match(page, /inventory_generate_alerts/);
  assert.match(page, /inventory_dismiss_alert/);
  assert.match(page, /Active stock alerts/);
  assert.match(settings, /organization_has_feature/);
  assert.match(settings, /inventory_upsert_branch_settings/);
  assert.match(settings, /inventory_upsert_location/);
});

test('warning-mode order inventory failures stay visible while strict mode remains fail-closed', async () => {
  const migration = await read('supabase/migrations/20261025090000_build34_7_inventory_lifecycle_errors.sql');
  const consumption = await read('supabase/migrations/20261025070000_build34_5_order_consumption.sql');
  assert.match(migration, /inventory_processing_errors/);
  assert.match(migration, /if v_stock_mode = 'STRICT' then\s+raise;/);
  assert.match(migration, /on conflict \(order_id, order_status, error_code\)/);
  assert.match(migration, /current_user_has_permission_for_branch\(branch_id, 'INVENTORY_MANAGEMENT'\)/);
  assert.match(consumption, /pg_advisory_xact_lock/);
  assert.match(consumption, /for update;/);
});

test('recipe RPCs enforce branch access, inventory entitlement, and cost privacy', async () => {
  const sql = await read('supabase/migrations/20261025050000_build34_3_recipe_rpcs.sql');
  assert.match(sql, /organization_has_feature\(p_organization_id, 'INVENTORY'\)/);
  assert.match(sql, /branch_id is not distinct from p_branch_id/);
  assert.match(sql, /current_user_has_permission_for_branch\(p_branch_id, 'INVENTORY_VIEW'\)/);
  assert.match(sql, /case when v_can_view_cost then rv\.cost_per_serving_paise else null end/);
  assert.match(sql, /to_jsonb\(v\) - 'cost_per_serving_paise'/);
  assert.match(sql, /Recipe version does not belong to this recipe/);
  assert.match(sql, /Sub-recipe would create a recipe cycle/);
  assert.match(sql, /inventory_calculate_recipe_cost\(rl\.sub_recipe_id, p_branch_id, null\)/);
});

test('recipe UI uses authorized recipe, ingredient, and cost RPCs', async () => {
  const page = await read('app/inventory/recipes/page.tsx');
  const inventory = await read('app/inventory/page.tsx');
  assert.match(page, /inventory_list_recipes/);
  assert.match(page, /inventory_upsert_recipe/);
  assert.match(page, /inventory_calculate_recipe_cost/);
  assert.match(page, /canViewCost &&/);
  assert.match(page, /INVENTORY_RECIPE_MANAGEMENT/);
  assert.match(page, /INVENTORY_VIEW/);
  assert.match(page, /Save new version/);
  assert.match(page, /inventory_get_recipe_version/);
  assert.match(page, /AUDIT HISTORY/);
  assert.match(page, /function editRecipe/);
  assert.match(inventory, /href="\/inventory\/recipes">Recipes/);
});

test('purchase and goods-receipt RPCs validate tenant scope and line values', async () => {
  const sql = await read('supabase/migrations/20261025060000_build34_4_purchase_grn_rpcs.sql');
  const page = await read('app/inventory/purchases/page.tsx');
  const inventory = await read('app/inventory/page.tsx');
  assert.match(sql, /revoke all on function public\.inventory_next_po_number\(uuid\) from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.inventory_next_grn_number\(uuid\) from public, anon, authenticated/);
  assert.match(sql, /organization_has_feature\(v_org, 'INVENTORY'\)/);
  assert.match(sql, /Supplier does not belong to this organization/);
  assert.match(sql, /Purchase item must be active, belong to this organization, and use its purchase unit/);
  assert.match(sql, /Goods receipt item must be active, belong to this organization, and use its purchase unit/);
  assert.match(sql, /Purchase order line does not match the order, item, unit, or remaining quantity/);
  assert.match(sql, /received_qty = received_qty \+ v_line\.accepted_qty/);
  assert.match(sql, /PARTIALLY_RECEIVED'::public\.inventory_po_status/);
  assert.match(sql, /when v_po\.status = 'DRAFT' and p_new_status = 'APPROVED'[\s\S]*?then public\.is_org_owner\(v_po\.organization_id\)/);
  assert.match(sql, /coalesce\(\(v_line->>'accepted_qty'\)::numeric, 0\)\s*\+\s*coalesce\(\(v_line->>'damaged_qty'\)::numeric, 0\)\s*>\s*coalesce\(\(v_line->>'received_qty'\)::numeric, 0\)/);
  assert.match(sql, /'GRN', v_line\.id, auth\.uid\(\)/);
  assert.match(sql, /p_idempotency_key uuid default null/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(page, /inventory_list_suppliers/);
  assert.match(page, /inventory_upsert_supplier/);
  assert.match(page, /inventory_upsert_purchase_order/);
  assert.match(page, /inventory_advance_po_status/);
  assert.match(page, /parsePaise/);
  assert.match(inventory, /href="\/inventory\/purchases">Purchasing/);
});

test('blind stock counts redact expected quantities and require independent approval', async () => {
  const sql = await read('supabase/migrations/20261025100000_build34_8_stock_count_privacy.sql');
  const page = await read('app/inventory/counts/page.tsx');
  const inventory = await read('app/inventory/page.tsx');
  assert.match(sql, /revoke select on public\.inventory_stock_count_lines from authenticated/);
  assert.match(sql, /inventory_get_stock_count/);
  assert.match(sql, /v_count\.submitted_by <> auth\.uid\(\)/);
  assert.match(sql, /expected_qty', case when v_can_see_expected then cl\.expected_qty else null end/);
  assert.match(sql, /Submit exactly one count for each listed inventory item/);
  assert.match(sql, /different authorized staff member must approve/);
  assert.match(sql, /inventory_update_balance\(v_line\.item_id, v_count\.branch_id, v_line\.variance_qty, 0\)/);
  assert.match(sql, /Location does not belong to this branch or is inactive/);
  assert.match(page, /inventory_get_stock_count/);
  assert.match(page, /inventory_submit_count_lines/);
  assert.match(page, /inventory_approve_stock_count/);
  assert.match(inventory, /href="\/inventory\/counts">Stock counts/);
});

test('goods receiving uses receive-scoped RPCs and redacts supplier costs', async () => {
  const sql = await read('supabase/migrations/20261025100000_build34_8_stock_count_privacy.sql');
  const page = await read('app/inventory/receiving/page.tsx');
  const purchases = await read('app/inventory/purchases/page.tsx');
  assert.match(sql, /inventory_list_receivable_purchase_orders/);
  assert.match(sql, /inventory_list_receivable_po_lines/);
  assert.match(sql, /case when v_can_view_cost then pol\.agreed_unit_price_paise else null end/);
  assert.match(sql, /revoke select on public\.inventory_goods_receipts from authenticated/);
  assert.match(sql, /revoke select on public\.inventory_goods_receipt_lines from authenticated/);
  assert.match(sql, /case when v_can_view_cost then grn\.total_accepted_value_paise else null end/);
  assert.match(page, /inventory_create_grn/);
  assert.match(page, /inventory_approve_grn/);
  assert.match(page, /inventory_list_pending_grns/);
  assert.match(page, /receivedQty/);
  assert.match(purchases, /href="\/inventory\/receiving">Goods receiving/);
});

test('wastage reads are branch-scoped and report costs require cost-view permission', async () => {
  const sql = await read('supabase/migrations/20261025110000_build34_9_wastage_reads.sql');
  const wastagePage = await read('app/inventory/wastage/page.tsx');
  const reportsPage = await read('app/inventory/reports/page.tsx');
  const inventoryPage = await read('app/inventory/page.tsx');
  assert.match(sql, /inventory_list_wastage_items/);
  assert.match(sql, /current_user_has_permission_for_branch\(p_branch_id, 'INVENTORY_WASTAGE'\)/);
  assert.match(sql, /case when v_can_view_cost then w\.cost_paise else null end/);
  assert.match(sql, /w\.branch_id = p_branch_id/);
  assert.match(sql, /o\.payment_status = 'PAID'/);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(p_idempotency_key::text, 0\)\)/);
  assert.match(sql, /inventory_wastage_org_idempotency_uidx/);
  assert.match(wastagePage, /inventory_record_wastage/);
  assert.match(wastagePage, /p_idempotency_key: idempotencyKey/);
  assert.match(wastagePage, /inventory_list_wastage/);
  assert.match(wastagePage, /canViewCost && <th>Cost/);
  assert.match(reportsPage, /INVENTORY_COST_VIEW/);
  assert.match(reportsPage, /inventory_food_cost_report/);
  assert.match(reportsPage, /inventory_variance_report/);
  assert.match(reportsPage, /Export CSV/);
  assert.match(inventoryPage, /href="\/inventory\/wastage">Wastage/);
  assert.match(inventoryPage, /href="\/inventory\/reports">Reports/);
});

test('branch transfers enforce endpoint permissions and record dispatch and receipt ledger movements', async () => {
  const sql = await read('supabase/migrations/20261025120000_build34_10_transfer_workflow.sql');
  const page = await read('app/inventory/transfers/page.tsx');
  const inventory = await read('app/inventory/page.tsx');
  assert.match(sql, /revoke all on public\.inventory_transfer_lines from authenticated, anon, public/);
  assert.match(sql, /inventory_list_transfer_branches/);
  assert.match(sql, /inventory_create_transfer/);
  assert.match(sql, /Both branches must be active, in the same organization/);
  assert.match(sql, /current_user_has_permission_for_branch\(p_from_branch_id, 'INVENTORY_TRANSFER'\)/);
  assert.match(sql, /current_user_has_permission_for_branch\(p_to_branch_id, 'INVENTORY_TRANSFER'\)/);
  assert.match(sql, /status = 'DISPATCHED'/);
  assert.match(sql, /'TRANSFER_OUT'/);
  assert.match(sql, /'TRANSFER_IN'/);
  assert.match(sql, /Accepted plus damaged quantity must equal dispatched quantity/);
  assert.match(sql, /case when v_can_view_cost then tl\.unit_cost_paise else null end/);
  assert.match(page, /inventory_transition_transfer/);
  assert.match(page, /inventory_create_transfer/);
  assert.match(page, /p_action: action/);
  assert.match(page, /APPROVE/);
  assert.match(page, /MARK_IN_TRANSIT/);
  assert.match(page, /RECEIVE/);
  assert.match(inventory, /href="\/inventory\/transfers">Transfers/);
});

test('historical recipe versions are branch-scoped and validate recipe ownership', async () => {
  const sql = await read('supabase/migrations/20261025130000_build34_3_recipe_version_reads.sql');
  assert.match(sql, /inventory_get_recipe_version/);
  assert.match(sql, /current_user_has_permission_for_branch\(p_branch_id, 'INVENTORY_VIEW'\)/);
  assert.match(sql, /rv\.id = p_version_id and rv\.recipe_id = v_recipe\.id/);
  assert.match(sql, /to_jsonb\(v_version\) - 'cost_per_serving_paise'/);
  assert.match(sql, /revoke execute on function public\.inventory_get_recipe_version\(uuid, uuid, uuid\) from anon, public/);
});

test('ingredient detail workflows use branch-scoped reads and protect supplier and cost data', async () => {
  const sql = await read('supabase/migrations/20261025140000_build34_2_item_detail_reads.sql');
  const page = await read('app/inventory/items/[id]/page.tsx');
  const inventoryPage = await read('app/inventory/page.tsx');
  assert.match(sql, /inventory_get_item_detail/);
  assert.match(sql, /inventory_list_item_batches/);
  assert.match(sql, /inventory_list_item_suppliers/);
  assert.match(sql, /inventory_list_item_recipe_usage/);
  assert.match(sql, /case when v_can_view_cost then b\.unit_cost_paise else null end/);
  assert.match(sql, /case when v_can_view_cost then iis\.unit_price_paise else null end/);
  assert.match(sql, /current_user_has_permission_for_branch\(p_branch_id, 'INVENTORY_PURCHASE'\)/);
  assert.match(page, /inventory_upsert_item/);
  assert.match(page, /inventory_get_item_movements/);
  assert.match(page, /Recipe usage/);
  assert.match(page, /Changing stock units requires a controlled stock conversion/);
  assert.match(inventoryPage, /\/inventory\/items\/\$\{item\.id\}/);
});
