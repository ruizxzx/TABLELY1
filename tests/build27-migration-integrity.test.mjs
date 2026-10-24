import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = join(root, 'supabase', 'migrations');
const build27Migration = await readFile(join(migrationDir, '202610240001_build27_stability_foundation.sql'), 'utf8');

test('Supabase migration numeric versions are unique and valid', async () => {
  const files = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql'));
  const versions = new Map();
  for (const file of files) {
    const match = file.match(/^(\d+)_.+\.sql$/);
    assert.ok(match, `migration must have a numeric version prefix: ${file}`);
    const version = match[1];
    const entries = versions.get(version) ?? [];
    entries.push(file);
    versions.set(version, entries);

    if (version.length === 12 || version.length === 14) {
      const date = new Date(Date.UTC(
        Number(version.slice(0, 4)), Number(version.slice(4, 6)) - 1, Number(version.slice(6, 8)),
        Number(version.slice(8, 10)), Number(version.slice(10, 12)), version.length === 14 ? Number(version.slice(12, 14)) : 0,
      ));
      const normalized = date.toISOString().replace(/[-:TZ.]/g, '').slice(0, version.length);
      assert.equal(normalized, version, `invalid migration timestamp: ${file}`);
    }
  }
  const duplicateVersions = [...versions.entries()].filter(([, names]) => names.length > 1);
  assert.deepEqual(duplicateVersions, []);
});

test('historical migration replay files are idempotent at repository level', async () => {
  const brand = await readFile(join(migrationDir, '202610240002_global_brand_logo_reconciliation.sql'), 'utf8');
  const chargeReplay = await readFile(join(migrationDir, '202610240003_fix_cross_restaurant_checkout_charges_reconciliation.sql'), 'utf8');
  assert.match(brand, /create table if not exists public\.platform_brand_settings/i);
  assert.match(brand, /on conflict \(id\) do nothing/i);
  assert.match(brand, /drop policy if exists/i);
  assert.match(brand, /on conflict \(id\) do update/i);
  assert.match(chargeReplay, /if position\(v_old in v_sql\) > 0 then/i);
  assert.match(chargeReplay, /execute v_sql/i);
});

test('Build 27 migration is transaction-wrapped and uses pinned search paths', () => {
  assert.match(build27Migration.trimStart(), /^--[\s\S]*?begin;/i);
  assert.match(build27Migration.trimEnd(), /commit;\s*$/i);
  const securityDefinerFunctions = [...build27Migration.matchAll(/create or replace function[\s\S]*?security definer[\s\S]*?as \$\$/gi)];
  assert.ok(securityDefinerFunctions.length >= 6, 'expected the Build 27 SECURITY DEFINER functions to be present');
  for (const match of securityDefinerFunctions) {
    assert.match(match[0], /set search_path\s*=\s*pg_catalog\s*,\s*public/i);
  }
});

test('dashboard metrics enforce authenticated branch analytics permission', () => {
  const start = build27Migration.indexOf('create or replace function public.get_branch_dashboard_metrics');
  const end = build27Migration.indexOf('create or replace function public.finalize_legacy_razorpay_order');
  assert.ok(start >= 0 && end > start);
  const fn = build27Migration.slice(start, end);
  assert.match(fn, /auth\.uid\(\) is null/i);
  assert.match(fn, /current_user_has_permission_for_branch\(p_branch_id,\s*'ANALYTICS'\)/i);
  assert.match(fn, /order_business_date/i);
  assert.match(fn, /payment_transactions/i);
  assert.match(fn, /when so\.payment_status in \('PAID', 'REFUNDED'\) then so\.total/i);
  assert.doesNotMatch(fn, /transaction_count\s*=\s*0 and so\.payment_status/i);
});

test('legacy payment finalization locks and validates the order before atomic settlement', () => {
  const start = build27Migration.indexOf('create or replace function public.finalize_legacy_razorpay_order');
  const end = build27Migration.indexOf('-- Serialize concurrent Razorpay order creation', start);
  assert.ok(start >= 0 && end > start);
  const fn = build27Migration.slice(start, end);
  assert.match(fn, /for update/i);
  assert.match(fn, /tracking_token is distinct from/i);
  assert.match(fn, /unsupported payment currency/i);
  assert.match(fn, /payment amount mismatch/i);
  assert.match(fn, /on conflict \(provider_order_id\) where provider_order_id is not null/i);
  assert.match(fn, /set payment_status = 'PAID'/i);
  assert.match(fn, /grant execute[\s\S]*to service_role/i);
});

test('Razorpay order creation leases use row locks and fencing tokens', () => {
  assert.match(build27Migration, /claim_payment_attempt_razorpay_order[\s\S]*?for update[\s\S]*?razorpay_order_creation_token/i);
  assert.match(build27Migration, /set_payment_attempt_razorpay_order[\s\S]*?razorpay_order_creation_token is distinct from p_claim_token/i);
  assert.match(build27Migration, /claim_legacy_razorpay_order[\s\S]*?for update[\s\S]*?razorpay_order_creation_token/i);
  assert.match(build27Migration, /set_legacy_razorpay_order[\s\S]*?razorpay_order_creation_token = p_claim_token/i);
});

test('browser roles cannot directly access payment transaction records', () => {
  assert.match(build27Migration, /alter table public\.payment_transactions enable row level security/i);
  assert.match(build27Migration, /revoke all on table public\.payment_transactions from public, anon, authenticated/i);
  assert.match(build27Migration, /grant all on table public\.payment_transactions to service_role/i);
});

test('legacy and payment-attempt order creation always pass through locked claim RPCs', async () => {
  const route = await readFile(join(root, 'app', 'api', 'payments', 'create', 'route.ts'), 'utf8');
  const attemptClaim = route.indexOf("admin.rpc('claim_payment_attempt_razorpay_order'");
  const legacyClaim = route.indexOf("admin.rpc('claim_legacy_razorpay_order'");
  const providerCreate = route.indexOf('await createRazorpayOrder(');
  assert.ok(attemptClaim > 0 && legacyClaim > 0 && providerCreate > attemptClaim && providerCreate > legacyClaim);
  assert.doesNotMatch(route, /if\s*\(razorpayOrderId\)\s*\{\s*return/);
});

test('payment verification is rate-limited before contacting Razorpay', async () => {
  const route = await readFile(join(root, 'app', 'api', 'payments', 'verify', 'route.ts'), 'utf8');
  const rateLimit = route.indexOf("p_key: `payment-verify:${ip}`");
  const providerFetch = route.indexOf('await fetchRazorpayPayment(');
  assert.ok(rateLimit > 0 && providerFetch > rateLimit);
  assert.match(route, /p_window_seconds:\s*60/);
  assert.match(route, /p_max_requests:\s*30/);
  assert.match(route, /status:\s*429/);
});
