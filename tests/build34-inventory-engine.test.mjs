import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('P0: order items use preparation_status and exclude cancelled items from reservation', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /from public\.order_items[\s\S]*?where order_id = p_order_id[\s\S]*?preparation_status is null or preparation_status <> 'CANCELLED'/);
});

test('P0: individual order item cancellation releases reservation line and balance', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /create or replace function public\.inventory_order_item_lifecycle_hook\(\)/);
  assert.match(hardening, /new\.preparation_status = 'CANCELLED'/);
  assert.match(hardening, /perform public\.inventory_update_reservation\(\s*v_res_line\.item_id,\s*v_res_line\.branch_id,\s*-v_res_line\.reserved_qty\s*\);/);
  assert.match(hardening, /delete from public\.inventory_reservation_lines where id = v_res_line\.id;/);
  assert.match(hardening, /create trigger inventory_order_item_lifecycle[\s\S]*?after update of preparation_status on public\.order_items/);
});

test('P0: order consumption aggregates ingredients to prevent duplicate SALE movement conflicts', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /group by rl\.item_id, rl\.branch_id/);
  assert.match(hardening, /sum\(rl\.reserved_qty\) as total_qty/);
  assert.match(hardening, /insert into public\.inventory_stock_movements\([\s\S]*?'SALE', -v_agg\.total_qty, v_agg\.unit/);
  assert.match(hardening, /perform public\.inventory_update_balance\(\s*v_agg\.item_id,\s*v_agg\.branch_id,\s*-v_agg\.total_qty,\s*0\s*\);/);
});

test('P0: order lifecycle reserves on both ACCEPTED and PREPARING, and auto-reserves on COMPLETED', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /if new\.status in \('ACCEPTED', 'PREPARING'\) then[\s\S]*?perform public\.inventory_reserve_for_order\(new\.id\);/);
  assert.match(hardening, /elsif new\.status = 'COMPLETED' then[\s\S]*?perform public\.inventory_reserve_for_order\(new\.id\);[\s\S]*?perform public\.inventory_consume_for_order\(new\.id\);/);
});

test('P1: order consumption implements FEFO batch allocation in ascending expiry order', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /order by expires_at asc nulls last, created_at asc/);
  assert.match(hardening, /v_batch_deduct := least\(v_batch\.current_qty, v_remaining_to_deduct\);/);
  assert.match(hardening, /update public\.inventory_batches[\s\S]*?set current_qty = current_qty - v_batch_deduct/);
});

test('P1: inventory items protect base_unit against modifications after transactions or recipes exist', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /if v_existing\.base_unit <> p_base_unit then/);
  assert.match(hardening, /exists \(select 1 from public\.inventory_stock_movements where item_id = p_id limit 1\)/);
  assert.match(hardening, /exists \(select 1 from public\.inventory_recipe_lines where item_id = p_id limit 1\)/);
  assert.match(hardening, /Base unit cannot be changed because inventory movements or recipes already exist/);
});

test('P1: immutable supplier price history is recorded on supplier upsert and queryable via RPC', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /create table if not exists public\.inventory_supplier_price_history/);
  assert.match(hardening, /insert into public\.inventory_supplier_price_history\([\s\S]*?p_supplier_id,\s*p_item_id,\s*p_price_paise/);
  assert.match(hardening, /create or replace function public\.inventory_get_supplier_price_history/);
});

test('P1: recipe costing handles unpriced ingredients and falls back to preferred supplier price', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /create or replace function public\.inventory_calculate_recipe_cost/);
  assert.match(hardening, /iis\.is_preferred = true/);
  assert.match(hardening, /is_cost_complete boolean/);
  assert.match(hardening, /unpriced_count bigint/);
});

test('P1: sub-recipe production batch workflow consumes inputs and produces output stock', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /create or replace function public\.inventory_record_production_batch/);
  assert.match(hardening, /'PRODUCTION_INPUT', -v_input_qty/);
  assert.match(hardening, /'PRODUCTION_OUTPUT', p_batch_qty/);
  assert.match(hardening, /status.*?COMPLETED/);
});

test('P1: recipe coverage report exposes tracked, untracked, and missing recipes', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /create or replace function public\.inventory_get_recipe_coverage/);
  assert.match(hardening, /\(r\.id is not null\) as has_recipe/);
  assert.match(hardening, /food_cost_pct/);
});

test('P1: smart reorder suggestions identify low stock and compute suggested quantities', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /create or replace function public\.inventory_get_reorder_suggestions/);
  assert.match(hardening, /coalesce\(ib\.available_qty, 0\) <= ii\.reorder_level/);
  assert.match(hardening, /suggested_order_qty/);
  assert.match(hardening, /preferred_supplier_name/);
});

test('P1: operational food cost report includes all completed orders regardless of payment status', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /create or replace function public\.inventory_food_cost_report/);
  assert.match(hardening, /'total_sales_paise', coalesce\(\(\s*select sum\(\(total \* 100\)::bigint\) from public\.orders\s*where branch_id = p_branch_id\s*and status = 'COMPLETED'/);
  assert.match(hardening, /'settled_sales_paise'/);
  assert.match(hardening, /'actual_food_cost_paise'/);
});

test('P1: processing error resolution supports retry action that replays inventory operations', async () => {
  const hardening = await read('supabase/migrations/20261025160000_build34_inventory_engine_hardening.sql');
  assert.match(hardening, /create or replace function public\.inventory_resolve_processing_error\([\s\S]*?p_error_id uuid,[\s\S]*?p_action text default 'RETRY'/);
  assert.match(hardening, /if upper\(p_action\) = 'RETRY' then/);
  assert.match(hardening, /perform public\.inventory_reserve_for_order\(v_error\.order_id\);/);
  assert.match(hardening, /perform public\.inventory_consume_for_order\(v_error\.order_id\);/);
});

test('P1: wastage UI accepts location and batch parameters and passes them to the database RPC', async () => {
  const wastageUi = await read('app/inventory/wastage/page.tsx');
  assert.match(wastageUi, /p_batch_id: batchId \|\| null/);
  assert.match(wastageUi, /p_location_id: locationId \|\| null/);
  assert.match(wastageUi, /locations\.map\(\(loc\) =>/);
  assert.match(wastageUi, /batches\.map\(\(b\) =>/);
});
