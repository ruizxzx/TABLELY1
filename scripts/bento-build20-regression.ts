import {
  BENTO_PAGE_DESIGN_DEFAULTS,
  BENTO_STARTER_DESIGN_PRESETS,
  BENTO_STARTER_TEMPLATES,
  BENTO_VIEWPORT_COLUMNS,
  createBentoStarterBlocks,
  getBentoEffectiveGridGap,
  getBentoStarterDesign,
  normalizeBentoDocument,
  normalizeBentoPageDesign,
  validateBentoDocument,
  validateBentoLayout,
  getBentoGeometry,
  type BentoBlock,
  type BentoPageDesign,
} from '../app/lib/bento';
import { buildHubBentoBlocks } from '../app/lib/bento-hub';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const defaultDesign = normalizeBentoPageDesign(BENTO_PAGE_DESIGN_DEFAULTS);
assert(defaultDesign.gridGap === 12 && defaultDesign.cardRadius === 28, 'shared design defaults drifted');
assert(defaultDesign.texture === 'grain' && defaultDesign.cursorFx === 'spotlight', 'effect defaults drifted');

const hostileDesign = normalizeBentoPageDesign({
  ...BENTO_PAGE_DESIGN_DEFAULTS,
  background: 'javascript:alert(1)',
  gridGap: 999,
  cardRadius: -20,
  animationIntensity: -4,
  contentDensity: 'invalid',
  font: 'invalid',
  customFutureProperty: 'preserve-me',
});
assert(hostileDesign.background === BENTO_PAGE_DESIGN_DEFAULTS.background, 'unsafe background was not normalized');
assert(hostileDesign.gridGap === 40 && hostileDesign.cardRadius === 8, 'design bounds failed');
assert(hostileDesign.animationIntensity === 0, 'animation intensity bounds failed');
assert((hostileDesign as Record<string, unknown>).customFutureProperty === 'preserve-me', 'unknown design properties were dropped');

const densityDesigns: BentoPageDesign[] = [
  { ...defaultDesign, gridGap: 12, contentDensity: 'compact' },
  { ...defaultDesign, gridGap: 12, contentDensity: 'comfortable' },
  { ...defaultDesign, gridGap: 12, contentDensity: 'spacious' },
];
assert(getBentoEffectiveGridGap(densityDesigns[0]) < getBentoEffectiveGridGap(densityDesigns[1]), 'compact density did not reduce gap');
assert(getBentoEffectiveGridGap(densityDesigns[2]) > getBentoEffectiveGridGap(densityDesigns[1]), 'spacious density did not increase gap');
assert(getBentoEffectiveGridGap({ ...defaultDesign, gridGap: 40, contentDensity: 'spacious' }) === 40, 'effective grid gap exceeded safety bound');

const templateKeys = Object.keys(BENTO_STARTER_TEMPLATES) as (keyof typeof BENTO_STARTER_TEMPLATES)[];
assert(templateKeys.length === 6, 'expected exactly six Build 20 starter templates');
for (const key of templateKeys) {
  const blocksA = createBentoStarterBlocks(key);
  const blocksB = createBentoStarterBlocks(key);
  assert(JSON.stringify(blocksA) === JSON.stringify(blocksB), `${key} starter is not deterministic`);
  assert(blocksA.length >= 3 && blocksA.length <= 4, `${key} starter has unexpected block count`);
  assert(new Set(blocksA.map(block => block.id)).size === blocksA.length, `${key} starter IDs are not unique`);
  assert(blocksA.every(block => block.position === null), `${key} starter unexpectedly owns legacy position state`);
  assert(blocksA.every(block => block.geometry && Object.keys(block.geometry).length === 0), `${key} starter should let the canonical layout engine place geometry`);
  const design = getBentoStarterDesign(key);
  assert(design.font === BENTO_STARTER_DESIGN_PRESETS[key].font || !BENTO_STARTER_DESIGN_PRESETS[key].font, `${key} starter design did not apply`);
  const hydrated = buildHubBentoBlocks({ title: 'Starter', username: 'starter', existingBlocks: blocksA, starterTemplate: key });
  assert(validateBentoDocument(hydrated), `${key} starter failed canonical document validation`);
  assert(validateBentoLayout(hydrated), `${key} starter failed responsive layout validation`);
  assert([...new Set(hydrated.filter(block => block.systemKey).map(block => block.systemKey))].length >= 8, `${key} starter missing canonical system nodes`);
}

const protectedBlock: BentoBlock = {
  id: 'protected-system', type: 'store', size: '2x2', enabled: true, startAt: null, endAt: null, position: { column: 7, row: 12 },
  config: { title: 'My own title', description: 'Custom description', background: '#123456', radius: 41, animation: 'tilt', animationIntensity: 33 },
  geometry: {
    desktop: { column: 7, row: 12, columnSpan: 6, rowSpan: 4 },
    tablet: { column: 3, row: 14, columnSpan: 5, rowSpan: 4 },
    mobile: { column: 1, row: 18, columnSpan: 4, rowSpan: 5 },
  },
  locked: false, lockPosition: false, lockSize: false, lockStyle: false, systemKey: 'store',
};
const canonical = normalizeBentoDocument([protectedBlock]);
assert(JSON.stringify(canonical[0].geometry) === JSON.stringify(protectedBlock.geometry), 'valid responsive geometry was changed by Build 20');
assert(canonical[0].config.title === 'My own title' && canonical[0].config.animation === 'tilt', 'creator presentation was changed by Build 20');
assert(validateBentoLayout(canonical), 'protected canonical block layout is invalid');

const duplicatedSystems = buildHubBentoBlocks({ existingBlocks: [protectedBlock, { ...protectedBlock, id: 'protected-system-2', config: { ...protectedBlock.config, title: 'Second' } }] });
const stores = duplicatedSystems.filter(block => block.systemKey === 'store');
assert(stores.length === 2, 'Build 20 removed an existing system node unexpectedly');
assert(stores.filter(block => block.enabled).length === 1, 'system-node duplicates are not safely contained');

// Responsive column model must stay explicit and deterministic.
assert(BENTO_VIEWPORT_COLUMNS.desktop === 12 && BENTO_VIEWPORT_COLUMNS.tablet === 8 && BENTO_VIEWPORT_COLUMNS.mobile === 4, 'responsive column model changed');
const mobile = getBentoGeometry(protectedBlock, 'mobile');
assert(mobile.columnSpan === 4, 'mobile geometry lost full-width configuration');

console.log('Bento Build 20 regression suite: PASS');
