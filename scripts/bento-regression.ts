import { normalizeBentoDocument, normaliseBentoBlocks, validateBentoDocument, validateBentoLayout, resolveBentoBlocksForMobile, findBentoAvailableGeometry, withBentoGeometry, type BentoBlock } from '../app/lib/bento';
import { buildHubBentoBlocks, getCanonicalBentoBlocks, SYSTEM_NODE_KEYS } from '../app/lib/bento-hub';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeBlock(overrides: Partial<BentoBlock> = {}): BentoBlock {
  const base: BentoBlock = {
    id: 'block-1', type: 'link', size: '2x2', enabled: true,
    startAt: null, endAt: null, position: { column: 1, row: 1 },
    config: { label: 'Hello', title: 'Canonical title', description: 'Keep this', background: '#112233', animation: 'tilt' },
    geometry: {
      desktop: { column: 2, row: 3, columnSpan: 5, rowSpan: 2 },
      tablet: { column: 2, row: 4, columnSpan: 4, rowSpan: 3 },
      mobile: { column: 1, row: 6, columnSpan: 4, rowSpan: 2 },
    }, locked: false, lockPosition: false, lockSize: false, lockStyle: false,
  };
  return { ...base, ...overrides, config: { ...base.config, ...(overrides.config || {}) }, geometry: overrides.geometry || base.geometry };
}

const original = makeBlock();
const canonical = normalizeBentoDocument([original]);
assert(canonical.length === 1, 'canonical document changed block count');
assert(JSON.stringify(canonical[0].geometry) === JSON.stringify(original.geometry), 'valid responsive geometry was changed');
assert(canonical[0].config.title === 'Canonical title', 'creator presentation was changed');
assert(validateBentoDocument(canonical), 'canonical document failed validation');
assert(validateBentoLayout(canonical), 'canonical document failed layout validation');
assert(JSON.stringify(resolveBentoBlocksForMobile(canonical, 'smart')) === JSON.stringify(canonical), 'valid responsive document was reflowed');

const overlapA = makeBlock({ id: 'a', geometry: {
  desktop: { column: 1, row: 1, columnSpan: 5, rowSpan: 2 },
  tablet: { column: 1, row: 1, columnSpan: 4, rowSpan: 2 },
  mobile: { column: 1, row: 1, columnSpan: 4, rowSpan: 2 },
} });
const overlapB = makeBlock({ id: 'b', geometry: {
  desktop: { column: 1, row: 1, columnSpan: 5, rowSpan: 2 },
  tablet: { column: 1, row: 1, columnSpan: 4, rowSpan: 2 },
  mobile: { column: 1, row: 1, columnSpan: 4, rowSpan: 2 },
} });
const repaired = normalizeBentoDocument([overlapA, overlapB]);
assert(validateBentoDocument(repaired), 'repaired document failed structural validation');
assert(validateBentoLayout(repaired), 'repaired document still overlaps');
assert(repaired.find(b => b.id === 'a')?.config.title === 'Canonical title', 'repair changed content');
assert(repaired.find(b => b.id === 'b')?.config.title === 'Canonical title', 'repair changed content on second block');

const lockedOverlap = normalizeBentoDocument([
  makeBlock({ id: 'locked-a', locked: true, lockPosition: true, geometry: overlapA.geometry }),
  makeBlock({ id: 'locked-b', locked: true, lockPosition: true, geometry: overlapB.geometry }),
]);
assert(!validateBentoLayout(lockedOverlap), 'locked collision was silently rewritten');

const rawPartial = normaliseBentoBlocks([makeBlock({ geometry: { desktop: { column: 3, row: 7, columnSpan: 4, rowSpan: 2 } } })]);
assert(rawPartial[0].geometry?.tablet && rawPartial[0].geometry?.mobile, 'missing responsive geometry was not filled');

