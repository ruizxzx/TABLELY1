"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_NODE_KEYS = void 0;
exports.hasCompleteBentoDocument = hasCompleteBentoDocument;
exports.buildHubBentoBlocks = buildHubBentoBlocks;
exports.hydrateBentoBlocksFromHubSource = hydrateBentoBlocksFromHubSource;
exports.getCanonicalBentoBlocks = getCanonicalBentoBlocks;
exports.extractHubPatchFromBentoBlocks = extractHubPatchFromBentoBlocks;
const bento_1 = require("./bento");
exports.SYSTEM_NODE_KEYS = ['profile', 'socials_section', 'featured', 'projects', 'store', 'newsletter', 'contact', 'links_section', 'branding_footer'];
function hasCompleteBentoDocument(blocks) {
    const present = new Set();
    const enabledDuplicates = new Set();
    for (const block of blocks) {
        if (!block.systemKey)
            continue;
        if (SYSTEM_TYPES[block.systemKey] !== block.type)
            return false;
        if (present.has(block.systemKey) && block.enabled)
            enabledDuplicates.add(block.systemKey);
        present.add(block.systemKey);
    }
    return enabledDuplicates.size === 0 && exports.SYSTEM_NODE_KEYS.every(key => present.has(key));
}
const SYSTEM_TYPES = {
    profile: 'profile', socials_section: 'socials_section', featured: 'featured', projects: 'projects', store: 'store', newsletter: 'newsletter', contact: 'contact', links_section: 'links_section', branding_footer: 'branding_footer',
};
const DEFAULT_GEOMETRY = {
    profile: { column: 1, row: 1, columnSpan: 12, rowSpan: 5 },
    featured: { column: 7, row: 6, columnSpan: 6, rowSpan: 4 },
    socials_section: { column: 1, row: 6, columnSpan: 6, rowSpan: 4 },
    links_section: { column: 1, row: 10, columnSpan: 6, rowSpan: 4 },
    store: { column: 7, row: 10, columnSpan: 6, rowSpan: 4 },
    projects: { column: 1, row: 14, columnSpan: 8, rowSpan: 5 },
    newsletter: { column: 9, row: 14, columnSpan: 4, rowSpan: 5 },
    contact: { column: 9, row: 19, columnSpan: 4, rowSpan: 3 },
    branding_footer: { column: 1, row: 22, columnSpan: 12, rowSpan: 2 },
};
const MOBILE_GEOMETRY = {
    profile: { column: 1, row: 1, columnSpan: 4, rowSpan: 5 },
    socials_section: { column: 1, row: 6, columnSpan: 2, rowSpan: 4 },
    featured: { column: 3, row: 6, columnSpan: 2, rowSpan: 4 },
    links_section: { column: 1, row: 10, columnSpan: 2, rowSpan: 4 },
    store: { column: 3, row: 10, columnSpan: 2, rowSpan: 4 },
    projects: { column: 1, row: 14, columnSpan: 4, rowSpan: 5 },
    newsletter: { column: 1, row: 19, columnSpan: 4, rowSpan: 5 },
    contact: { column: 1, row: 24, columnSpan: 4, rowSpan: 3 },
    branding_footer: { column: 1, row: 27, columnSpan: 4, rowSpan: 2 },
};
const TABLET_GEOMETRY = {
    profile: { column: 1, row: 1, columnSpan: 8, rowSpan: 5 },
    socials_section: { column: 1, row: 6, columnSpan: 4, rowSpan: 4 },
    featured: { column: 5, row: 6, columnSpan: 4, rowSpan: 4 },
    links_section: { column: 1, row: 10, columnSpan: 4, rowSpan: 4 },
    store: { column: 5, row: 10, columnSpan: 4, rowSpan: 4 },
    projects: { column: 1, row: 14, columnSpan: 5, rowSpan: 5 },
    newsletter: { column: 6, row: 14, columnSpan: 3, rowSpan: 5 },
    contact: { column: 6, row: 19, columnSpan: 3, rowSpan: 3 },
    branding_footer: { column: 1, row: 22, columnSpan: 8, rowSpan: 2 },
};
function buildStarterGeometry(blocks, viewport) {
    const enabled = blocks.filter(block => block.enabled);
    const columns = viewport === 'desktop' ? 12 : viewport === 'tablet' ? 8 : 4;
    const half = Math.max(1, Math.floor(columns / 2));
    const profile = enabled.find(block => block.systemKey === 'profile');
    const footer = enabled.find(block => block.systemKey === 'branding_footer');
    const content = enabled.filter(block => block.id !== profile?.id && block.id !== footer?.id);
    let row = 1;
    const positions = new Map();
    if (profile) {
        const profileHeight = Math.max(4, (0, bento_1.getBentoGeometry)(profile, viewport).rowSpan);
        positions.set(profile.id, { column: 1, row, columnSpan: columns, rowSpan: profileHeight });
        row += profileHeight;
    }
    if (viewport === 'mobile') {
        for (const block of content) {
            const height = Math.max(3, (0, bento_1.getBentoGeometry)(block, viewport).rowSpan);
            positions.set(block.id, { column: 1, row, columnSpan: columns, rowSpan: height });
            row += height;
        }
    }
    else {
        for (let index = 0; index < content.length; index += 2) {
            const first = content[index];
            const second = content[index + 1];
            const firstHeight = Math.max(3, (0, bento_1.getBentoGeometry)(first, viewport).rowSpan);
            const secondHeight = second ? Math.max(3, (0, bento_1.getBentoGeometry)(second, viewport).rowSpan) : 0;
            const rowSpan = second ? Math.max(firstHeight, secondHeight) : firstHeight;
            // A lone final block should use the full row; half-width here would recreate
            // the empty-space problem on a brand-new account. Paired blocks remain balanced.
            positions.set(first.id, {
                column: 1,
                row,
                columnSpan: second ? half : columns,
                rowSpan,
            });
            if (second)
                positions.set(second.id, { column: half + 1, row, columnSpan: columns - half, rowSpan });
            row += rowSpan;
        }
    }
    if (footer) {
        const footerHeight = Math.max(2, (0, bento_1.getBentoGeometry)(footer, viewport).rowSpan);
        positions.set(footer.id, { column: 1, row, columnSpan: columns, rowSpan: footerHeight });
    }
    return blocks.map(block => {
        const geometry = positions.get(block.id);
        return geometry ? (0, bento_1.withBentoGeometry)(block, geometry, viewport) : block;
    });
}
function clone(value) {
    return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}
