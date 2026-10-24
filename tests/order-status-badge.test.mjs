import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('order status badges distinguish cancelled, completed, and rejected orders', async () => {
  const component = await read('components/StatusBadge.tsx');
  const styles = await read('app/globals.css');

  assert.match(component, /isCancelled \? CircleX/);
  assert.match(component, /isCompleted \? Check/);
  assert.match(component, /isRejected \? Ban/);
  assert.match(component, /badge-completed/);
  assert.match(component, /badge-rejected/);
  assert.match(styles, /\.badge-completed \{ background: #e7f5eb; color: #17643a; \}/);
  assert.match(styles, /\.badge-rejected \{ background: #efefec; color: #5d615c; \}/);
  assert.match(styles, /\.badge-cancelled > span \{ text-decoration: line-through;/);
});
