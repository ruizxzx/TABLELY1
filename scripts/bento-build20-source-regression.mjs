import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const assertions = [
  ['editor uses canonical PageInspector', read('app/components/BentoBlockEditor.tsx').includes('<PageInspector'), 'BentoBlockEditor must render PageInspector'],
  ['public uses BentoBlockView', read('app/components/BentoPublicRenderer.tsx').includes('<BentoBlockView'), 'Public renderer must use shared BentoBlockView'],
  ['public preview routes to preview client', read('app/components/BentoPublicPreviewFrame.tsx').includes('src="/bento-preview"'), 'Preview frame must use the isolated canonical preview route'],
  ['store route normalizes canonical design', read('app/api/studio/store/route.ts').includes('normalizeBentoPageDesign'), 'Store API must use canonical design normalization'],
  ['preview uses canonical design defaults', read('app/bento-preview/preview-client.tsx').includes('BENTO_PAGE_DESIGN_DEFAULTS'), 'Preview must not maintain a second design-default source'],
  ['onboarding uses canonical design defaults', read('app/studio/link-hub/page.tsx').includes('BENTO_PAGE_DESIGN_DEFAULTS'), 'Onboarding must not maintain a second design-default source'],
  ['onboarding has six templates', (() => { const s=read('app/studio/link-hub/page.tsx'); const src=read('app/lib/bento.ts'); const keys=['creator','developer','musician','artist','educator','business']; return keys.every(k=>src.includes(`${k}:`)) && s.includes('Object.keys(BENTO_STARTER_TEMPLATES)') && s.includes('hasLegacyCreatorContent'); })(), 'All six starter templates and new/legacy safety boundary must be wired'],
  ['mobile-safe effect fallback', read('app/globals.css').includes('@media (hover: none), (pointer: coarse)'), 'Global effects must have coarse-pointer fallback'],
  ['reduced motion fallback', read('app/globals.css').includes('@media (prefers-reduced-motion: reduce)'), 'Global effects must respect reduced motion'],
  ['touch physics disabled', read('app/components/BentoBlock.tsx').includes("event.pointerType === 'touch' || event.pointerType === 'pen'"), 'Pointer-driven block effects must not move touch/pen content'],
  ['public animation intensity wired', read('app/globals.css').includes('transition-duration: calc(.18s + (var(--bento-animation-intensity, .7) * .16s))'), 'Global animation intensity must affect public transitions'],
  ['editor alignment wired', read('app/components/BentoBlockEditor.tsx').includes("design.pageAlignment === 'right'"), 'Page alignment must affect the editor canvas'],
  ['single Build20 token section', (read('app/globals.css').match(/BUILD 20/g)||[]).length === 1, 'Build20 CSS token section should not be duplicated'],
];
let failed=0;
for (const [name, ok, msg] of assertions) { if (ok) console.log(`PASS ${name}`); else { console.error(`FAIL ${name}: ${msg}`); failed++; } }
process.exit(failed ? 1 : 0);
