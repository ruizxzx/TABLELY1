import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('restaurant settings expose a shareable customer ordering link for the active branch', async () => {
  const settings = await read('app/settings/page.tsx');

  assert.match(settings, /Customer ordering link|Share restaurant link|Restaurant public link/i);
  assert.match(settings, /navigator\.clipboard\.writeText|Copy link/i);
  assert.match(settings, /\/r\/\$\{.*encodeURIComponent\(context\.data\.organization\.slug\).*\}/i);
  assert.match(settings, /\/order\/\$\{.*encodeURIComponent\(context\.data\.branch\.id\).*\}/i);
});
