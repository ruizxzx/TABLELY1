import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Build 35 migration has unique, ordered timestamp and valid naming', async () => {
  const names = (await readdir(new URL('../supabase/migrations/', import.meta.url)))
    .filter((name) => /build35/.test(name))
    .sort();
  assert.ok(names.length >= 1, 'Build 35 migration exists');
  const versions = names.map((name) => name.match(/^(\d{14})/));
  assert.ok(versions.every(Boolean), 'Valid migration version format');
  assert.equal(versions[0][1], '20261026010000', 'Timestamp strictly after Build 34');
});

test('orders.table_id is nullable with strict fulfillment_type check constraint', async () => {
  const sql = await read('supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql');
  assert.match(sql, /alter table public\.orders alter column table_id drop not null;/i);
  assert.match(sql, /alter table public\.payment_attempts alter column table_id drop not null;/i);
  assert.match(sql, /orders_table_fulfillment_check/i);
  assert.match(sql, /fulfillment_type = 'DINE_IN' and table_id is not null/i);
  assert.match(sql, /fulfillment_type in \('PICKUP', 'DELIVERY'\) and table_id is null/i);
});

test('existing session attachment triggers safely handle null table_id without throwing', async () => {
  const sql = await read('supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql');
  assert.match(sql, /create or replace function public\.build17_attach_order_session\(\)/i);
  assert.match(sql, /if new\.table_id is null then\s+new\.received_at := coalesce\(new\.received_at, now\(\)\);\s+return new;\s+end if;/i);
  assert.match(sql, /create or replace function public\.build17_orders_sync_table_trigger\(\)/i);
  assert.match(sql, /if old\.table_id is not null then/i);
  assert.match(sql, /if new\.table_id is not null then/i);
});

test('fulfillment schema creates ordering settings, delivery zones, details, and events with RLS', async () => {
  const sql = await read('supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql');
  assert.match(sql, /create table if not exists public\.branch_ordering_settings/i);
  assert.match(sql, /create table if not exists public\.delivery_zones/i);
  assert.match(sql, /create table if not exists public\.order_fulfillment_details/i);
  assert.match(sql, /create table if not exists public\.order_fulfillment_events/i);
  assert.match(sql, /alter table public\.branch_ordering_settings enable row level security/i);
  assert.match(sql, /alter table public\.delivery_zones enable row level security/i);
  assert.match(sql, /alter table public\.order_fulfillment_details enable row level security/i);
  assert.match(sql, /alter table public\.order_fulfillment_events enable row level security/i);
});

