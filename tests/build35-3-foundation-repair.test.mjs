import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const migrationPath = 'supabase/migrations/20261026030000_build35_3_foundation_repair.sql';
const sql = await readFile(migrationPath, 'utf8');
const read = async (path) => readFile(path, 'utf8');

function functionBody(name) {
  const lower = sql.toLowerCase();
  const nameLower = name.toLowerCase();
  const starts = [lower.indexOf(`create or replace function public.${nameLower}`), lower.indexOf(`create function public.${nameLower}`)].filter((value) => value >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  assert.notEqual(start, -1, `Missing function ${name}`);
  const next = sql.indexOf('$$;', start);
  assert.notEqual(next, -1, `Function ${name} has no closing delimiter`);
  return sql.slice(start, next + 3);
}

test('Build 35.3 is a uniquely named, forward-only migration', () => {
  assert.match(migrationPath, /20261026030000_build35_3_foundation_repair\.sql$/);
  assert.match(sql, /\bbegin;/i);
  assert.match(sql.trimEnd(), /commit;\s*select pg_notify\('pgrst', 'reload schema'\);$/i);
  assert.doesNotMatch(sql, /drop table\s+public\.(orders|payment_attempts|payment_transactions)/i);
});

test('ordering defaults and existing branch settings are safely disabled', () => {
  assert.match(sql, /online_ordering_enabled set default false/i);
  assert.match(sql, /pickup_enabled set default false/i);
  assert.match(sql, /delivery_enabled set default false/i);
  assert.match(sql, /auto_accept_enabled set default false/i);
  assert.match(sql, /cod_enabled', false/i);
  assert.match(sql, /upi_on_delivery_enabled', false/i);
  assert.match(sql, /update public\.branch_ordering_settings\s+set online_ordering_enabled = false/i);
});

test('settings updates merge JSON safely and create an audit record', () => {
  const body = functionBody('save_branch_ordering_settings');
  assert.match(body, /v_pickup := coalesce\(v_before\.pickup_settings, '\{\}'::jsonb\)/i);
  assert.match(body, /v_delivery := coalesce\(v_before\.delivery_settings, '\{\}'::jsonb\)/i);
  assert.match(body, /pickup_settings = v_pickup/i);
  assert.match(body, /delivery_settings = v_delivery/i);
  assert.match(body, /insert into public\.branch_ordering_settings_audit/i);
  assert.match(body, /MANAGE_ONLINE_ORDERING/i);
});

test('table trigger requires a valid dine-in table and forbids tables for pickup/delivery', () => {
  const body = functionBody('validate_order_table_branch');
  assert.match(body, /fulfillment_type = 'DINE_IN'[\s\S]*table_id is null/i);
  assert.match(body, /t\.id = new\.table_id and t\.branch_id = new\.branch_id/i);
  assert.match(body, /fulfillment_type in \('PICKUP', 'DELIVERY'\)[\s\S]*new\.table_id is not null/i);
  assert.match(sql, /before insert or update of branch_id, table_id, fulfillment_type on public\.orders/i);
});

test('public delivery-zone aggregation is ordered inside jsonb_agg and handles empty zones', () => {
  const body = functionBody('get_public_storefront_context');
  assert.match(body, /jsonb_agg\(jsonb_build_object\([\s\S]*\) order by dz\.priority desc, dz\.delivery_fee asc, dz\.id asc\)/i);
  assert.match(body, /coalesce\(jsonb_agg/i);
  assert.match(body, /where dz\.branch_id = v_branch\.id and dz\.is_active = true/i);
  assert.match(body, /p_branch_id is not null[\s\S]*organization_id = v_org\.id and active = true/i);
});

test('public menu and checkout validate active branch, active organization, enabled fulfillment and server prices', () => {
  const menu = functionBody('get_public_menu_for_branch');
  const preview = functionBody('preview_public_fulfillment_checkout');
  const create = functionBody('create_public_fulfillment_order');
  for (const body of [menu, preview, create]) {
    assert.match(body, /b\.active = true/i);
    assert.match(body, /o\.status = 'ACTIVE'/i);
    assert.match(body, /online_ordering_enabled/i);
  }
  assert.match(preview, /build16_calculate_cart\(p_branch_id, p_items\)/i);
  assert.match(preview, /mi\.is_available = false[\s\S]*mi\.is_draft = true/i);
  assert.match(preview, /not available for online ordering/i);
  assert.match(preview, /build18_validate_coupon/i);
  assert.match(create, /build18_validate_coupon\([\s\S]*true\s*\)/i);
  assert.match(create, /coupon usage limit|coupon could not be validated|coupon pricing changed/i);
  assert.match(create, /insert into public\.coupon_usages/i);
  assert.match(create, /'COUPON_APPLIED'/i);
});

test('checkout is idempotent and writes an immutable price snapshot', () => {
  const body = functionBody('create_public_fulfillment_order');
  assert.match(body, /p_idempotency_key text default null/i);
  assert.match(body, /pg_advisory_xact_lock/i);
  assert.match(body, /idempotency_fingerprint/i);
  assert.match(body, /checkout_snapshot/i);
  assert.match(body, /Idempotency key was already used for a different checkout/i);
  assert.match(sql, /add column if not exists checkout_snapshot jsonb/i);
});

test('OTP generation uses CSPRNG and bcrypt hashes, not plaintext or fast digest hashes', () => {
  const body = functionBody('create_public_fulfillment_order');
  const verifyPickup = functionBody('fulfillment_confirm_pickup');
  const verifyDelivery = functionBody('fulfillment_confirm_delivered');
  assert.match(body, /extensions\.gen_random_bytes\(4\)/i);
  assert.match(body, /crypt\(v_order\.id::text \|\| ':' \|\| v_pickup_code, gen_salt\('bf', 12\)\)/i);
  assert.match(body, /crypt\(v_order\.id::text \|\| ':' \|\| v_delivery_otp, gen_salt\('bf', 12\)\)/i);
  assert.match(verifyPickup, /crypt\(p_order_id::text \|\| ':' \|\| trim\(coalesce\(p_pickup_code/i);
  assert.match(verifyDelivery, /crypt\(p_order_id::text \|\| ':' \|\| trim\(coalesce\(p_delivery_otp/i);
  assert.match(sql, /pickup_verification_attempts between 0 and 5/i);
  assert.match(sql, /delivery_verification_attempts between 0 and 5/i);
  assert.match(sql, /pickup_code_expires_at/i);
  assert.match(sql, /delivery_otp_expires_at/i);
  assert.match(verifyPickup, /pickup_code_used_at is not null/i);
  assert.match(verifyDelivery, /delivery_otp_used_at is not null/i);
});

test('public tracking and staff list RPCs never return raw handoff codes or hashes', () => {
  const tracking = functionBody('get_public_fulfillment_order');
  const list = functionBody('fulfillment_list_branch_orders');
  assert.match(tracking, /null::text, null::text, v_ofd\.address_snapshot/i);
  assert.match(list, /null::text, null::text, ofd\.assigned_staff_id/i);
  assert.match(sql, /grant select \([\s\S]*payment_collected_amount[\s\S]*\) on public\.order_fulfillment_details/i);
  assert.doesNotMatch(sql, /grant select \([\s\S]{0,500}pickup_code_hash/i);
});

test('fulfillment state machine prevents premature dispatch and delivery', () => {
  const dispatch = functionBody('fulfillment_dispatch_delivery');
  const delivered = functionBody('fulfillment_confirm_delivered');
  const pickup = functionBody('fulfillment_confirm_pickup');
  assert.match(dispatch, /fulfillment_status <> 'READY_FOR_DISPATCH'/i);
  assert.match(dispatch, /v_order\.status <> 'READY'/i);
  assert.match(delivered, /fulfillment_status <> 'OUT_FOR_DELIVERY'/i);
  assert.match(pickup, /fulfillment_status <> 'READY_FOR_PICKUP'/i);
  assert.match(pickup, /v_order\.status <> 'READY'/i);
  assert.match(sql, /'READY_FOR_PICKUP'[\s\S]*'READY_FOR_DISPATCH'/i);
});

test('order, fulfillment, and payment completion remain independent', () => {
  const transition = functionBody('transition_order_status');
  const collect = functionBody('fulfillment_collect_payment');
  assert.match(transition, /payment_status <> 'PAID'/i);
  assert.match(transition, /fulfillment_status not in \('PICKED_UP','DELIVERED'\)/i);
  assert.match(collect, /set payment_status = 'PAID'/i);
  assert.match(collect, /fulfillment_status in \('DELIVERED','PICKED_UP'\)/i);
  assert.match(collect, /payment_method = v_ofd\.fulfillment_type \|\| '_' \|\| v_method/i);
  assert.match(collect, /MANAGE_PICKUP/i);
});

test('rider APIs are assigned-only and assignment validates same-branch eligible staff', () => {
  const assign = functionBody('fulfillment_assign_rider');
  const myDeliveries = functionBody('fulfillment_list_my_deliveries');
  const eligible = functionBody('fulfillment_list_eligible_riders');
  assert.match(assign, /s\.branch_id = v_ofd\.branch_id and s\.active = true/i);
  assert.match(assign, /UPDATE_DELIVERY_STATUS/i);
  assert.match(myDeliveries, /ofd\.assigned_staff_id in \(select s\.id/i);
  assert.match(myDeliveries, /s\.user_id = auth\.uid\(\)/i);
  assert.match(eligible, /ASSIGN_DELIVERY/i);
  assert.match(eligible, /display_name/i);
  assert.doesNotMatch(eligible, /s\.full_name/i);
  assert.match(assign, /rider_name', coalesce\(v_staff\.display_name, \(select pr\.full_name from public\.profiles pr where pr\.id = v_staff\.user_id\), 'Staff'\)/i);
});

test('new permission controls exist in code and staff management UI', async () => {
  const perms = await read('lib/tablely-build12.ts');
  const page = await read('app/staff/permissions/page.tsx');
  for (const permission of [
    'VIEW_ONLINE_ORDERS', 'VIEW_CUSTOMER_DETAILS', 'MANAGE_ONLINE_ORDERING',
    'MANAGE_PICKUP', 'VIEW_DELIVERY', 'MANAGE_DELIVERY', 'ASSIGN_DELIVERY',
    'UPDATE_DELIVERY_STATUS', 'COLLECT_DELIVERY_PAYMENT', 'VIEW_FULFILLMENT_REPORTS',
  ]) {
    assert.match(perms, new RegExp(permission));
    assert.match(page, new RegExp(permission));
  }
});

test('tracking UI follows READY_FOR_PICKUP and READY_FOR_DISPATCH states', async () => {
  const track = await read('components/customer/StorefrontTrackClient.tsx');
  assert.match(track, /key: 'READY_FOR_PICKUP'/);
  assert.match(track, /fulfillment_status === 'READY_FOR_PICKUP'/);
  assert.match(track, /fulfillment_status === 'READY_FOR_DISPATCH'/);
});

test('kitchen and order workspaces use permission-scoped customer data retrieval', async () => {
  const kitchen = await read('app/kitchen/page.tsx');
  const orders = await read('app/orders/page.tsx');
  assert.match(kitchen, /get_branch_order_customer_details/);
  assert.match(orders, /get_branch_order_customer_details/);
  assert.match(orders, /from\('orders'\)\s*\.select\([^)]*\)/);
});

test('repair migration is present in the expected repository path', () => {
  assert.equal(existsSync(migrationPath), true);
});

test('Build 35.5 reconciles branch status and restores the settings and rider RPCs', async () => {
  const repair = await read('supabase/migrations/20261026050000_build35_5_schema_reconciliation.sql');
  assert.match(repair, /active boolean generated always as \(is_active\) stored/i);
  assert.match(repair, /create table if not exists public\.branch_ordering_settings_audit/i);
  assert.match(repair, /enable row level security/i);
  assert.match(repair, /create or replace function public\.save_branch_ordering_settings\([\s\S]*p_clear_free_delivery_threshold boolean default false/i);
  assert.match(repair, /grant execute on function public\.save_branch_ordering_settings\(uuid,boolean,boolean,boolean,integer,numeric,numeric,numeric,text,text,boolean,boolean,numeric,boolean\) to authenticated/i);
  assert.match(repair, /create or replace function public\.fulfillment_list_eligible_riders\(p_branch_id uuid\)/i);
  assert.match(repair, /display_name, p\.full_name/i);
  assert.match(repair, /grant execute on function public\.fulfillment_list_eligible_riders\(uuid\) to authenticated/i);
  const storefront = repair.slice(repair.indexOf('create or replace function public.get_public_storefront_context'));
  assert.match(storefront, /jsonb_agg\(jsonb_build_object\([\s\S]*\) order by dz\.priority desc, dz\.delivery_fee asc, dz\.id asc\)/i);
  assert.doesNotMatch(storefront, /from public\.delivery_zones dz[\s\S]{0,120}order by dz\.priority/i);
  assert.match(storefront, /where b\.organization_id = v_org\.id and b\.is_active = true/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Build 35.6 replaces storefront zone ordering with aggregate-local ordering', async () => {
  const repair = await read('supabase/migrations/20261026060000_build35_6_storefront_zone_ordering.sql');
  assert.match(repair, /create or replace function public\.get_public_storefront_context/i);
  assert.match(repair, /jsonb_agg\(jsonb_build_object\([\s\S]*\) order by dz\.priority desc, dz\.delivery_fee asc, dz\.id asc\)/i);
  assert.doesNotMatch(repair, /from public\.delivery_zones dz[\s\S]{0,120}order by dz\.priority/i);
  assert.match(repair, /where b\.organization_id = v_org\.id and b\.is_active = true/i);
  assert.match(repair, /grant execute on function public\.get_public_storefront_context\(text,uuid\) to anon, authenticated/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Build 35.7 returns a null optional cover without referencing a missing organization column', async () => {
  const repair = await read('supabase/migrations/20261026070000_build35_7_storefront_cover_compatibility.sql');
  assert.match(repair, /create or replace function public\.get_public_storefront_context/i);
  assert.match(repair, /v_org\.logo_url, null::text/i);
  assert.doesNotMatch(repair, /v_org\.cover_image_url/i);
  assert.match(repair, /jsonb_agg\(jsonb_build_object\([\s\S]*\) order by dz\.priority desc, dz\.delivery_fee asc, dz\.id asc\)/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Build 35.8 uses the established modifier-group relations in the public menu RPC', async () => {
  const repair = await read('supabase/migrations/20261026080000_build35_8_menu_modifier_schema.sql');
  assert.match(repair, /create or replace function public\.get_public_menu_for_branch\(p_branch_id uuid\)/i);
  assert.match(repair, /from public\.menu_item_modifier_groups mig\s+join public\.modifier_groups mg on mg\.id = mig\.modifier_group_id and mg\.is_active = true/i);
  assert.match(repair, /from public\.modifiers m\s+where m\.modifier_group_id = mg\.id and m\.is_available = true/i);
  assert.doesNotMatch(repair, /public\.menu_modifier_groups|public\.menu_modifiers|m\.group_id/i);
  assert.match(repair, /v_settings\.online_ordering_enabled/i);
  assert.match(repair, /grant execute on function public\.get_public_menu_for_branch\(uuid\) to anon, authenticated/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Build 35.9 recreates the public menu RPC with JSONB source-column result types', async () => {
  const repair = await read('supabase/migrations/20261026090000_build35_9_menu_modifier_result_types.sql');
  assert.match(repair, /drop function if exists public\.get_public_menu_for_branch\(uuid\)/i);
  assert.match(repair, /dietary_tags jsonb, allergens jsonb, addons jsonb/i);
  assert.match(repair, /mi\.dietary_tags, mi\.allergens, mi\.addons/i);
  assert.match(repair, /from public\.menu_item_modifier_groups mig[\s\S]*join public\.modifier_groups mg/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Build 35.10 qualifies tracking order_id to avoid collision with the output column', async () => {
  const repair = await read('supabase/migrations/20261026100000_build35_10_tracking_order_id_qualification.sql');
  assert.match(repair, /create or replace function public\.get_public_fulfillment_order\(p_tracking_token text\)/i);
  assert.match(repair, /from public\.order_fulfillment_details ofd\s+where ofd\.order_id = v_order\.id/i);
  assert.doesNotMatch(repair, /from public\.order_fulfillment_details ofd\s+where order_id\s*=/i);
  assert.match(repair, /grant execute on function public\.get_public_fulfillment_order\(text\) to anon, authenticated/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Build 35.11 restores the branch-scoped order details and pickup RPCs', async () => {
  const repair = await read('supabase/migrations/20261026110000_build35_11_orders_rpc_recovery.sql');
  assert.match(repair, /create or replace function public\.get_branch_order_customer_details\(\s*p_branch_id uuid,\s*p_order_ids uuid\[\]/i);
  assert.match(repair, /VIEW_ORDERS[\s\S]*KITCHEN_ACCESS[\s\S]*VIEW_ONLINE_ORDERS[\s\S]*VIEW_CUSTOMER_DETAILS/i);
  assert.match(repair, /case when v_can_view_customer then o\.customer_phone else null end/i);
  assert.match(repair, /drop function if exists public\.fulfillment_confirm_pickup\(uuid, text, boolean, text\)/i);
  assert.match(repair, /create function public\.fulfillment_confirm_pickup\([\s\S]*p_manager_override boolean default false[\s\S]*p_override_reason text default null/i);
  assert.match(repair, /MANAGE_PICKUP/i);
  assert.match(repair, /pickup_verification_attempts >= 5/i);
  assert.match(repair, /grant execute on function public\.fulfillment_confirm_pickup\(uuid, text, boolean, text\) to authenticated/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('orders workspace checks fulfillment reads and presents safe load errors', async () => {
  const page = await read('app/orders/page.tsx');
  assert.match(page, /const \{ data: fdData, error: fdError \}/);
  assert.match(page, /if \(fdError\) throw fdError/);
  assert.match(page, /code === 'PGRST202'/);
  assert.match(page, /code === '42501'/);
  assert.doesNotMatch(page, /setError\(e instanceof Error \? e\.message : 'Could not load orders\.'\)/);
});

test('Build 35.12 restores pickup verification schema and ready fulfillment states', async () => {
  const repair = await read('supabase/migrations/20261026120000_build35_12_pickup_schema_recovery.sql');
  assert.match(repair, /add column if not exists pickup_code_hash text/i);
  assert.match(repair, /add column if not exists pickup_code_expires_at timestamptz/i);
  assert.match(repair, /add column if not exists pickup_code_used_at timestamptz/i);
  assert.match(repair, /add column if not exists pickup_verification_attempts integer not null default 0/i);
  assert.match(repair, /check \(pickup_verification_attempts between 0 and 5\)/i);
  assert.match(repair, /then 'READY_FOR_PICKUP'[\s\S]*WAITING_FOR_PICKUP/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
  const ordersPage = await read('app/orders/page.tsx');
  assert.match(ordersPage, /code === '42703'[\s\S]*Pickup verification schema is incomplete/i);
});

test('orders settlement routes fulfillment payments through the fulfillment RPC', async () => {
  const page = await read('app/orders/page.tsx');
  const start = page.indexOf('async function settle(method:');
  const end = page.indexOf('\n  async function decideCounterPayment', start);
  const settle = page.slice(start, end);
  assert.match(settle, /settleOrder\.fulfillment_type === 'PICKUP' \|\| settleOrder\.fulfillment_type === 'DELIVERY'/);
  assert.match(settle, /supabase\.rpc\('fulfillment_collect_payment'/);
  assert.match(settle, /p_amount: Number\(settleOrder\.total\)/);
  assert.match(settle, /UPI' && !paymentReference/);
  assert.match(settle, /if \(!isFulfillmentOrder\)[\s\S]*transition_order_status/);
  assert.match(settle, /paymentRecorded[\s\S]*review the order status before retrying/i);
});

test('Build 35.13 atomically verifies pickup, records payment, and completes the order', async () => {
  const repair = await read('supabase/migrations/20261026130000_build35_13_atomic_pickup_payment.sql');
  assert.match(repair, /drop function if exists public\.fulfillment_confirm_pickup\(uuid, text, boolean, text\)/i);
  assert.match(repair, /p_payment_method text default null[\s\S]*p_payment_reference text default null/i);
  assert.match(repair, /for update[\s\S]*current_user_has_permission_for_branch\(v_ofd\.branch_id, 'MANAGE_PICKUP'\)/i);
  assert.match(repair, /current_user_has_permission_for_branch\(v_ofd\.branch_id, 'PAYMENTS'\)/i);
  assert.match(repair, /if v_method = 'UPI' and v_reference is null/i);
  assert.match(repair, /insert into public\.payment_transactions/i);
  assert.match(repair, /payment_collected_at = now\(\)/i);
  assert.match(repair, /fulfillment_status = 'PICKED_UP'/i);
  assert.match(repair, /transition_order_status\(p_order_id, 'COMPLETED'/i);
  assert.match(repair, /v_order\.status = 'COMPLETED' and v_was_picked_up and v_order\.payment_status = 'PAID'[\s\S]*return true/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Orders and Self Pickup send payment method and UPI reference during handover', async () => {
  const orders = await read('app/orders/page.tsx');
  const pickup = await read('app/pickup/page.tsx');
  for (const page of [orders, pickup]) {
    assert.match(page, /p_payment_method: collectPayment \? .*PaymentMethod/);
    assert.match(page, /p_payment_reference: collectPayment && .*PaymentMethod === 'UPI'/);
    assert.match(page, /UPI reference \/ UTR/);
    assert.match(page, /payment_status === 'PAID'[\s\S]*Payment already recorded/);
  }
});

test('Build 35.14 keeps an omitted fulfillment payment reference source null', async () => {
  const repair = await read('supabase/migrations/20261026140000_build35_14_cash_payment_reference_fix.sql');
  assert.match(repair, /v_reference_source text := nullif\(upper\(trim\(coalesce\(p_reference_source, ''\)\)\), ''\)/i);
  assert.match(repair, /if v_reference_source is not null and v_reference_source not in/i);
  assert.match(repair, /grant execute on function public\.fulfillment_collect_payment\(uuid, text, numeric, text, text\) to authenticated/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Build 35.15 avoids the removed staff.full_name field in rider assignment', async () => {
  const repair = await read('supabase/migrations/20261026150000_build35_15_rider_assignment_profile_fallback.sql');
  assert.match(repair, /create or replace function public\.fulfillment_assign_rider\(p_order_id uuid, p_staff_id uuid\)/i);
  assert.match(repair, /v_staff\.display_name,[\s\S]*select profile\.full_name from public\.profiles profile where profile\.id = v_staff\.user_id/i);
  assert.doesNotMatch(repair, /v_staff\.full_name/);
  assert.match(repair, /v_staff\.role <> 'OWNER'[\s\S]*UPDATE_DELIVERY_STATUS/i);
  assert.match(repair, /current_user_has_permission_for_branch\(v_ofd\.branch_id, 'ASSIGN_DELIVERY'\)/i);
  assert.match(repair, /grant execute on function public\.fulfillment_assign_rider\(uuid, uuid\) to authenticated/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('delivery confirmation presents actionable state and authorization errors', async () => {
  const page = await read('app/delivery/page.tsx');
  assert.match(page, /code === '42501' && message === 'Only the assigned authorized delivery person can confirm delivery'/);
  assert.match(page, /Only dispatched orders can be delivered/);
  assert.match(page, /Manager Override can use Manager Override|Manager Override\./i);
  assert.match(page, /confirmError \? <div className="notice notice-error" role="alert">\{confirmError\}/);
  assert.doesNotMatch(page, /alert\(err instanceof Error \? err\.message : 'Could not confirm delivery\.'/);
});

test('Build 35.16 clears failed rider assignments and reactivates same-rider assignment', async () => {
  const repair = await read('supabase/migrations/20261026160000_build35_16_delivery_retry_reassignment.sql');
  assert.match(repair, /create or replace function public\.fulfillment_retry_delivery/i);
  assert.match(repair, /assigned_staff_id = null,[\s\S]*assigned_at = null/i);
  assert.match(repair, /previous_assigned_staff_id', v_previous_staff_id/i);
  assert.match(repair, /create or replace function public\.fulfillment_assign_rider/i);
  assert.match(repair, /if v_ofd\.assigned_staff_id = p_staff_id and v_ofd\.fulfillment_status <> 'WAITING_FOR_DRIVER'[\s\S]*return true/i);
  assert.match(repair, /v_staff\.display_name,[\s\S]*select profile\.full_name/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
  const page = await read('app/delivery/page.tsx');
  assert.match(page, /Could not retry delivery\. Refresh the board and check the order status/);
});

test('Build 35.17 restores delivery confirmation with OTP, assignment, and override checks', async () => {
  const repair = await read('supabase/migrations/20261026170000_build35_17_delivery_confirmation_rpc_recovery.sql');
  assert.match(repair, /create function public\.fulfillment_confirm_delivered\([\s\S]*p_delivery_otp text default null[\s\S]*p_manager_override boolean default false[\s\S]*p_override_reason text default null/i);
  assert.match(repair, /drop function if exists public\.fulfillment_confirm_delivered\(uuid, text, boolean\)/i);
  assert.match(repair, /Only the assigned authorized delivery person can confirm delivery/i);
  assert.match(repair, /fulfillment_status <> 'OUT_FOR_DELIVERY'/i);
  assert.match(repair, /delivery_verification_attempts >= 5/i);
  assert.match(repair, /MANAGE_DELIVERY/i);
  assert.match(repair, /grant execute on function public\.fulfillment_confirm_delivered\(uuid, text, boolean, text\) to authenticated/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);
});

test('Build 35.18 allows payment collection for existing delivery orders and repairs ready assignments', async () => {
  const repair = await read('supabase/migrations/20261026180000_build35_18_delivery_payment_and_readiness.sql');
  assert.match(repair, /create or replace function public\.fulfillment_collect_payment/i);
  assert.match(repair, /current_user_has_permission_for_branch\(v_order\.branch_id, 'PAYMENTS'\)/i);
  assert.match(repair, /round\(p_amount, 2\) <> round\(v_order\.total, 2\)/i);
  assert.match(repair, /UPI collections require a UTR or payment reference/i);
  assert.doesNotMatch(repair, /cod_enabled|upi_on_delivery_enabled/i);
  assert.match(repair, /o\.status = 'READY'[\s\S]*ofd\.fulfillment_status = 'ASSIGNED'[\s\S]*READY_FOR_DISPATCH/i);
  assert.match(repair, /insert into public\.order_fulfillment_events/i);
  assert.match(repair, /notify pgrst, 'reload schema'/i);

  const page = await read('app/delivery/page.tsx');
  assert.match(page, /p_reference: collectMethod === 'UPI' \? reference : null/);
  assert.match(page, /UPI reference \/ UTR/);
  assert.match(page, /Assigned\. Waiting for the kitchen to mark this order READY/);
  assert.match(page, /Collected amount must exactly match the order total/);
});
