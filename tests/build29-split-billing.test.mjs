import test from 'node:test';
import assert from 'node:assert/strict';
import { allocationsMatchTotal, equalSplitPaise, parseRupeesToPaise } from '../lib/split-billing.mjs';

test('decimal rupees parse to paise without rounding', () => {
  assert.equal(parseRupeesToPaise('1200'), 120000);
  assert.equal(parseRupeesToPaise('9.9'), 990);
  assert.equal(parseRupeesToPaise('0.01'), 1);
  assert.equal(parseRupeesToPaise('1.001'), null);
  assert.equal(parseRupeesToPaise('-1.00'), null);
});

test('equal splits distribute each remainder paise exactly once', () => {
  assert.deepEqual(equalSplitPaise(1000, 3), [334, 333, 333]);
  assert.deepEqual(equalSplitPaise(120000, 4), [30000, 30000, 30000, 30000]);
  assert.throws(() => equalSplitPaise(0, 2));
});

test('allocations must be positive and match the complete bill total', () => {
  assert.equal(allocationsMatchTotal([334, 333, 333], 1000), true);
  assert.equal(allocationsMatchTotal([500, 400], 1000), false);
  assert.equal(allocationsMatchTotal([1000, 0], 1000), false);
});
