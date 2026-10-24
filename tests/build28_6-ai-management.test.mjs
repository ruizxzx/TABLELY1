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

test('custom AI endpoints reject cleartext HTTP and private IP targets',async()=>{
 const service=await read('lib/ai-management.ts');
 assert.match(service,/Provider endpoints must use HTTPS/);
 assert.match(service,/private IP address/);
});
