import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('mobile notifications render outside the sticky header with a dismissible full-height panel', async () => {
  const component = await read('components/RealtimeNotificationCenter.tsx');
  const styles = await read('app/premium.css');

  assert.match(component, /createPortal\(<><div className="notification-mobile-scrim"/);
  assert.match(component, /aria-label="Close notifications"/);
  assert.match(component, /aria-label="Mark all notifications read"/);
  assert.match(styles, /\.notification-popover \{[\s\S]*?position: fixed;[\s\S]*?z-index: 151;/);
  assert.match(styles, /\.notification-mobile-scrim \{[\s\S]*?z-index: 149;/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.notification-popover \{[\s\S]*?bottom: calc\(62px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.notification-list \{\s*max-height: none;/);
  assert.match(styles, /\.notification-entry \{[\s\S]*?min-height: 76px;/);
});

test('mobile chat switches between inbox and full-width conversation thread', async () => {
  const component = await read('components/customer/CustomerChatInbox.tsx');
  const styles = await read('components/customer/CustomerChatInbox.module.css');

  assert.match(component, /createPortal\([\s\S]*?document\.body/);
  assert.match(component, /data-mobile-view=\{mobileThreadOpen \? 'thread' : 'list'\}/);
  assert.match(component, /aria-label="Back to conversations"/);
  assert.match(component, /setMobileThreadOpen\(true\); void loadConversation\(conversation\.id\)/);
  assert.match(styles, /\.body\[data-mobile-view="list"\] \.thread,\s*\.body\[data-mobile-view="thread"\] \.list \{\s*display: none;/);
  assert.match(styles, /bottom: calc\(62px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(styles, /\.reply textarea \{[\s\S]*?font-size: 16px;/);
});
