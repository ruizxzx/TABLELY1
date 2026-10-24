"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BENTO_TYPES = exports.BENTO_SIZES = exports.BENTO_STARTER_DESIGN_PRESETS = exports.BENTO_STARTER_TEMPLATES = exports.BENTO_PAGE_DESIGN_DEFAULTS = exports.BENTO_MAX_ROW_SPAN = exports.BENTO_GAP = exports.BENTO_ROW_HEIGHT = exports.BENTO_VIEWPORT_ROW_HEIGHT = exports.BENTO_VIEWPORT_COLUMNS = exports.BENTO_GRID_ROWS = exports.BENTO_GRID_COLUMNS = exports.BENTO_MUSIC_PROVIDERS = void 0;
exports.normalizeBentoMusicProvider = normalizeBentoMusicProvider;
exports.getBentoMusicProvider = getBentoMusicProvider;
exports.isValidBentoMusicUrl = isValidBentoMusicUrl;
exports.getBentoRowHeight = getBentoRowHeight;
exports.getBentoPageBackground = getBentoPageBackground;
exports.getBentoCardShadow = getBentoCardShadow;
exports.getBentoStarterDesign = getBentoStarterDesign;
exports.normalizeBentoPageDesign = normalizeBentoPageDesign;
exports.getBentoDesignDensityFactor = getBentoDesignDensityFactor;
exports.getBentoEffectiveGridGap = getBentoEffectiveGridGap;
exports.isBentoBlockVisible = isBentoBlockVisible;
exports.isScheduledVisible = isScheduledVisible;
exports.normalizeBentoSize = normalizeBentoSize;
exports.getBentoSpan = getBentoSpan;
exports.clampBentoGeometry = clampBentoGeometry;
exports.scaleGeometryToViewport = scaleGeometryToViewport;
exports.getBentoGeometry = getBentoGeometry;
exports.withBentoGeometry = withBentoGeometry;
exports.getBentoLayout = getBentoLayout;
exports.arrangeBentoBlocks = arrangeBentoBlocks;
exports.packBentoBlocks = packBentoBlocks;
exports.resolveBentoBlocksForMobile = resolveBentoBlocksForMobile;
exports.findBentoAvailableGeometry = findBentoAvailableGeometry;
exports.isBentoGeometryEqual = isBentoGeometryEqual;
exports.reflowBentoPositions = reflowBentoPositions;
exports.clampBentoPosition = clampBentoPosition;
exports.normalizeBentoPlacement = normalizeBentoPlacement;
exports.syncBentoPositions = syncBentoPositions;
exports.isValidBentoPlacement = isValidBentoPlacement;
exports.validateBentoLayout = validateBentoLayout;
exports.createBentoStarterBlocks = createBentoStarterBlocks;
exports.normaliseBentoBlocks = normaliseBentoBlocks;
exports.validateBentoDocument = validateBentoDocument;
exports.normalizeBentoDocument = normalizeBentoDocument;
exports.getBentoGridStyle = getBentoGridStyle;
exports.getBentoResponsiveGridStyle = getBentoResponsiveGridStyle;
exports.bentoGridClass = bentoGridClass;
exports.BENTO_MUSIC_PROVIDERS = [
    { id: 'spotify', label: 'Spotify', openLabel: 'Open in Spotify' },
    { id: 'youtube_music', label: 'YouTube Music', openLabel: 'Open in YouTube Music' },
    { id: 'apple_music', label: 'Apple Music', openLabel: 'Open in Apple Music' },
];
function normalizeBentoMusicProvider(value) {
    return exports.BENTO_MUSIC_PROVIDERS.some(provider => provider.id === value) ? value : 'spotify';
}
function getBentoMusicProvider(value) {
    return exports.BENTO_MUSIC_PROVIDERS.find(provider => provider.id === normalizeBentoMusicProvider(value)) || exports.BENTO_MUSIC_PROVIDERS[0];
}
function isValidBentoMusicUrl(providerValue, value) {
    if (typeof value !== 'string' || !value.trim())
        return false;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:')
            return false;
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const provider = normalizeBentoMusicProvider(providerValue);
        if (provider === 'spotify')
            return host === 'open.spotify.com' || host === 'spotify.com';
        if (provider === 'youtube_music')
            return host === 'music.youtube.com' || host === 'youtube.com' || host === 'youtu.be';
        return host === 'music.apple.com';
    }
    catch {
        return false;
    }
}
exports.BENTO_GRID_COLUMNS = 12;
exports.BENTO_GRID_ROWS = 4096;
exports.BENTO_VIEWPORT_COLUMNS = { desktop: 12, tablet: 8, mobile: 4 };
exports.BENTO_VIEWPORT_ROW_HEIGHT = { desktop: 72, tablet: 68, mobile: 64 };
exports.BENTO_ROW_HEIGHT = exports.BENTO_VIEWPORT_ROW_HEIGHT.desktop;
function getBentoRowHeight(viewport = 'desktop') { return exports.BENTO_VIEWPORT_ROW_HEIGHT[viewport]; }
exports.BENTO_GAP = 12;
exports.BENTO_MAX_ROW_SPAN = 64;
function getBentoPageBackground(design) {
    const background = design.background || '#f4f0e8';
    const background2 = design.background2 || '#ffffff';
    switch (design.backgroundType) {
        case 'gradient':
            return `linear-gradient(135deg, ${background} 0%, ${background2} 100%)`;
        case 'mesh':
            return `radial-gradient(circle at 8% 12%, ${background2} 0, transparent 34%), radial-gradient(circle at 92% 84%, ${background2} 0, transparent 38%), ${background}`;
        case 'aurora':
            return `radial-gradient(circle at 12% 12%, ${background2} 0, transparent 28%), radial-gradient(circle at 84% 24%, #a855f7 0, transparent 24%), radial-gradient(circle at 56% 92%, #22c55e 0, transparent 24%), linear-gradient(135deg, ${background}, #111827)`;
        default:
            return background;
    }
}
function getBentoCardShadow(value) {
    switch (value) {
        case 'none': return 'none';
        case 'deep': return '0 28px 70px rgba(20, 22, 30, .18), 0 8px 20px rgba(20, 22, 30, .12)';
        case 'glow': return '0 24px 64px rgba(109, 70, 255, .20), 0 0 0 1px rgba(255,255,255,.16) inset';
        default: return '0 18px 42px rgba(31,23,61,.13), 0 4px 14px rgba(31,23,61,.08)';
    }
}
exports.BENTO_PAGE_DESIGN_DEFAULTS = {
    background: '#f4f0e8',
    accent: '#6d46ff',
    pageWidth: 'balanced',
    gridGap: 12,
    cardRadius: 28,
    font: 'modern',
    motion: 'expressive',
    spotlight: true,
    noise: true,
    cursorFx: 'spotlight',
    mobileMode: 'smart',
    texture: 'grain',
    animationIntensity: 70,
    contentDensity: 'comfortable',
    pageAlignment: 'center',
    backgroundType: 'solid',
    background2: '#ffffff',
    cardShadow: 'soft',
    textColor: '#171811',
    mutedTextColor: '#68695e',
    buttonStyle: 'solid',
};
exports.BENTO_STARTER_TEMPLATES = {
    creator: { label: 'Creator', note: 'Profile, work, social proof and audience', types: ['rich_text', 'image', 'cta'] },
    developer: { label: 'Developer', note: 'Projects, writing, GitHub and contact', types: ['rich_text', 'link', 'cta'] },
    musician: { label: 'Musician', note: 'Music, releases, shows and audience', types: ['spotify', 'image', 'cta'] },
    artist: { label: 'Artist', note: 'Gallery-led portfolio with a strong visual center', types: ['gallery', 'rich_text', 'image'] },
    educator: { label: 'Educator', note: 'Lessons, resources, writing and community', types: ['rich_text', 'video', 'link'] },
    business: { label: 'Business / Personal Brand', note: 'Offer, proof, conversion and contact', types: ['cta', 'rich_text', 'image'] },
};
exports.BENTO_STARTER_DESIGN_PRESETS = {
    creator: { font: 'modern', motion: 'expressive', texture: 'grain', cursorFx: 'spotlight', spotlight: true, noise: true, cardShadow: 'soft', buttonStyle: 'solid', contentDensity: 'comfortable' },
    developer: { font: 'mono', motion: 'calm', texture: 'noise', cursorFx: 'magnetic', spotlight: true, noise: true, cardShadow: 'deep', buttonStyle: 'outline', contentDensity: 'compact' },
    musician: { font: 'modern', motion: 'cinematic', texture: 'grain', cursorFx: 'spotlight', spotlight: true, noise: true, cardShadow: 'glow', buttonStyle: 'solid', contentDensity: 'comfortable' },
    artist: { font: 'editorial', motion: 'calm', texture: 'grain', cursorFx: 'spotlight', spotlight: true, noise: true, cardShadow: 'soft', buttonStyle: 'soft', contentDensity: 'spacious' },
    educator: { font: 'clean', motion: 'calm', texture: 'none', cursorFx: 'none', spotlight: false, noise: false, cardShadow: 'soft', buttonStyle: 'solid', contentDensity: 'comfortable' },
    business: { font: 'modern', motion: 'expressive', texture: 'dots', cursorFx: 'magnetic', spotlight: true, noise: true, cardShadow: 'deep', buttonStyle: 'solid', contentDensity: 'compact' },
};
function getBentoStarterDesign(template) {
    return normalizeBentoPageDesign({ ...exports.BENTO_PAGE_DESIGN_DEFAULTS, ...(exports.BENTO_STARTER_DESIGN_PRESETS[template] || {}) });
}
function normalizeBentoPageDesign(value) {
    const input = value && typeof value === 'object' ? value : {};
    const safeHex = (v, fallback) => /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : fallback;
    const safeNumber = (v, min, max, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
    };
    return {
        ...exports.BENTO_PAGE_DESIGN_DEFAULTS,
        ...input,
        background: safeHex(input.background, exports.BENTO_PAGE_DESIGN_DEFAULTS.background),
        accent: safeHex(input.accent, exports.BENTO_PAGE_DESIGN_DEFAULTS.accent),
        pageWidth: ['compact', 'balanced', 'wide'].includes(String(input.pageWidth)) ? String(input.pageWidth) : exports.BENTO_PAGE_DESIGN_DEFAULTS.pageWidth,
        gridGap: Math.round(safeNumber(input.gridGap, 0, 40, exports.BENTO_PAGE_DESIGN_DEFAULTS.gridGap)),
        cardRadius: Math.round(safeNumber(input.cardRadius, 8, 64, exports.BENTO_PAGE_DESIGN_DEFAULTS.cardRadius)),
        font: ['modern', 'editorial', 'mono', 'clean'].includes(String(input.font)) ? String(input.font) : exports.BENTO_PAGE_DESIGN_DEFAULTS.font,
        motion: ['calm', 'expressive', 'cinematic'].includes(String(input.motion)) ? String(input.motion) : exports.BENTO_PAGE_DESIGN_DEFAULTS.motion,
        spotlight: input.spotlight !== false,
        noise: input.noise !== false,
        cursorFx: ['none', 'spotlight', 'magnetic'].includes(String(input.cursorFx)) ? String(input.cursorFx) : exports.BENTO_PAGE_DESIGN_DEFAULTS.cursorFx,
        mobileMode: ['smart', 'custom'].includes(String(input.mobileMode)) ? String(input.mobileMode) : exports.BENTO_PAGE_DESIGN_DEFAULTS.mobileMode,
        texture: ['none', 'noise', 'grain', 'dots'].includes(String(input.texture)) ? String(input.texture) : exports.BENTO_PAGE_DESIGN_DEFAULTS.texture,
        animationIntensity: Math.round(safeNumber(input.animationIntensity, 0, 100, exports.BENTO_PAGE_DESIGN_DEFAULTS.animationIntensity)),
        contentDensity: ['compact', 'comfortable', 'spacious'].includes(String(input.contentDensity)) ? String(input.contentDensity) : exports.BENTO_PAGE_DESIGN_DEFAULTS.contentDensity,
        pageAlignment: ['left', 'center', 'right'].includes(String(input.pageAlignment)) ? String(input.pageAlignment) : exports.BENTO_PAGE_DESIGN_DEFAULTS.pageAlignment,
        backgroundType: ['solid', 'gradient', 'mesh', 'aurora'].includes(String(input.backgroundType)) ? String(input.backgroundType) : exports.BENTO_PAGE_DESIGN_DEFAULTS.backgroundType,
        background2: safeHex(input.background2, exports.BENTO_PAGE_DESIGN_DEFAULTS.background2),
        cardShadow: ['none', 'soft', 'deep', 'glow'].includes(String(input.cardShadow)) ? String(input.cardShadow) : exports.BENTO_PAGE_DESIGN_DEFAULTS.cardShadow,
        textColor: safeHex(input.textColor, exports.BENTO_PAGE_DESIGN_DEFAULTS.textColor),
        mutedTextColor: safeHex(input.mutedTextColor, exports.BENTO_PAGE_DESIGN_DEFAULTS.mutedTextColor),
        buttonStyle: ['solid', 'soft', 'outline'].includes(String(input.buttonStyle)) ? String(input.buttonStyle) : exports.BENTO_PAGE_DESIGN_DEFAULTS.buttonStyle,
    };
}
function getBentoDesignDensityFactor(density = 'comfortable') {
    return density === 'compact' ? 0.82 : density === 'spacious' ? 1.18 : 1;
}
function getBentoEffectiveGridGap(design) {
    const base = Number.isFinite(Number(design.gridGap)) ? Number(design.gridGap) : exports.BENTO_GAP;
    return Math.round(Math.max(0, Math.min(40, base * getBentoDesignDensityFactor(design.contentDensity))));
}
exports.BENTO_SIZES = ['1x1', '2x1', '1x2', '2x2', 'full'];
exports.BENTO_TYPES = [
    { type: 'profile', label: 'Profile', hint: 'Identity + bio + socials', category: 'profile' },
    { type: 'link', label: 'Link', hint: 'Destination tile', category: 'content' },
    { type: 'social', label: 'Social', hint: 'Single social identity', category: 'social' },
    { type: 'socials_section', label: 'Social wall', hint: 'All your platforms', category: 'social' },
    { type: 'image', label: 'Image', hint: 'Full-bleed visual', category: 'media' },
    { type: 'youtube', label: 'YouTube', hint: 'Playable video card', category: 'media' },
    { type: 'video', label: 'Video', hint: 'Hosted media', category: 'media' },
    { type: 'gallery', label: 'Gallery', hint: 'Multi-image collage', category: 'media' },
    { type: 'spotify', label: 'Music', hint: 'Spotify, YouTube Music or Apple Music', category: 'media' },
    { type: 'quote', label: 'Quote', hint: 'Editorial quote', category: 'content' },
    { type: 'rich_text', label: 'Text', hint: 'Headline + copy', category: 'content' },
    { type: 'announcement', label: 'Announcement', hint: 'Announcement banner', category: 'utility' },
    { type: 'countdown', label: 'Countdown', hint: 'Live timer', category: 'utility' },
    { type: 'featured', label: 'Featured', hint: 'Featured project card', category: 'content' },
    { type: 'projects', label: 'Projects', hint: 'Selected work', category: 'content' },
    { type: 'store', label: 'Store', hint: 'Live products', category: 'commerce' },
    { type: 'newsletter', label: 'Newsletter', hint: 'Email capture', category: 'audience' },
    { type: 'contact', label: 'Contact', hint: 'Email + WhatsApp', category: 'interactive' },
    { type: 'links_section', label: 'Links', hint: 'All saved links', category: 'content' },
    { type: 'cta', label: 'CTA', hint: 'High-impact action', category: 'interactive' },
    { type: 'branding_footer', label: 'Brand footer', hint: 'Powered-by footer', category: 'utility' },
];
const LEGACY_SPANS = {
    '1x1': { columnSpan: 3, rowSpan: 2 },
    '2x1': { columnSpan: 6, rowSpan: 2 },
    '1x2': { columnSpan: 3, rowSpan: 4 },
    '2x2': { columnSpan: 6, rowSpan: 4 },
    full: { columnSpan: 12, rowSpan: 2 },
};
function isBentoBlockVisible(block, now = Date.now()) {
    if (!block.enabled)
        return false;
    const start = block.startAt ? Date.parse(block.startAt) : NaN;
    const end = block.endAt ? Date.parse(block.endAt) : NaN;
    return (!Number.isFinite(start) || now >= start) && (!Number.isFinite(end) || now < end);
}
function isScheduledVisible(value, now = Date.now()) {
    if (value.enabled === false)
        return false;
    const start = value.startAt ? Date.parse(value.startAt) : NaN;
    const end = value.endAt ? Date.parse(value.endAt) : NaN;
    return (!Number.isFinite(start) || now >= start) && (!Number.isFinite(end) || now < end);
}
function normalizeBentoSize(value) {
    return exports.BENTO_SIZES.includes(value) ? value : '1x1';
}
function getBentoSpan(size) {
    return LEGACY_SPANS[normalizeBentoSize(size)] || LEGACY_SPANS['1x1'];
}
function safeInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
}
function safePositive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}
function clampBentoGeometry(geometry, viewport = 'desktop') {
    const columns = exports.BENTO_VIEWPORT_COLUMNS[viewport];
    const source = geometry || { column: 1, row: 1, columnSpan: 3, rowSpan: 2 };
    const columnSpan = Math.min(columns, Math.max(1, safePositive(source.columnSpan, 3)));
    const rowSpan = Math.min(exports.BENTO_MAX_ROW_SPAN, Math.max(1, safePositive(source.rowSpan, 2)));
    const column = Math.min(Math.max(1, safeInt(source.column, 1)), Math.max(1, columns - columnSpan + 1));
    const row = Math.min(Math.max(1, safeInt(source.row, 1)), Math.max(1, exports.BENTO_GRID_ROWS - rowSpan + 1));
    return { column, row, columnSpan, rowSpan };
}
function legacyGeometry(block) {
    const span = getBentoSpan(normalizeBentoSize(block.size));
    return {
        column: safeInt(block.position?.column, 1),
        row: safeInt(block.position?.row, 1),
        columnSpan: span.columnSpan,
        rowSpan: span.rowSpan,
    };
}
function scaleGeometryToViewport(geometry, viewport) {
    if (viewport === 'desktop')
        return clampBentoGeometry(geometry, viewport);
    const targetColumns = exports.BENTO_VIEWPORT_COLUMNS[viewport];
    const scale = targetColumns / exports.BENTO_GRID_COLUMNS;
    const column = Math.floor((geometry.column - 1) * scale) + 1;
    const columnSpan = Math.max(1, Math.min(targetColumns, Math.round(geometry.columnSpan * scale)));
    return clampBentoGeometry({ column, row: geometry.row, columnSpan, rowSpan: geometry.rowSpan }, viewport);
}
function getBentoGeometry(block, viewport = 'desktop') {
    const explicit = block.geometry?.[viewport];
    if (explicit)
        return clampBentoGeometry(explicit, viewport);
    const desktop = block.geometry?.desktop ? clampBentoGeometry(block.geometry.desktop, 'desktop') : legacyGeometry(block);
    return scaleGeometryToViewport(desktop, viewport);
}
function closestLegacySize(geometry) {
    let best = '1x1';
    let bestScore = Number.POSITIVE_INFINITY;
    Object.keys(LEGACY_SPANS).forEach(size => {
        const span = LEGACY_SPANS[size];
        const score = Math.abs(span.columnSpan - geometry.columnSpan) * 2 + Math.abs(span.rowSpan - geometry.rowSpan);
        if (score < bestScore) {
            bestScore = score;
            best = size;
        }
    });
    return best;
}
function withBentoGeometry(block, geometry, viewport = 'desktop') {
    const nextGeometry = { ...(block.geometry || {}), [viewport]: clampBentoGeometry(geometry, viewport) };
    const desktop = nextGeometry.desktop ? clampBentoGeometry(nextGeometry.desktop, 'desktop') : getBentoGeometry(block, 'desktop');
    return {
        ...block,
        geometry: nextGeometry,
        position: { column: desktop.column, row: desktop.row },
        size: closestLegacySize(desktop),
    };
}
function cellsFor(g) {
    const cells = [];
    for (let row = g.row; row < g.row + g.rowSpan; row += 1) {
        for (let column = g.column; column < g.column + g.columnSpan; column += 1) {
            cells.push(`${row}:${column}`);
        }
    }
    return cells;
}
function canPlace(geometry, occupied, viewport) {
    const safe = clampBentoGeometry(geometry, viewport);
    if (safe.column !== geometry.column || safe.row !== geometry.row || safe.columnSpan !== geometry.columnSpan || safe.rowSpan !== geometry.rowSpan)
        return false;
    return cellsFor(safe).every(cell => !occupied.has(cell));
}
function mark(geometry, occupied) {
    cellsFor(geometry).forEach(cell => occupied.add(cell));
}
function placementDistance(a, b) {
    return Math.abs(a.row - b.row) * 12 + Math.abs(a.column - b.column) * 2;
}
function nearestFree(desired, occupied, viewport) {
    const safeDesired = clampBentoGeometry(desired, viewport);
    if (canPlace(safeDesired, occupied, viewport))
        return safeDesired;
    const columns = exports.BENTO_VIEWPORT_COLUMNS[viewport];
    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    const startRow = Math.max(1, safeDesired.row - 12);
    const endRow = Math.min(exports.BENTO_GRID_ROWS - safeDesired.rowSpan + 1, safeDesired.row + 160);
    for (let row = startRow; row <= endRow; row += 1) {
        for (let column = 1; column <= columns - safeDesired.columnSpan + 1; column += 1) {
            const candidate = { ...safeDesired, row, column };
            if (!canPlace(candidate, occupied, viewport))
                continue;
            const score = placementDistance(candidate, safeDesired);
            if (score < bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        if (best && row > safeDesired.row + 24)
            break;
    }
    return best || { ...safeDesired, column: 1, row: Math.max(1, endRow) };
}
function sortBlocksForLayout(blocks, viewport, anchorId) {
    const indexed = blocks.map((block, index) => ({ block, index, geometry: getBentoGeometry(block, viewport) }));
    return indexed.sort((a, b) => {
        if (a.block.id === anchorId)
            return -1;
        if (b.block.id === anchorId)
            return 1;
        const aPosLocked = a.block.locked || a.block.lockPosition;
        const bPosLocked = b.block.locked || b.block.lockPosition;
        if (aPosLocked && !bPosLocked)
            return -1;
        if (!aPosLocked && bPosLocked)
            return 1;
        return a.geometry.row - b.geometry.row || a.geometry.column - b.geometry.column || a.index - b.index;
    });
}
function getBentoLayout(blocks, viewport = 'desktop') {
    const visible = blocks.filter(block => block.enabled);
    const occupied = new Set();
    const layout = [];
    for (const { block } of sortBlocksForLayout(visible, viewport)) {
        const resolved = nearestFree(getBentoGeometry(block, viewport), occupied, viewport);
        layout.push({ id: block.id, ...resolved });
        mark(resolved, occupied);
    }
    return layout.sort((a, b) => a.row - b.row || a.column - b.column);
}
function arrangeBentoBlocks(blocks, viewport = 'desktop', anchorId, options = {}) {
    const next = blocks.map(block => ({ ...block, size: normalizeBentoSize(block.size) }));
    const visible = next.filter(block => block.enabled);
    const occupied = new Set();
    const placements = new Map();
    const ignoredLocks = options.ignoreLocks === true;
    // Locked geometry is sacred. Reserve it before resolving every other block so
    // collision handling moves unlocked blocks around it instead of moving the lock.
    if (!ignoredLocks) {
        for (const block of visible) {
            if (!(block.locked || block.lockPosition))
                continue;
            const geometry = clampBentoGeometry(getBentoGeometry(block, viewport), viewport);
            placements.set(block.id, geometry);
            mark(geometry, occupied);
        }
    }
    for (const { block } of sortBlocksForLayout(visible, viewport, anchorId)) {
        if (!ignoredLocks && (block.locked || block.lockPosition))
            continue;
        const desired = getBentoGeometry(block, viewport);
        const resolved = nearestFree(desired, occupied, viewport);
        placements.set(block.id, resolved);
        mark(resolved, occupied);
    }
    return next.map(block => {
        if (!block.enabled)
            return block;
        const geometry = placements.get(block.id) || getBentoGeometry(block, viewport);
        return withBentoGeometry(block, geometry, viewport);
    });
}
function packBentoBlocks(blocks, viewport = 'desktop') {
    const cleared = blocks.map(block => {
        if (block.locked || block.lockPosition)
            return block;
        const current = getBentoGeometry(block, viewport);
        return withBentoGeometry(block, { ...current, row: 1 }, viewport);
    });
    return arrangeBentoBlocks(cleared, viewport);
}
/**
 * Deterministic mobile layout used by both the editor preview and the public page.
 * Both modes preserve creator-defined responsive geometry; smart mode only repairs
 * collisions so the published page cannot diverge into a single-column stack.
 */
function resolveBentoBlocksForMobile(blocks, mobileMode = 'custom') {
    if (mobileMode !== 'smart' || validateBentoLayout(blocks, 'mobile'))
        return blocks;
    return arrangeBentoBlocks(blocks, 'mobile');
}
function findBentoAvailableGeometry(blocks, desired, viewport = 'desktop', excludeId) {
    const occupied = new Set();
    for (const block of blocks) {
        if (!block.enabled || block.id === excludeId)
            continue;
        const geometry = getBentoGeometry(block, viewport);
        if (!canPlace(geometry, occupied, viewport))
            continue;
        mark(geometry, occupied);
    }
    return nearestFree(desired, occupied, viewport);
}
function isBentoGeometryEqual(a, b) {
    if (!a || !b)
        return a === b;
    return a.column === b.column && a.row === b.row && a.columnSpan === b.columnSpan && a.rowSpan === b.rowSpan;
}
function reflowBentoPositions(blocks, viewport = 'desktop') {
    return arrangeBentoBlocks(blocks, viewport);
}
function clampBentoPosition(position, size, columns = exports.BENTO_GRID_COLUMNS, rows = exports.BENTO_GRID_ROWS) {
    const span = getBentoSpan(size);
    return {
        column: Math.min(Math.max(1, safeInt(position?.column, 1)), Math.max(1, columns - span.columnSpan + 1)),
        row: Math.min(Math.max(1, safeInt(position?.row, 1)), Math.max(1, rows - span.rowSpan + 1)),
    };
}
function normalizeBentoPlacement(block) {
    if (!block)
        return { column: 1, row: 1 };
    return clampBentoPosition(block.position, normalizeBentoSize(block.size));
}
function syncBentoPositions(blocks, viewport = 'desktop') {
    return arrangeBentoBlocks(blocks, viewport);
}
function isValidBentoPlacement(position, size, gridColumns = exports.BENTO_GRID_COLUMNS, gridRows = exports.BENTO_GRID_ROWS) {
    const span = getBentoSpan(normalizeBentoSize(size));
    const safe = clampBentoPosition(position, normalizeBentoSize(size), gridColumns, gridRows);
    return safe.column === Number(position?.column ?? 1) && safe.row === Number(position?.row ?? 1) && safe.column + span.columnSpan - 1 <= gridColumns && safe.row + span.rowSpan - 1 <= gridRows;
}
function validateBentoLayout(blocks, viewport) {
    const viewports = viewport ? [viewport] : ['desktop', 'tablet', 'mobile'];
    for (const currentViewport of viewports) {
        const visible = blocks.filter(block => block.enabled);
        const occupied = new Set();
        for (const block of visible) {
            const geometry = getBentoGeometry(block, currentViewport);
            if (!canPlace(geometry, occupied, currentViewport))
                return false;
            mark(geometry, occupied);
        }
    }
    return true;
}
function createBentoStarterBlocks(template = 'creator') {
    const types = exports.BENTO_STARTER_TEMPLATES[template]?.types || exports.BENTO_STARTER_TEMPLATES.creator.types;
    return types.map((type, index) => {
        const common = {
            id: `starter-${template}-${index + 1}`,
            type: type,
            size: (type === 'rich_text' || type === 'cta' || type === 'gallery' ? '2x2' : '2x1'),
            enabled: true, startAt: null, endAt: null, position: null, geometry: {},
            config: {}, locked: false, lockPosition: false, lockSize: false, lockStyle: false,
        };
        switch (type) {
            case 'rich_text':
                common.config = { kicker: 'WELCOME', title: 'A little corner of the internet.', body: 'Tell people what you make, teach or care about.' };
                break;
            case 'image':
                common.config = { imageUrl: '', alt: 'Featured visual', objectFit: 'cover', focalX: 50, focalY: 50 };
                break;
            case 'cta':
                common.config = { kicker: 'START HERE', title: 'Explore my work', body: 'A clear action for new visitors.', url: '' };
                break;
            case 'spotify':
                common.config = { provider: 'spotify', title: 'Listen now', subtitle: 'Open in Spotify', url: '' };
                break;
            case 'link':
                common.config = { label: 'My latest link', description: 'Add your most useful destination.', url: '' };
                break;
            case 'video':
                common.config = { videoUrl: '', posterUrl: '' };
                break;
            case 'gallery':
                common.config = { imageUrls: '' };
                break;
            default: common.config = {};
        }
        return common;
    });
}
function normaliseBentoBlocks(value) {
    if (!Array.isArray(value))
        return [];
    return value.slice(0, 120).flatMap((raw, index) => {
        const type = exports.BENTO_TYPES.some(item => item.type === raw?.type) ? raw.type : 'link';
        const size = normalizeBentoSize(raw?.size);
        const config = raw?.config && typeof raw.config === 'object' ? { ...raw.config } : {};
        const startAt = typeof raw?.startAt === 'string' && Number.isFinite(Date.parse(raw.startAt)) ? new Date(raw.startAt).toISOString() : null;
        const endAt = typeof raw?.endAt === 'string' && Number.isFinite(Date.parse(raw.endAt)) ? new Date(raw.endAt).toISOString() : null;
        const rawPosition = raw?.position && typeof raw.position === 'object' ? raw.position : null;
        const position = rawPosition ? { column: safeInt(rawPosition.column, 1), row: safeInt(rawPosition.row, 1) } : null;
        const rawGeometry = raw?.geometry && typeof raw.geometry === 'object' ? raw.geometry : {};
        const geometry = {};
        const explicitGeometry = (viewport) => {
            const candidate = rawGeometry[viewport];
            if (!candidate || typeof candidate !== 'object')
                return null;
            const g = candidate;
            return clampBentoGeometry({
                column: safeInt(g.column, 1),
                row: safeInt(g.row, 1),
                columnSpan: safeInt(g.columnSpan, 3),
                rowSpan: safeInt(g.rowSpan, 2),
            }, viewport);
        };
        const desktop = clampBentoGeometry(explicitGeometry('desktop') || legacyGeometry({ size, position }), 'desktop');
        geometry.desktop = desktop;
        geometry.tablet = explicitGeometry('tablet') || scaleGeometryToViewport(desktop, 'tablet');
        geometry.mobile = explicitGeometry('mobile') || scaleGeometryToViewport(desktop, 'mobile');
        const block = {
            id: String(raw?.id || `block-${index}`).slice(0, 80),
            type,
            size,
            enabled: raw?.enabled !== false,
            startAt,
            endAt,
            // Keep the legacy position field as a compatibility mirror of the
            // canonical desktop geometry so duplicate visual state cannot drift.
            position: { column: desktop.column, row: desktop.row },
            config,
            geometry,
            locked: raw?.locked === true,
            lockPosition: raw?.lockPosition === true,
            lockSize: raw?.lockSize === true,
            lockStyle: raw?.lockStyle === true,
            systemKey: typeof raw?.systemKey === 'string' ? raw.systemKey : undefined,
        };
        if (block.startAt && block.endAt && Date.parse(block.endAt) <= Date.parse(block.startAt))
            block.endAt = null;
        return [block];
    });
}
const BENTO_SYSTEM_TYPES = {
    profile: 'profile',
    socials_section: 'socials_section',
    featured: 'featured',
    projects: 'projects',
    store: 'store',
    newsletter: 'newsletter',
    contact: 'contact',
    links_section: 'links_section',
    branding_footer: 'branding_footer',
};
function validateBentoDocument(blocks) {
    const ids = new Set();
    const enabledSystemKeys = new Set();
    for (const block of blocks) {
        if (!block.id || ids.has(block.id))
            return false;
        ids.add(block.id);
        if (!exports.BENTO_TYPES.some(item => item.type === block.type))
            return false;
        if (!exports.BENTO_SIZES.includes(normalizeBentoSize(block.size)))
            return false;
        if (block.systemKey) {
            if (BENTO_SYSTEM_TYPES[block.systemKey] !== block.type)
                return false;
            if (block.enabled) {
                if (enabledSystemKeys.has(block.systemKey))
                    return false;
                enabledSystemKeys.add(block.systemKey);
            }
        }
        for (const viewport of ['desktop', 'tablet', 'mobile']) {
            const geometry = block.geometry?.[viewport];
            if (!geometry)
                return false;
            const safe = clampBentoGeometry(geometry, viewport);
            if (safe.column !== geometry.column || safe.row !== geometry.row || safe.columnSpan !== geometry.columnSpan || safe.rowSpan !== geometry.rowSpan)
                return false;
        }
    }
    return true;
}
/**
 * Canonical document normalization boundary. Normalization is intentionally
 * conservative: valid creator geometry is returned byte-for-byte equivalent
 * and only invalid/overlapping layouts are repaired. This is the only layer
 * that may repair a persisted Bento document before validation.
 */
function normalizeBentoDocument(value) {
    let next = normaliseBentoBlocks(value);
    if (!next.length)
        return next;
    for (const viewport of ['desktop', 'tablet', 'mobile']) {
        if (validateBentoLayout(next, viewport))
            continue;
        const repaired = arrangeBentoBlocks(next, viewport);
        if (validateBentoLayout(repaired, viewport))
            next = repaired;
    }
    return next;
}
function getBentoGridStyle(block, blocks = [], viewport = 'desktop') {
    const context = blocks.length ? blocks : [block];
    const placement = getBentoLayout(context, viewport).find(item => item.id === block.id) || getBentoGeometry(block, viewport);
    return {
        gridColumn: `${placement.column} / span ${placement.columnSpan}`,
        gridRow: `${placement.row} / span ${placement.rowSpan}`,
    };
}
function getBentoResponsiveGridStyle(block, blocks = []) {
    const context = blocks.length ? blocks : [block];
    const styles = {};
    ['desktop', 'tablet', 'mobile'].forEach(viewport => {
        const placement = getBentoLayout(context, viewport).find(item => item.id === block.id) || getBentoGeometry(block, viewport);
        styles[`--bento-${viewport}-column`] = placement.column;
        styles[`--bento-${viewport}-row`] = placement.row;
        styles[`--bento-${viewport}-column-span`] = placement.columnSpan;
        styles[`--bento-${viewport}-row-span`] = placement.rowSpan;
    });
    styles.gridColumn = 'var(--bento-desktop-column) / span var(--bento-desktop-column-span)';
    styles.gridRow = 'var(--bento-desktop-row) / span var(--bento-desktop-row-span)';
    return styles;
}
function bentoGridClass(size) {
    return `bento-size-${size.replace('x', '-')}`;
}
