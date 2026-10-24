import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getOrderDateBounds } from '../lib/order-date-range.ts';

test('order date presets use local calendar-day boundaries', () => {
  const now = new Date(2026, 9, 24, 15, 22);
  const today = getOrderDateBounds({ preset: 'today' }, now);
  const week = getOrderDateBounds({ preset: '7days' }, now);
  const month = getOrderDateBounds({ preset: '30days' }, now);

  assert.equal(today.from, new Date(2026, 9, 24).toISOString());
  assert.equal(today.toExclusive, new Date(2026, 9, 25).toISOString());
  assert.equal(week.from, new Date(2026, 9, 18).toISOString());
  assert.equal(week.toExclusive, today.toExclusive);
  assert.equal(month.from, new Date(2026, 8, 25).toISOString());
  assert.equal(month.toExclusive, today.toExclusive);
});

test('custom order date ranges include the selected end date and reject invalid ranges', () => {
  const range = getOrderDateBounds({ preset: 'custom', from: '2026-10-01', to: '2026-10-03' });

  assert.equal(range.from, new Date(2026, 9, 1).toISOString());
  assert.equal(range.toExclusive, new Date(2026, 9, 4).toISOString());
  assert.equal(getOrderDateBounds({ preset: 'custom', from: '2026-10-04', to: '2026-10-03' }), null);
  assert.equal(getOrderDateBounds({ preset: 'custom', from: '2026-02-30', to: '2026-03-01' }), null);
});

test('Orders applies date filters to paginated server queries and shows each order timestamp', async () => {
  const page = await readFile(new URL('../app/orders/page.tsx', import.meta.url), 'utf8');

  assert.match(page, /useState<OrderDatePreset\|'custom'>\('today'\)/);
  assert.match(page, /\.gte\('created_at',bounds\.from\)\.lt\('created_at',bounds\.toExclusive\)/);
  assert.match(page, /\.range\(orderOffset,orderOffset\+199\)/);
  assert.match(page, /\.range\(itemOffset,itemOffset\+199\)/);
  assert.match(page, /Last 7 days/);
  assert.match(page, /Last 30 days/);
  assert.match(page, /Custom range/);
  assert.match(page, /<time dateTime=\{o\.created_at\}/);
});
