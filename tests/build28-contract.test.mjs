import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Build 28 migration preserves old table URLs and adds stable QR IDs', async () => {
  const sql = await read('supabase/migrations/202610240004_build28_smart_onboarding_qr_menu_import.sql');
  assert.match(sql, /add column if not exists public_qr_id uuid default gen_random_uuid\(\)/i);
  assert.match(sql, /where public_qr_id is null/i);
  assert.match(sql, /create unique index if not exists tables_public_qr_id_uidx/i);
  assert.match(sql, /menu_items\s+add column if not exists is_draft/i);
  assert.match(sql, /create table if not exists public\.menu_import_jobs/i);
});

test('menu import finalization is limited to uploader or organization owner', async () => {
  const sql = await read('supabase/migrations/202610240004_build28_smart_onboarding_qr_menu_import.sql');
  assert.match(sql, /menu_import_jobs_update_authorized[\s\S]*?user_id = auth\.uid\(\) or exists/i);
  assert.match(sql, /Only the uploader or restaurant owner can finalize this import/i);
  assert.match(sql, /set status = 'COMPLETED',[\s\S]*?imported_count = v_inserted/i);
});

test('onboarding table creation is owner-only and request-idempotent', async () => {
  const sql = await read('supabase/migrations/202610240004_build28_smart_onboarding_qr_menu_import.sql');
  assert.match(sql, /create or replace function public\.create_onboarding_tables/i);
  assert.match(sql, /on conflict \(branch_id, request_id\) do nothing/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /public\.is_org_owner\(v_org_id\)/i);
});

test('public QR resolver validates identifiers and routes through legacy customer page', async () => {
  const route = await read('app/q/[publicQrId]/route.ts');
  assert.match(route, /public_qr_id/);
  assert.match(route, /table\.active/);
  assert.match(route, /branch\.is_active/);
  assert.match(route, /organization\.status !== 'ACTIVE'/);
  assert.match(route, /\/r\/\$\{encodeURIComponent\(organization\.slug\)\}\/table/);
  assert.match(route, /status: 307/);
  assert.doesNotMatch(route, /session.*insert|insert.*session/i);
});

test('Razorpay setup test does not create a charge and distinguishes webhook status', async () => {
  const route = await read('app/api/settings/payment/test/route.ts');
  assert.match(route, /api\.razorpay\.com\/v1\/orders\?count=1/);
  assert.match(route, /webhookStatus: 'NOT_TESTED'/);
  assert.match(route, /webhookConfigured/);
  assert.doesNotMatch(route, /\/v1\/payments|\/v1\/orders['"`][\s\S]*?method: 'POST'/);
});

test('menu importer keeps imports as drafts and limits uploads', async () => {
  const sql = await read('supabase/migrations/202610240004_build28_smart_onboarding_qr_menu_import.sql');
  const route = await read('app/api/menu-import/parse/route.ts');
  const commit = await read('app/api/menu-import/commit/route.ts');
  assert.match(sql, /is_available, is_draft[\s\S]*?false, true/);
  assert.match(route, /MAX_BYTES = 20 \* 1024 \* 1024/);
  assert.match(route, /\.from\('menu_import_jobs'\)/);
  assert.match(commit, /validateMenuImportDrafts/);
  assert.match(commit, /commit_menu_import_job/);
  assert.match(commit, /modifier_groups: item\.modifier_groups/);
  assert.match(sql, /menu_item_modifier_groups\(menu_item_id, modifier_group_id\)/);
  assert.match(sql, /modifier_groups_created_or_matched/);
});

test('onboarding tracks steps server-side and permits counter-only launch', async () => {
  const page = await read('app/onboarding/page.tsx');
  const progress = await read('app/api/onboarding/progress/route.ts');
  assert.match(page, /\/api\/onboarding\/progress/);
  assert.match(progress, /onboarding_progress/);
  assert.match(progress, /Complete or explicitly skip each setup step/);
  assert.match(page, /Pay at Counter/);
  assert.match(page, /Configure payments later/);
});

test('QR print templates use escaped tenant text and stable QR destinations', async () => {
  const page = await read('app/qr/page.tsx');
  assert.match(page, /\/q\/\$\{row\.public_qr_id\}/);
  assert.match(page, /function escapeHtml/);
  assert.match(page, /errorCorrectionLevel: 'H'/);
  assert.match(page, /A4/);
  assert.match(page, /A6/);
  assert.match(page, /CUSTOM/);
});


test('onboarding branch API validates business hours and IANA timezones', async () => {
  const route = await read('app/api/onboarding/branch/route.ts');
  assert.match(route, /timeSchema = z\.string\(\)\.regex/);
  assert.match(route, /businessHoursSchema = z\.object/);
  assert.match(route, /Intl\.DateTimeFormat/);
  assert.match(route, /ownerOnly: true/);
});

test('legacy XLS upload returns a clear conversion instruction', async () => {
  const route = await read('app/api/menu-import/parse/route.ts');
  assert.match(route, /Legacy binary \.xls workbooks are not supported/);
  assert.match(route, /const acceptedMime = inferred/);
});

test('onboarding menu and QR tools provide a path back to the saved setup wizard', async () => {
  const onboarding = await read('app/onboarding/page.tsx');
  const importer = await read('app/menu/import/page.tsx');
  const menu = await read('app/menu/page.tsx');
  const qr = await read('app/qr/page.tsx');
  assert.match(onboarding, /menu\/import\?from=onboarding/);
  assert.match(onboarding, /menu\?from=onboarding/);
  assert.match(onboarding, /qr\?from=onboarding/);
  assert.match(importer, /setFromOnboarding\(new URLSearchParams\(window\.location\.search\)/);
  assert.match(importer, /Back to setup/);
  assert.match(menu, /Back to setup/);
  assert.match(qr, /Back to setup/);
  assert.match(menu, /menu\/import\?from=onboarding/);
});
