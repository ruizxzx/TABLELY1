import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const checks = [
  ['template helper defaults to classic', read('app/lib/public-paths.ts').includes("value === 'bento' ? 'bento' : 'default'"), 'Missing safe default template resolver'],
  ['public renderer selects classic mode', read('app/r/[username]/page.tsx').includes("publicTemplate === 'default'") && read('app/r/[username]/page.tsx').includes('ClassicLinkHubRenderer'), 'Public Link Hub does not branch to the classic renderer'],
  ['API persists template mode', read('app/api/studio/store/route.ts').includes("publicTemplate: config.publicTemplate === 'bento' ? 'bento' : 'default'"), 'Studio API does not normalize publicTemplate'],
  ['studio exposes template toggle', read('app/studio/link-hub/page.tsx').includes('PUBLIC PAGE TEMPLATE') && read('app/studio/link-hub/page.tsx').includes('Classic link-in-bio') && read('app/studio/link-hub/page.tsx').includes('Your saved Bento blocks'), 'Studio template toggle is incomplete'],
  ['classic renderer uses canonical visitor/session helpers', read('app/components/ClassicLinkHubRenderer.tsx').includes('getAnalyticsIdentity') && read('app/components/ClassicLinkHubRenderer.tsx').includes('getAnalyticsAttribution') && read('app/components/ClassicLinkHubRenderer.tsx').includes('createAnalyticsEventId'), 'Classic renderer does not use the canonical analytics identity/event helpers'],
  ['classic renderer preserves saved link grids', read('app/components/ClassicLinkHubRenderer.tsx').includes('visibleLinks.map') && read('app/components/ClassicLinkHubRenderer.tsx').includes('classic-linktree-links'), 'Classic renderer does not restore the link grid'],
  ['bento document remains untouched by template switch', read('app/studio/link-hub/page.tsx').includes("onClick={() => update({ publicTemplate: 'default' })}") && read('app/studio/link-hub/page.tsx').includes("onClick={() => update({ publicTemplate: 'bento' })}"), 'Template switch is not isolated to publicTemplate'],
  ['default editor replaces bento editor', read('app/studio/link-hub/page.tsx').includes("hub.publicTemplate === 'bento' ? <BentoBlockEditor") && read('app/studio/link-hub/page.tsx').includes('<ClassicLinkHubEditor'), 'Studio does not swap between classic and Bento editors'],
  ['classic collections are persisted', read('app/studio/link-hub/page.tsx').includes('collections: Array.isArray(saved.collections) ? saved.collections : []') && read('app/api/studio/store/route.ts').includes('const collections = Array.isArray(config.collections)'), 'Classic link collections are not persisted'],
  ['classic link customizations are persisted', read('app/api/studio/store/route.ts').includes("layout: item?.layout === 'featured' ? 'featured' : 'classic'") && read('app/api/studio/store/route.ts').includes("linkShape: ['rounded', 'pill', 'square']"), 'Classic link customization fields are not normalized'],
  ['editor preview disables analytics', read('app/components/ClassicLinkHubEditor.tsx').includes('analyticsEnabled={false}') && read('app/components/ClassicLinkHubRenderer.tsx').includes('if (!analyticsEnabled) return;'), 'Editor preview can pollute public analytics'],
];
let failed = false;
for (const [name, ok, message] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) { console.error(`  ${message}`); failed = true; }
}
if (failed) process.exit(1);
