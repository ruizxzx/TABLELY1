import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('central AI router supports provider protocols, bounded routing and sanitized usage records', async () => {
  const service = await read('lib/ai-management.ts');

  assert.match(service, /provider\.protocol==='openai'/);
  assert.match(service, /provider\.protocol==='gemini'/);
  assert.match(service, /url=`\$\{base\}\/messages`/);
  assert.match(service, /response_format:\{type:'json_object'\}/);
  assert.match(service, /responseMimeType:'application\/json'/);
  assert.match(service, /headers\['x-api-key'\]=key/);
  assert.match(service, /eq\('enabled',true\)\.eq\('approved',true\)/);
  assert.match(service, /mode==='image'&&!model\.capabilities\?\.image/);
  assert.match(service, /attempt<=provider\.retry_limit/);
  assert.match(service, /fallbackEligible\(lastCategory\)/);
  assert.match(service, /estimated_cost:cost/);
  assert.match(service, /succeeded:false,error_category:lastCategory/);
  assert.doesNotMatch(service, /insert\(\{[^}]*prompt:/);
});

test('menu import AI validates and normalizes output without weakening non-AI file paths', async () => {
  const parser = await read('lib/menu-import-parser.ts');
  const importTests = await read('tests/build28-menu-import.test.mjs');

  assert.match(parser, /hasDatabaseAiRoute\(\)[\s\S]*?executeMenuExtraction/);
  assert.match(parser, /extractLegacyWithAi/);
  assert.match(parser, /validateMenuImportDrafts/);
  assert.match(parser, /parseCsv|parseCSV|csv/i);
  assert.match(parser, /parseXlsx|parseWorkbook|spreadsheet/i);
  assert.match(parser, /fallback|legacy/i);
  assert.match(importTests, /AI photo extraction uses the current default model/);
  assert.match(importTests, /globalThis\.fetch = async/);
  assert.match(importTests, /globalThis\.fetch = originalFetch/);
  assert.match(importTests, /does not call a real provider|test-only-key/);
});

test('menu translation is branch-authorized, bounded, ID-validated and persisted for reuse', async () => {
  const route = await read('app/api/menu/translations/route.ts');
  const service = await read('lib/ai-management.ts');
  const customerRoute = await read('app/api/customer/menu-translations/route.ts');

  assert.match(route, /resolveServerRestaurantAccess\(\{ branchId: parsed\.data\.branchId, permission: 'MENU_MANAGEMENT' \}\)/);
  assert.match(route, /refreshAll: z\.boolean\(\)\.optional\(\)\.default\(false\)/);
  assert.match(route, /cursor: z\.number\(\)\.int\(\)\.nonnegative\(\)/);
  assert.match(route, /slice\(cursor, cursor \+ 40\)/);
  assert.match(route, /selected for translation does not belong to this branch/);
  assert.match(route, /allowed = new Set\(batches\[entity\]\.map\(\(record\) => record\.id\)\)/);
  assert.match(route, /incomplete translation\. This batch was not saved/);
  assert.match(route, /upsert\(rows, \{[\s\S]*?ignoreDuplicates: !parsed\.data\.refreshAll/);
  assert.match(route, /categories: \[\], subcategories: \[\], items: \[\], variants: \[\], modifierGroups: \[\], modifiers: \[\]/);
  assert.match(service, /executeConfiguredTextFeature\('menu_translation'[\s\S]*?'menu_extraction'\)/);
  assert.match(customerRoute, /status: 410/);
});

test('staff assistant enforces authenticated branch and analytics authorization', async () => {
  const route = await read('app/api/restaurant-ai/route.ts');
  const auth = await read('lib/server-restaurant.ts');
  const assistant = await read('lib/ai-management.ts');

  assert.match(route, /branchId: z\.string\(\)\.uuid\(\)/);
  assert.match(route, /mode: z\.enum\(\['support', 'analytics'\]\)/);
  assert.match(route, /resolveServerRestaurantAccess\(\{[\s\S]*?permission: 'ANALYTICS'/);
  assert.match(route, /get_current_entitlements/);
  assert.match(route, /get_build12_analytics/);
  assert.match(route, /get_branch_analytics/);
  assert.match(route, /restaurantAiAllowedRoutes as readonly string\[\]/);
  assert.match(route, /slice\(0, 3\)/);
  assert.match(route, /status: limited \? 429 : 503/);
  assert.match(auth, /function resolveServerRestaurantAccess/);
  assert.match(assistant, /p_organization_id: options\.organizationId/);
  assert.match(assistant, /p_branch_id: options\.branchId/);
});

test('customer assistant derives tenant data from QR server context and whitelists recommendations', async () => {
  const route = await read('app/api/customer/ai-suggestions/route.ts');
  const service = await read('lib/ai-management.ts');
  const migration = await read('supabase/migrations/20261025020000_restaurant_ai_assistant.sql');

  assert.match(route, /tableCode: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(64\)/);
  assert.match(route, /rpc\('get_restaurant_ai_public_context'/);
  assert.match(route, /p_table_code: parsed\.data\.tableCode/);
  assert.doesNotMatch(route, /parsed\.data\.organizationId|parsed\.data\.branchId/);
  assert.match(route, /const allowedIds = new Set\(allowedItems\.map/);
  assert.match(route, /allowedIds\.has\(id\)/);
  assert.match(route, /slice\(0, 3\)/);
  assert.match(service, /Do not claim dish-level ratings/);
  assert.match(service, /Never invent dishes, ingredients, dietary facts, availability, or prices/);
  assert.match(migration, /having count\(distinct o2\.id\) >= 3/);
  assert.match(migration, /limit 40/);
  assert.match(migration, /grant execute on function public\.get_restaurant_ai_public_context\(text\) to service_role/);
});

test('assistant request quota is atomic and shared at restaurant organization scope', async () => {
  const migration = await read('supabase/migrations/20261025020000_restaurant_ai_assistant.sql');
  const service = await read('lib/ai-management.ts');
  const staffRoute = await read('app/api/restaurant-ai/route.ts');
  const customerRoute = await read('app/api/customer/ai-suggestions/route.ts');

  assert.match(migration, /primary key \(organization_id, usage_date\)/);
  assert.match(migration, /on conflict \(organization_id, usage_date\) do update/);
  assert.match(migration, /daily_usage\.request_count < 30/);
  assert.match(migration, /reserved_output_tokens \+ p_reserved_tokens <= 12000/);
  assert.match(migration, /p_reserved_tokens > 400/);
  assert.match(migration, /b\.organization_id = p_organization_id/);
  assert.match(migration, /grant execute on function public\.reserve_restaurant_ai_request[\s\S]*to service_role/);
  assert.match(service, /p_reserved_tokens: assistantOutputTokens/);
  assert.match(staffRoute, /executeRestaurantAssistant/);
  assert.match(customerRoute, /executeRestaurantAssistant/);
});

test('AI administrator mutations validate platform admin and never return encrypted credentials', async () => {
  const route = await read('app/api/admin/ai-management/route.ts');
  const migration = await read('supabase/migrations/20261024000500_build28_6_ai_provider_management.sql');

  assert.match(route, /auth\.getUser\(\)/);
  assert.match(route, /rpc\('is_platform_admin'\)/);
  assert.match(route, /function safeProvider[\s\S]*?credential_encrypted/);
  assert.match(route, /encryptSecret\(p\.api_key\.trim\(\)\)/);
  assert.match(route, /validateAiBaseUrl\(p\.base_url\)/);
  assert.match(route, /body\.action==='save_model'/);
  assert.match(route, /body\.action==='save_route'/);
  assert.match(route, /body\.action==='save_settings'/);
  assert.match(route, /body\.action==='discover'\|\|body\.action==='test'/);
  assert.match(migration, /alter table public\.platform_ai_providers enable row level security/i);
  assert.match(migration, /revoke all on public\.platform_ai_providers[\s\S]*from anon, authenticated/i);
  assert.doesNotMatch(route, /console\.(log|error).*credential_encrypted/i);
});

test('chat UI exposes staff support/analytics and customer support/suggestions as separate modes', async () => {
  const staffPopup = await read('components/ai/RestaurantAiChatbot.tsx');
  const sharedChat = await read('components/ai/AssistantChat.tsx');
  const customerChat = await read('components/customer/CustomerRestaurantChat.tsx');
  const shell = await read('components/StudioShell.tsx');

  assert.match(shell, /RestaurantAiChatbot/);
  assert.match(staffPopup, /Support/);
  assert.match(staffPopup, /Analytics/);
  assert.match(sharedChat, /api\/restaurant-ai/);
  assert.match(sharedChat, /api\/customer\/ai-suggestions/);
  assert.match(customerChat, /Chat with restaurant/);
  assert.match(customerChat, /Ask AI suggestions/);
  assert.match(sharedChat, /history: messages\.slice\(-4\)/);
});
