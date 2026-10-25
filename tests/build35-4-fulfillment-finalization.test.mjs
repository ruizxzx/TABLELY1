import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const migrationPath = 'supabase/migrations/20261026040000_build35_4_fulfillment_finalization.sql';
const sql = existsSync(migrationPath) ? await readFile(migrationPath, 'utf8') : '';

function functionBody(name) {
  const lower = sql.toLowerCase();
  const nameLower = name.toLowerCase();
  const starts = [
    lower.indexOf(`create or replace function public.${nameLower}`),
    lower.indexOf(`create function public.${nameLower}`),
  ].filter((value) => value >= 0);
  assert.notEqual(starts.length, 0, `Missing function ${name}`);
  const start = Math.min(...starts);
  const next = sql.indexOf('$$;', start);
  assert.notEqual(next, -1, `Function ${name} has no closing delimiter`);
  return sql.slice(start, next + 3);
}

test('Build 35.4 finalization migration is present and adds delivery retry/return transitions', () => {
  assert.equal(existsSync(migrationPath), true);
  assert.match(sql, /fulfillment_retry_delivery/i);
  assert.match(sql, /fulfillment_return_to_restaurant/i);
  assert.match(sql, /RETURNED_TO_RESTAURANT/i);
  assert.match(sql, /return_reason/i);
  assert.match(sql, /returned_at/i);
});

test('retry and return logic records structured events and keeps audit history', () => {
  const retry = functionBody('fulfillment_retry_delivery');
  const returned = functionBody('fulfillment_return_to_restaurant');
  assert.match(retry, /DELIVERY_FAILED|RETURNED_TO_RESTAURANT/i);
  assert.match(retry, /WAITING_FOR_DRIVER/i);
  assert.match(retry, /INSERT INTO public\.order_fulfillment_events/i);
  assert.match(returned, /RETURNED_TO_RESTAURANT/i);
  assert.match(returned, /return_reason/i);
});

// Ensures the public API captures a payment reference rather than relying on a voice claim alone.
test('manual collections persist a UPI reference and reasoned audit metadata', () => {
  assert.match(sql, /payment_reference/i);
  assert.match(sql, /reference_source/i);
  assert.match(sql, /UPI/i);
});
