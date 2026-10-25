import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('Build 28.6 migration locks AI configuration behind RLS and removes browser-role grants',async()=>{
 const sql=await read('supabase/migrations/20261024000500_build28_6_ai_provider_management.sql');
 for(const table of ['platform_ai_providers','platform_ai_models','platform_ai_routes','platform_ai_settings','platform_ai_usage_logs'])assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`,'i'));
 assert.match(sql,/revoke all on public\.platform_ai_providers[\s\S]*?from anon, authenticated/i);
 assert.match(sql,/credential_encrypted text/i);
 assert.match(sql,/input_price_per_million numeric/i);
});

test('AI admin endpoint guards reads and writes with platform administrator authorization',async()=>{
 const route=await read('app/api/admin/ai-management/route.ts');
 assert.match(route,/auth\.getUser\(\)/);
 assert.match(route,/rpc\('is_platform_admin'\)/);
 assert.match(route,/function safeProvider[\s\S]*?credential_encrypted/);
 assert.match(route,/encryptSecret\(p\.api_key\.trim\(\)\)/);
 assert.doesNotMatch(route,/console\.(log|error).*api_key/i);
});

test('menu extraction uses database routing and keeps legacy env as fallback only',async()=>{
 const parser=await read('lib/menu-import-parser.ts'),service=await read('lib/ai-management.ts');
 assert.match(parser,/hasDatabaseAiRoute\(\)[\s\S]*?executeMenuExtraction/);
 assert.match(parser,/extractLegacyWithAi/);
 assert.match(service,/provider\.protocol==='gemini'/);
 assert.match(service,/url=`\$\{base\}\/messages`/);
 assert.match(service,/headers\['x-api-key'\]=key/);
 assert.match(service,/fallback_index:index/);
 assert.match(service,/estimated_cost:cost/);
});

test('menu translation shares the menu extraction route and logs usage under translation',async()=>{
 const service=await read('lib/ai-management.ts'),route=await read('app/api/menu/translations/route.ts'),customerRoute=await read('app/api/customer/menu-translations/route.ts');
 assert.match(service,/executeConfiguredTextFeature\('menu_translation'[\s\S]*?'menu_extraction'\)/);
 assert.match(service,/eq\('feature_key',routingFeatureKey\)/);
 assert.match(service,/feature_key:featureKey/);
 assert.match(service,/\.in\('feature_key',usageFeatureKeys\)/);
 assert.match(service,/Translate the provided restaurant menu text/);
 assert.match(route,/resolveServerRestaurantAccess/);
 assert.match(route,/restaurant_language_settings/);
 assert.match(route,/executeMenuTranslation/);
 assert.match(route,/ignoreDuplicates: !parsed\.data\.refreshAll/);
 assert.match(route,/refreshAll/);
 assert.match(route,/nextCursor/);
 assert.match(customerRoute,/status: 410/);
 const adminPage=await read('app/admin/ai-management/page.tsx');
 assert.match(adminPage,/menu_translation/);
 assert.match(adminPage,/menu translations in Hindi and Bengali use the Menu extraction route/i);
});

test('custom AI endpoints reject cleartext HTTP and private IP targets',async()=>{
 const service=await read('lib/ai-management.ts');
 assert.match(service,/Provider endpoints must use HTTPS/);
 assert.match(service,/private IP address/);
});

test('AI management exposes a short setup flow and keeps expert controls expandable',async()=>{
 const page=await read('app/admin/ai-management/page.tsx');
 assert.match(page,/1\. Connect an AI provider/);
 assert.match(page,/2\. Add a model/);
 assert.match(page,/3\. Choose what AI can do/);
 assert.match(page,/Advanced provider settings/);
 assert.match(page,/Advanced model settings/);
 assert.match(page,/Fallbacks and limits/);
 assert.match(page,/<details/);
 assert.match(page,/Customer menu translations in Hindi and Bengali use the Menu extraction route/);
});

test('restaurant assistant reserves organization-scoped AI usage and selects configured routes',async()=>{
 const service=await read('lib/ai-management.ts');
 const staffRoute=await read('app/api/restaurant-ai/route.ts');
 const customerRoute=await read('app/api/customer/ai-suggestions/route.ts');
 const migration=await read('supabase/migrations/20261025020000_restaurant_ai_assistant.sql');
 assert.match(service,/reserve_restaurant_ai_request/);
 assert.match(service,/restaurant_analytics/);
 assert.match(staffRoute,/resolveServerRestaurantAccess/);
 assert.match(staffRoute,/permission: 'ANALYTICS'/);
 assert.match(staffRoute,/get_build12_analytics/);
 assert.match(staffRoute,/restaurantAiAllowedRoutes/);
 assert.match(customerRoute,/get_restaurant_ai_public_context/);
 assert.match(customerRoute,/recommendedItemIds/);
 assert.match(migration,/daily_usage\.request_count < 30/);
 assert.match(migration,/reserved_output_tokens \+ p_reserved_tokens <= 12000/);
 assert.match(migration,/having count\(distinct o2\.id\) >= 3/);
 assert.match(migration,/revoke all on function public\.reserve_restaurant_ai_request[\s\S]*?to service_role/);
});