const migrated = buildHubBentoBlocks({
  title: 'Creator', bio: 'Bio', username: 'creator',
  socialLinks: { instagram: 'https://instagram.com/creator' },
  products: [{ id: 'product-1', title: 'Live product', slug: 'live-product', price: 99, currency: 'INR', image: null }],
  existingBlocks: [makeBlock({ id: 'custom-store', systemKey: 'store', config: { title: 'My custom shop', description: 'Custom copy' } })],
});
assert(migrated.filter(block => block.systemKey === 'store').length === 1, 'store system node was duplicated');
assert(migrated.find(block => block.systemKey === 'store')?.config.title === 'My custom shop', 'system-node presentation was overwritten');
assert((migrated.find(block => block.systemKey === 'store')?.config.products as unknown[]).length === 1, 'live product data was not hydrated');
for (const key of SYSTEM_NODE_KEYS) assert(migrated.some(block => block.systemKey === key), `missing system node ${key}`);
assert(validateBentoLayout(migrated), 'migrated Bento layout overlaps');

const starter = buildHubBentoBlocks({ existingBlocks: [] });
assert(SYSTEM_NODE_KEYS.every(key => starter.some(block => block.systemKey === key)), 'starter is missing a system node');
assert(validateBentoLayout(starter), 'starter layout overlaps');
assert(validateBentoDocument(starter), 'starter failed canonical validation');

const hydrated = getCanonicalBentoBlocks({
  existingBlocks: migrated,
  title: 'Creator', bio: 'Bio', username: 'creator',
  socialLinks: { instagram: 'https://instagram.com/new' },
  products: [{ id: 'product-2', title: 'New live product', slug: 'new-live-product', price: 149, currency: 'INR', image: null }],
});
const hydratedStore = hydrated.find(block => block.systemKey === 'store');
assert(hydratedStore?.config.title === 'My custom shop', 'canonical hydration overwrote presentation');
assert((hydratedStore?.config.products as any[])[0]?.id === 'product-2', 'canonical hydration did not update live data');

const duplicatedSystems = buildHubBentoBlocks({ existingBlocks: [makeBlock({ id: 'store-1', type: 'store', size: '2x2', systemKey: 'store' }), makeBlock({ id: 'store-2', type: 'store', size: '2x2', systemKey: 'store', config: { title: 'Second store' } })] });
const storeNodes = duplicatedSystems.filter(b => b.systemKey === 'store');
assert(storeNodes.length === 2, 'system-node identity was unexpectedly removed');
assert(storeNodes.filter(b => b.enabled).length === 1, 'duplicate system nodes were not contained to one visible owner');
const hiddenFirst = buildHubBentoBlocks({ existingBlocks: [makeBlock({ id: 'store-hidden', type: 'store', size: '2x2', systemKey: 'store', enabled: false }), makeBlock({ id: 'store-visible', type: 'store', size: '2x2', systemKey: 'store', enabled: true })] });
const hiddenFirstStores = hiddenFirst.filter(b => b.systemKey === 'store');
assert(hiddenFirstStores.find(b => b.id === 'store-visible')?.enabled === true, 'migration incorrectly disabled the visible duplicate system node');

const occupiedSource = [makeBlock({ id: 'occupied', geometry: { desktop: { column: 1, row: 1, columnSpan: 6, rowSpan: 4 }, tablet: { column: 1, row: 1, columnSpan: 4, rowSpan: 4 }, mobile: { column: 1, row: 1, columnSpan: 4, rowSpan: 4 } } })];
const desired = { column: 1, row: 1, columnSpan: 3, rowSpan: 2 };
const available = findBentoAvailableGeometry(occupiedSource, desired, 'desktop');
assert(available.column > 1 || available.row > 1, 'available placement ignored occupied geometry');
const moved = withBentoGeometry(makeBlock({ id: 'moving' }), available, 'desktop');
assert(validateBentoLayout([...occupiedSource, moved], 'desktop'), 'single-block placement still overlaps');

console.log('Bento regression suite: PASS');
