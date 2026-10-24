import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('restaurant live chat reuses the visit conversation and follows the exact table session lifecycle', async () => {
  const migration = await read('supabase/migrations/20261024110000_build317_live_session_customer_chat.sql');
  const customerOpen = await read('app/api/customer/conversations/route.ts');
  const customerDetail = await read('app/api/customer/conversations/[conversationId]/route.ts');

  assert.match(migration, /add column if not exists table_session_id uuid references public\.table_sessions/);
  assert.match(migration, /visit_token_hash = s\.session_token_hash/);
  assert.match(migration, /after insert or update of table_session_id on public\.orders/);
  assert.match(migration, /c\.visit_token_hash = v_session\.session_token_hash/);
  assert.match(migration, /new\.status = 'CLOSED'[\s\S]*set status = 'CLOSED'[\s\S]*where table_session_id = new\.id/);
  assert.match(migration, /and s\.role in \('OWNER', 'MANAGER', 'WAITER'\)/);
  assert.match(migration, /limit 1\s+for update/);
  assert.match(migration, /unread_customer_count = case[\s\S]*new\.sender_type = 'CUSTOMER'[\s\S]*else 0/);
  assert.match(migration, /c\.status = 'OPEN'[\s\S]*c\.expires_at > now\(\)/);
  assert.match(customerOpen, /error\?\.code === 'P0001'/);
  assert.match(customerDetail, /conversation\.status === 'CLOSED'/);
});

test('live restaurant chat is branch-authorized, unread-aware, and integrated into Orders', async () => {
  const inboxApi = await read('app/api/customer-messages/route.ts');
  const readApi = await read('app/api/customer-messages/[conversationId]/read/route.ts');
  const popup = await read('components/customer/CustomerChatInbox.tsx');
  const shell = await read('components/StudioShell.tsx');
  const orders = await read('app/orders/page.tsx');

  assert.match(inboxApi, /resolveServerRestaurantAccess/);
  assert.match(inboxApi, /\.eq\('branch_id', access\.branchId\)/);
  assert.match(inboxApi, /\.eq\('status', 'OPEN'\)/);
  assert.match(inboxApi, /table_session_id/);
  assert.match(readApi, /resolveServerRestaurantAccess/);
  assert.match(readApi, /unread_customer_count: 0/);
  assert.match(popup, /tablely:customer-inbox:\$\{branchId\}/);
  assert.match(popup, /config: \{ private: true \}/);
  assert.match(popup, /CONVERSATION_UPDATED/);
  assert.match(popup, /showBrowserOrderNotification/);
  assert.match(popup, /aria-label=\{`Customer messages/);
  assert.match(shell, /CustomerChatInbox/);
  assert.match(orders, /ops-chat-alert/);
  assert.match(orders, /o\.table_session_id!==null&&chat\.unread_customer_count>0&&chat\.table_session_id===o\.table_session_id/);
  assert.match(orders, /tablely-open-customer-chat/);
  assert.match(popup, /inboxRequestRef/);
  assert.match(popup, /conversationRequestRef/);
});
