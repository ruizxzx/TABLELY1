
import { normalizeBentoDocument, validateBentoDocument, validateBentoLayout, withBentoGeometry, getBentoGeometry, type BentoBlock } from '../app/lib/bento';
import { buildHubBentoBlocks, getCanonicalBentoBlocks } from '../app/lib/bento-hub';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const base: BentoBlock = {
  id: 'build19-link', type: 'link', size: '2x2', enabled: true, startAt: null, endAt: null,
  position: { column: 1, row: 1 },
  config: {
    label: 'Canonical CTA', description: 'Never overwritten', url: 'https://example.com',
    background: '#112233', background2: '#334455', textColor: '#ffffff',
    radius: 42, paddingX: 31, paddingY: 19, contentGap: 17, contentAlign: 'center', contentVertical: 'end',
    fontFamily: 'Georgia, serif', fontSize: 18, fontWeight: 700, lineHeight: 1.25, letterSpacing: -0.01,
    border: 'solid', borderColor: '#ffffff', borderWidth: 2, shadow: 'deep', animation: 'rise', animationIntensity: 42,
  },
  geometry: {
    desktop: { column: 3, row: 4, columnSpan: 6, rowSpan: 3 },
    tablet: { column: 2, row: 6, columnSpan: 4, rowSpan: 3 },
    mobile: { column: 1, row: 9, columnSpan: 4, rowSpan: 4 },
  },
  locked: false, lockPosition: false, lockSize: false, lockStyle: false,
};

const normalized = normalizeBentoDocument([base]);
assert(validateBentoDocument(normalized), 'canonical responsive document is structurally invalid');
assert(validateBentoLayout(normalized), 'canonical responsive document overlaps');
assert(JSON.stringify(normalized[0].geometry) === JSON.stringify(base.geometry), 'responsive geometry changed during normalization');
assert(normalized[0].config.paddingX === 31 && normalized[0].config.fontSize === 18, 'visual inspector configuration was lost');

const mobileBefore = getBentoGeometry(normalized[0], 'mobile');
const tabletBefore = getBentoGeometry(normalized[0], 'tablet');
const desktopChanged = withBentoGeometry(normalized[0], { ...getBentoGeometry(normalized[0], 'desktop'), column: 7 }, 'desktop');
assert(getBentoGeometry(desktopChanged, 'mobile').column === mobileBefore.column, 'desktop edit mutated mobile geometry');
assert(getBentoGeometry(desktopChanged, 'tablet').column === tabletBefore.column, 'desktop edit mutated tablet geometry');

const migrated = buildHubBentoBlocks({
  title: 'Creator', bio: 'Bio', username: 'creator',
  socialLinks: { instagram: 'https://instagram.com/creator' },
  existingBlocks: [base],
});
assert(migrated.some(block => block.id === base.id), 'partial migration discarded the existing custom node');
assert(migrated.find(block => block.id === base.id)?.config.label === 'Canonical CTA', 'migration overwrote custom node presentation');
assert(validateBentoDocument(migrated), 'migrated document failed validation');

const canonical = getCanonicalBentoBlocks({ existingBlocks: migrated, title: 'Creator', username: 'creator', socialLinks: { instagram: 'https://instagram.com/new' } });
assert(canonical.find(block => block.id === base.id)?.config.label === 'Canonical CTA', 'canonical load overwrote presentation');
assert(canonical.find(block => block.id === base.id)?.config.fontFamily === 'Georgia, serif', 'canonical load lost typography configuration');

console.log('Bento Build 19 regression suite: PASS');