function cleanUrl(value) {
    if (typeof value !== 'string')
        return '';
    const trimmed = value.trim();
    if (/^(https?:|mailto:|tel:|sms:|whatsapp:)/i.test(trimmed))
        return trimmed;
    if (/^(\/|#)/.test(trimmed))
        return trimmed;
    return '';
}
function mergeVisualConfig(previous, content) {
    const old = previous?.config || {};
    return { ...old, ...content, system: true };
}
function buildSystemBlock(key, source, previous) {
    const type = SYSTEM_TYPES[key];
    const base = {
        id: previous?.id || `system-${key}`,
        type,
        size: previous?.size || '2x2',
        enabled: previous?.enabled ?? true,
        startAt: previous?.startAt || null,
        endAt: previous?.endAt || null,
        position: previous?.position || null,
        geometry: clone(previous?.geometry),
        config: mergeVisualConfig(previous, {}),
        locked: previous?.locked === true,
        lockPosition: previous?.lockPosition === true,
        lockSize: previous?.lockSize === true,
        lockStyle: previous?.lockStyle === true,
        systemKey: key,
    };
    const socials = Object.entries(source.socialLinks || {}).filter(([, value]) => cleanUrl(value));
    const links = (source.links || []).filter(link => link.label);
    const projects = source.projects || [];
    const products = source.products || [];
    const featured = source.featured || null;
    const defaultsByKey = {
        profile: {
            avatarUrl: source.avatarUrl || '', title: source.title || 'Your name', bio: source.bio || 'Your corner of the internet.',
            location: source.location || '', availability: source.availability || '', verified: source.verified === true,
        },
        socials_section: { title: 'Find me online' },
        featured: { title: featured?.title || 'Featured project', description: featured?.description || '', url: featured?.url || '', image: featured?.image || '' },
        projects: { title: 'Projects', description: '', displayLimit: 8 },
        store: { title: 'My store', description: 'Digital products, templates and resources.', username: source.username || '', primaryPage: source.primaryPage || 'store', displayLimit: 4 },
        newsletter: { title: 'Useful stuff. No clutter.', description: 'Projects, tutorials, new drops and things worth knowing.', enabled: source.newsletterEnabled !== false },
        contact: { contactTitle: source.contactTitle || "Let’s build something.", contactEmail: source.contactEmail || '', whatsapp: source.whatsapp || '', description: 'Freelance work, collaborations, startup ideas or sponsorships.' },
        links_section: { title: 'More links', displayLimit: 10 },
        branding_footer: { label: 'Made with TABLELY', url: '/' },
    };
    const previousConfig = previous?.config || {};
    const editable = { ...defaultsByKey[key], ...previousConfig };
    base.config = {
        ...previousConfig,
        ...editable,
        ...(key === 'profile' ? {
            socials: Object.prototype.hasOwnProperty.call(previousConfig, 'socials') ? clone(previousConfig.socials) : Object.fromEntries(socials),
            avatarUrl: Object.prototype.hasOwnProperty.call(previousConfig, 'avatarUrl') ? clone(previousConfig.avatarUrl) : (source.avatarUrl || ''),
        } : {}),
        ...(key === 'socials_section' ? { socials: Object.prototype.hasOwnProperty.call(previousConfig, 'socials') ? clone(previousConfig.socials) : Object.fromEntries(socials) } : {}),
        ...(key === 'featured' ? { featured: Object.prototype.hasOwnProperty.call(previousConfig, 'featured') ? clone(previousConfig.featured) : (featured ? clone(featured) : null) } : {}),
        ...(key === 'projects' ? { projects: Object.prototype.hasOwnProperty.call(previousConfig, 'projects') ? clone(previousConfig.projects) : clone(projects) } : {}),
        ...(key === 'store' ? { products: Object.prototype.hasOwnProperty.call(previousConfig, 'products') ? clone(previousConfig.products) : clone(products), username: Object.prototype.hasOwnProperty.call(previousConfig, 'username') ? String(previousConfig.username || '') : (source.username || ''), primaryPage: source.primaryPage || 'store' } : {}),
        ...(key === 'newsletter' ? { enabled: Object.prototype.hasOwnProperty.call(previousConfig, 'enabled') ? previousConfig.enabled : source.newsletterEnabled !== false } : {}),
        ...(key === 'contact' ? { contactEmail: Object.prototype.hasOwnProperty.call(previousConfig, 'contactEmail') ? String(previousConfig.contactEmail || '') : (source.contactEmail || ''), whatsapp: Object.prototype.hasOwnProperty.call(previousConfig, 'whatsapp') ? String(previousConfig.whatsapp || '') : (source.whatsapp || '') } : {}),
        ...(key === 'links_section' ? { links: Object.prototype.hasOwnProperty.call(previousConfig, 'links') ? clone(previousConfig.links) : clone(links) } : {}),
        system: true,
    };
    const naturalEnabled = key === 'profile'
        ? true
        : key === 'socials_section' ? socials.length > 0
            : key === 'featured' ? Boolean(featured && (cleanUrl(featured.url) || featured.title))
                : key === 'projects' ? projects.length > 0
                    : key === 'store' ? products.length > 0
                        : key === 'newsletter' ? source.newsletterEnabled !== false
                            : key === 'contact' ? Boolean(source.contactEmail || source.whatsapp)
                                : key === 'links_section' ? links.length > 0
                                    : key === 'branding_footer' ? source.branding === true
                                        : false;
    base.enabled = previous ? previous.enabled : naturalEnabled;
    if (key === 'newsletter' && previous?.enabled !== undefined)
        base.enabled = previous.enabled;
    if (key === 'profile')
        base.config.verified = source.verified === true && previous?.config?.verified !== false;
    if (!previous?.geometry?.desktop)
        base.geometry = { ...(base.geometry || {}), desktop: DEFAULT_GEOMETRY[key] };
    if (!base.position)
        base.position = { column: DEFAULT_GEOMETRY[key].column, row: DEFAULT_GEOMETRY[key].row };
    if (!base.geometry?.desktop)
        return (0, bento_1.withBentoGeometry)(base, DEFAULT_GEOMETRY[key], 'desktop');
    const desktop = (0, bento_1.getBentoGeometry)(base, 'desktop');
    let result = (0, bento_1.withBentoGeometry)(base, desktop, 'desktop');
    if (!result.geometry?.tablet)
        result = (0, bento_1.withBentoGeometry)(result, TABLET_GEOMETRY[key], 'tablet');
    if (!result.geometry?.mobile)
        result = (0, bento_1.withBentoGeometry)(result, MOBILE_GEOMETRY[key], 'mobile');
    return result;
}
function appendMissingNodesWithoutMovingExisting(blocks, missing, viewport) {
    const columns = viewport === 'desktop' ? 12 : viewport === 'tablet' ? 8 : 4;
    const missingIds = new Set(missing.map(block => block.id));
    let maxRow = 0;
    for (const block of blocks) {
        if (!block.enabled || missingIds.has(block.id))
            continue;
        const geometry = (0, bento_1.getBentoGeometry)(block, viewport);
        maxRow = Math.max(maxRow, geometry.row + geometry.rowSpan - 1);
    }
    let cursorRow = Math.max(1, maxRow + 1);
    return blocks.map(block => {
        if (!missingIds.has(block.id) || !block.enabled)
            return block;
        const desired = (0, bento_1.getBentoGeometry)(block, viewport);
        const column = Math.min(Math.max(1, desired.column), Math.max(1, columns - desired.columnSpan + 1));
        const geometry = { ...desired, column, row: cursorRow };
        cursorRow += geometry.rowSpan;
        return (0, bento_1.withBentoGeometry)(block, geometry, viewport);
    });
}
/**
 * Migration/starter helper only.
 *
 * Complete canonical Bento documents must never pass through this function on
 * normal editor/public loads. For an existing partial/legacy document it preserves
 * every existing node and its geometry, then appends only missing system nodes.
 * For a genuinely new document it creates the deterministic starter layout.
 */
function buildHubBentoBlocks(source) {
    const existing = (0, bento_1.normaliseBentoBlocks)(Array.isArray(source.existingBlocks) ? source.existingBlocks : []);
    const starterTemplate = typeof source.starterTemplate === 'string' ? source.starterTemplate : '';
    const isTemplateSeed = Boolean(starterTemplate) && existing.length > 0 && existing.every(block => !block.systemKey && block.id.startsWith(`starter-${starterTemplate}-`));
    const preferredBySystemKey = new Map();
    for (const key of exports.SYSTEM_NODE_KEYS) {
        const candidates = existing.filter(block => block.systemKey === key && SYSTEM_TYPES[key] === block.type);
        const preferred = candidates.find(block => block.enabled) || candidates[0];
        if (preferred)
            preferredBySystemKey.set(key, preferred);
    }
    const system = new Map();
    exports.SYSTEM_NODE_KEYS.forEach(key => system.set(key, buildSystemBlock(key, source, preferredBySystemKey.get(key))));
    const seen = new Set();
    const result = [];
    for (const block of existing) {
        // Existing nodes are already creator-authored state. Never replace them
        // from the legacy-derived system template during migration. If historical
        // data contains duplicates, retain the preferred visible/first node and
        // disable only the competing records so no second visual owner remains.
        if (block.systemKey) {
            const preferred = preferredBySystemKey.get(block.systemKey);
            if (preferred && preferred.id !== block.id) {
                result.push({ ...block, enabled: false });
                continue;
            }
            if (seen.has(block.systemKey)) {
                result.push({ ...block, enabled: false });
                continue;
            }
            seen.add(block.systemKey);
        }
        result.push(block);
    }
    const missing = exports.SYSTEM_NODE_KEYS.filter(key => !seen.has(key)).map(key => system.get(key));
    if (!existing.length || isTemplateSeed) {
        const starter = [...result, ...missing];
        let arranged = starter;
        for (const viewport of ['desktop', 'tablet', 'mobile']) {
            arranged = buildStarterGeometry(arranged, viewport);
        }
        return hydrateBentoBlocksFromHubSource(arranged, source);
    }
    let migrated = [...result, ...missing];
    for (const viewport of ['desktop', 'tablet', 'mobile']) {
        migrated = appendMissingNodesWithoutMovingExisting(migrated, missing, viewport);
    }
    return hydrateBentoBlocksFromHubSource(migrated, source);
}
function hydrateBentoBlocksFromHubSource(blocks, source) {
    const socials = Object.entries(source.socialLinks || {}).filter(([, value]) => cleanUrl(value));
    const links = (source.links || []).filter(link => link.label);
    const projects = source.projects || [];
    const products = source.products || [];
    return blocks.map(block => {
        const config = { ...(block.config || {}) };
        if (block.systemKey === 'profile') {
            if (source.avatarUrl !== undefined)
                config.avatarUrl = source.avatarUrl || '';
            if (source.verified !== undefined)
                config.verified = source.verified === true;
        }
        if (block.systemKey === 'socials_section') {
            config.socials = Object.fromEntries(socials);
        }
        if (block.systemKey === 'projects') {
            config.projects = clone(projects);
        }
        if (block.systemKey === 'store') {
            config.products = clone(products);
            if (source.username !== undefined)
                config.username = source.username || '';
        }
        if (block.systemKey === 'links_section') {
            config.links = clone(links);
        }
        if (block.systemKey === 'contact') {
            config.contactEmail = source.contactEmail || '';
            config.whatsapp = source.whatsapp || '';
        }
        return { ...block, config };
    });
}
function getCanonicalBentoBlocks(source) {
    const persistedInput = Array.isArray(source.existingBlocks) ? source.existingBlocks : [];
    const persisted = (0, bento_1.normalizeBentoDocument)(persistedInput);
    if (hasCompleteBentoDocument(persisted))
        return hydrateBentoBlocksFromHubSource(persisted, source);
    return buildHubBentoBlocks({ ...source, existingBlocks: persisted });
}
function extractHubPatchFromBentoBlocks(blocks) {
    const patch = {};
    const getConfig = (key) => blocks.find(block => block.systemKey === key)?.config || null;
    const profile = getConfig('profile');
    if (profile) {
        patch.title = String(profile.title || '');
        patch.bio = String(profile.bio || '');
        patch.location = String(profile.location || '');
        patch.availability = String(profile.availability || '');
    }
    const socials = getConfig('socials_section');
    if (socials?.socials && typeof socials.socials === 'object') {
        patch.socialLinks = socials.socials;
    }
    const featured = getConfig('featured');
    if (featured) {
        const current = featured.featured && typeof featured.featured === 'object' ? featured.featured : {};
        patch.featured = {
            title: String(featured.title || current.title || ''),
            description: String(featured.description || current.description || ''),
            url: String(featured.url || current.url || ''),
            image: String(featured.image || current.image || ''),
        };
    }
    const projects = getConfig('projects');
    if (projects && Array.isArray(projects.projects)) {
        patch.projects = projects.projects;
    }
    const store = getConfig('store');
    if (store)
        patch.storeDisplay = { title: String(store.title || ''), description: String(store.description || ''), displayLimit: store.displayLimit };
    const newsletter = getConfig('newsletter');
    if (newsletter) {
        patch.newsletterEnabled = newsletter.enabled !== false;
        patch.newsletterTitle = String(newsletter.title || '');
        patch.newsletterDescription = String(newsletter.description || '');
    }
    const contact = getConfig('contact');
    if (contact) {
        patch.contactEmail = String(contact.contactEmail || '');
        patch.whatsapp = String(contact.whatsapp || '');
        patch.contactTitle = String(contact.contactTitle || '');
    }
    const links = getConfig('links_section');
    if (links?.links && Array.isArray(links.links))
        patch.links = links.links;
    return patch;
}
