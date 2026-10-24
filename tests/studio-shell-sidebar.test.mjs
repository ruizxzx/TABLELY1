import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('mobile navigation can collapse into a persistent icon rail that gives content room', async () => {
  const shell = await read('components/StudioShell.tsx');
  const styles = await read('app/globals.css');
  const premiumStyles = await read('app/premium.css');

  assert.match(shell, /aria-label="Collapse navigation"[\s\S]*?setCollapsed\(true\); setOpen\(false\)/);
  assert.match(shell, /aria-label=\{collapsed \? 'Expand navigation' : 'Open navigation'\}/);
  assert.match(shell, /title=\{collapsed \? label : undefined\}/);
  assert.match(styles, /@media \(max-width: 1100px\) \{[\s\S]*?\.shell\.shell-collapsed \.sidebar[\s\S]*?width: 76px;[\s\S]*?transform: translateX\(0\)/);
  assert.match(styles, /\.shell\.shell-collapsed \.main-shell \{[\s\S]*?width: calc\(100% - 76px\);[\s\S]*?margin-left: 76px/);
  assert.match(styles, /\.shell\.shell-collapsed \.scrim \{ display: none; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(premiumStyles, /\.shell\.shell-collapsed\s*\{\s*grid-template-columns: 76px minmax\(0, 1fr\);/);
});

test('mobile primary navigation keeps core operations visible and exposes all routes through More', async () => {
  const shell = await read('components/StudioShell.tsx');
  const styles = await read('app/premium.css');

  assert.match(shell, /const preferredMobileHrefs = \['\/orders', '\/tables', '\/kitchen', '\/service-requests'\]/);
  assert.match(shell, /visibleNavItems/);
  assert.match(shell, /aria-label="Primary navigation"/);
  assert.match(shell, /aria-label="More navigation options"/);
  assert.match(shell, /setCollapsed\(false\); setOpen\(true\)/);
  assert.match(styles, /\.studio-mobile-nav \{[\s\S]*?grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.shell\.shell-collapsed \.main-shell \{[\s\S]*?width: 100%;[\s\S]*?margin-left: 0;/);
});

test('mobile data tables keep every column available through horizontal scrolling', async () => {
  const styles = await read('app/globals.css');

  assert.match(styles, /\.data-table, \.sub-table-row \{ overflow-x: auto; \}/);
  assert.match(styles, /\.data-row, \.data-head \{ min-width: 520px; \}/);
  assert.doesNotMatch(styles, /\.data-row > :nth-child\(4\), \.data-row > :nth-child\(5\), \.data-head > :nth-child\(4\) \{ display: none; \}/);
});
