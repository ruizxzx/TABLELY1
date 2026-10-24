import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Build 31.6 support records are private, indexed, and auditable', async () => {
  const sql = await read('supabase/migrations/20261024080000_build316_platform_support.sql');
  for (const table of ['support_tickets', 'support_ticket_messages', 'support_internal_notes', 'support_audit_logs']) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.%I from anon, authenticated, public/);
  assert.match(sql, /grant execute on function public\.create_restaurant_support_ticket[\s\S]*to service_role/);
  assert.match(sql, /TBL-SUP-/);
  assert.match(sql, /MESSAGE_SENT/);
  assert.match(sql, /INTERNAL_NOTE_ADDED/);
});

test('restaurant ticket routes scope records to authenticated organization and authorized branches', async () => {
  const collection = await read('app/api/support/tickets/route.ts');
  const detail = await read('app/api/support/tickets/[ticketId]/route.ts');
  assert.match(collection, /resolveServerRestaurantAccess/);
  assert.match(collection, /\.eq\('organization_id', access\.context\.organization\.id\)/);
  assert.match(collection, /\.in\('branch_id', branchIds\)/);
  assert.match(collection, /context\.staff\.role/);
  assert.match(collection, /create_restaurant_support_ticket/);
  assert.match(detail, /\.eq\('organization_id', access\.context\.organization\.id\)/);
  assert.match(detail, /\.in\('branch_id', branchIds\)/);
  assert.doesNotMatch(detail, /support_internal_notes/);
});

test('platform support routes require platform-admin identity and isolate internal notes', async () => {
  const auth = await read('lib/support-admin.ts');
  const detail = await read('app/api/admin/support/tickets/[ticketId]/route.ts');
  assert.match(auth, /auth\.getUser\(\)/);
  assert.match(auth, /rpc\('is_platform_admin'\)/);
  assert.match(detail, /support_internal_notes/);
  assert.match(detail, /author_type: 'PLATFORM'/);
  assert.match(detail, /WAITING_FOR_RESTAURANT/);
  assert.match(detail, /PRIORITY_CHANGED|prioritySchema/);
});

test('restaurant and platform users receive separate support interfaces', async () => {
  const restaurantPage = await read('app/support/page.tsx');
  const platformPage = await read('app/admin/support/page.tsx');
  const restaurantNavigation = await read('components/StudioShell.tsx');
  const adminNavigation = await read('app/admin/page.tsx');
  assert.match(restaurantPage, /\/api\/support\/tickets/);
  assert.match(platformPage, /\/api\/admin\/support\/tickets/);
  assert.match(platformPage, /Private internal note/);
  assert.match(restaurantNavigation, /href: '\/support'/);
  assert.match(adminNavigation, /href="\/admin\/support"/);
});

test('customer chat is visit-scoped, private, durable, and does not create table sessions', async () => {
  const migration = await read('supabase/migrations/20261024090000_build316_customer_restaurant_chat.sql');
  const customerApi = await read('app/api/customer/conversations/route.ts');
  const detailApi = await read('app/api/customer/conversations/[conversationId]/route.ts');
  const customerUi = await read('components/customer/CustomerRestaurantChat.tsx');

  assert.match(migration, /create table if not exists public\.customer_restaurant_conversations/);
  assert.match(migration, /create table if not exists public\.customer_restaurant_messages/);
  assert.match(migration, /visit_token_hash/);
  assert.match(migration, /channel_key/);
  assert.match(migration, /realtime\.send\([\s\S]*'tablely:customer-conversation:'/);
  assert.match(migration, /realtime\.send\([\s\S]*'tablely:customer-inbox:'/);
  assert.match(migration, /for select to anon, authenticated/);
  assert.match(migration, /public\.can_access_customer_chat_topic\(realtime\.topic\(\)\)/);
  assert.match(customerApi, /open_customer_restaurant_conversation/);
  assert.match(customerApi, /hashCustomerVisitToken/);
  assert.match(detailApi, /\.eq\('visit_token_hash', hashCustomerVisitToken/);
  assert.match(detailApi, /client_message_id/);
  assert.match(customerUi, /config: \{ private: true \}/);
  assert.match(customerUi, /catchUp/);
  assert.doesNotMatch(customerApi, /table_sessions|open_pay_later_session|create_order/);
});

test('restaurant customer-message inbox and replies are scoped to the resolved branch', async () => {
  const inbox = await read('app/api/customer-messages/route.ts');
  const detail = await read('app/api/customer-messages/[conversationId]/route.ts');
  const page = await read('app/customer-messages/page.tsx');
  const navigation = await read('components/StudioShell.tsx');

  assert.match(inbox, /resolveServerRestaurantAccess/);
  assert.match(inbox, /resolveServerRestaurantAccess\(\{ branchId \}\)/);
  assert.match(inbox, /\.eq\('branch_id', access\.branchId\)/);
  assert.match(detail, /resolveServerRestaurantAccess\(\{ branchId \}\)/);
  assert.match(detail, /\.eq\('branch_id', access\.branchId\)/);
  assert.match(detail, /sender_type: 'STAFF'/);
  assert.match(page, /tablely:customer-inbox:/);
  assert.match(page, /config: \{ private: true \}/);
  assert.match(navigation, /href: '\/customer-messages'/);
});