test('fulfillment permissions default safely off for non-owners', async () => {
  const sql = await read('supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql');
  const requiredPermissions = [
    'VIEW_ONLINE_ORDERS',
    'MANAGE_ONLINE_ORDERING',
    'MANAGE_PICKUP',
    'VIEW_DELIVERY',
    'MANAGE_DELIVERY',
    'ASSIGN_DELIVERY',
    'UPDATE_DELIVERY_STATUS',
    'COLLECT_DELIVERY_PAYMENT',
    'VIEW_DELIVERY_REPORTS',
  ];
  for (const perm of requiredPermissions) {
    assert.match(sql, new RegExp(`'${perm}'`));
  }
  assert.match(sql, /v_fulfillment text\[\] := array\[/i);
});

test('server-authoritative checkout calculation enforces prices, packaging, and delivery fees', async () => {
  const sql = await read('supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql');
  assert.match(sql, /create or replace function public\.preview_public_fulfillment_checkout/i);
  assert.match(sql, /packaging_fee numeric/i);
  assert.match(sql, /delivery_fee numeric/i);
  assert.match(sql, /v_snapshot := public\.build16_calculate_cart\(p_branch_id, p_items\);/i);
  assert.match(sql, /v_subtotal := round\(coalesce\(\(select sum\(\(x->>'line_total'\)::numeric\)/i);
  assert.match(sql, /grant execute on function public\.preview_public_fulfillment_checkout/i);
});

test('order creation generates pickup code or OTP and links tracking token', async () => {
  const sql = await read('supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql');
  assert.match(sql, /create or replace function public\.create_public_fulfillment_order/i);
  assert.match(sql, /encode\(extensions\.gen_random_bytes\(16\), 'hex'\)/i);
  assert.match(sql, /v_pickup_code := lpad\(floor\(random\(\) \* 9000 \+ 1000\)::text, 4, '0'\);/i);
  assert.match(sql, /v_delivery_otp := lpad\(floor\(random\(\) \* 9000 \+ 1000\)::text, 4, '0'\);/i);
});

test('public order tracking redacts internal staff notes and hides private payment credentials', async () => {
  const sql = await read('supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql');
  assert.match(sql, /create or replace function public\.get_public_fulfillment_order/i);
  assert.match(sql, /grant execute on function public\.get_public_fulfillment_order\(text\) to anon, authenticated;/i);
  assert.doesNotMatch(sql, /select.*api_key.*from.*get_public_fulfillment_order/i);
});

test('delivery and pickup handoff RPCs enforce staff permissions and OTP/code validation', async () => {
  const sql = await read('supabase/migrations/20261026010000_build35_1_fulfillment_foundation.sql');
  assert.match(sql, /create or replace function public\.fulfillment_assign_rider/i);
  assert.match(sql, /create or replace function public\.fulfillment_dispatch_delivery/i);
  assert.match(sql, /create or replace function public\.fulfillment_confirm_delivered/i);
  assert.match(sql, /create or replace function public\.fulfillment_confirm_pickup/i);
  assert.match(sql, /create or replace function public\.fulfillment_record_failed_delivery/i);
  assert.match(sql, /create or replace function public\.fulfillment_collect_payment/i);
  assert.match(sql, /Invalid delivery OTP entered/i);
  assert.match(sql, /Invalid pickup code entered/i);
});

test('StudioShell contains delivery workspace and online ordering navigation', async () => {
  const shell = await read('components/StudioShell.tsx');
  assert.match(shell, /href: '\/delivery'/);
  assert.match(shell, /'\/delivery': 'VIEW_DELIVERY'/);
  assert.match(shell, /prefix: '\/settings\/online-ordering'/);
});

test('customer client library provides storefront queries, checkout preview, and cart helpers', async () => {
  const lib = await read('lib/customer.ts');
  assert.match(lib, /getPublicStorefrontContext/);
  assert.match(lib, /getPublicMenuForBranch/);
  assert.match(lib, /previewPublicFulfillmentCheckout/);
  assert.match(lib, /createPublicFulfillmentOrder/);
  assert.match(lib, /getPublicFulfillmentOrder/);
  assert.match(lib, /readFulfillmentCart/);
  assert.match(lib, /saveFulfillmentCart/);
  assert.match(lib, /clearFulfillmentCart/);
});

test('all required storefront, checkout, tracking, dispatch, rider, and settings pages exist', async () => {
  const files = [
    'app/r/[restaurant]/order/page.tsx',
    'app/r/[restaurant]/order/[branch]/page.tsx',
    'app/r/[restaurant]/order/checkout/page.tsx',
    'app/r/[restaurant]/order/track/[token]/page.tsx',
    'app/r/storefront.css',
    'components/customer/StorefrontClient.tsx',
    'components/customer/StorefrontCheckoutClient.tsx',
    'components/customer/StorefrontTrackClient.tsx',
    'app/settings/online-ordering/page.tsx',
    'app/delivery/page.tsx',
    'app/delivery/my-orders/page.tsx',
  ];
  for (const f of files) {
    const content = await read(f);
    assert.ok(content.length > 0, `${f} is populated`);
  }
});

test('orders and kitchen screens display pickup and delivery channels without requiring table_id', async () => {
  const orders = await read('app/orders/page.tsx');
  const kitchen = await read('app/kitchen/page.tsx');
  assert.match(orders, /o\.fulfillment_type==='PICKUP'\?'Pickup':o\.fulfillment_type==='DELIVERY'\?'Delivery'/);
  assert.match(orders, /setFulfillmentFilter/);
  assert.match(kitchen, /o\.fulfillment_type==='PICKUP'\?'Pickup':o\.fulfillment_type==='DELIVERY'\?'Delivery'/);
  assert.match(kitchen, /table_id:string\|null/);
});
