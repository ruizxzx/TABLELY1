import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit } from '../../../lib/server-security';
import { getCreatorEntitlements, featureDenied } from '../../../lib/server-entitlements';
import { PUBLIC_CONTENT_SAFETY_LIMITS } from '../../../lib/public-limits';
import { normalizeBentoDocument, normalizeBentoPageDesign, validateBentoDocument, validateBentoLayout } from '../../../lib/bento';

export const dynamic = 'force-dynamic';
const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

function cleanUsername(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9_]/g, '').slice(0, 30);
}

function safeHex(value: unknown, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback;
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'studio-store-create', 10);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Please log in again.', 401);
    const body = await request.json() as { username?: unknown; name?: unknown; bio?: unknown };
    const name = String(body.name || '').trim();
    const username = cleanUsername(body.username);
    const bio = String(body.bio || '').trim();
    if (!name) return fail('Add a store name.');
    if (username.length < 3) return fail('Choose a store username with at least 3 letters, numbers or underscores.');

    const db = getAdminSupabase();
    const { data: existing, error: existingError } = await db.from('stores').select('*').eq('owner_id', user.id).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return NextResponse.json({ ok: true, data: existing, existing: true });
    const { error: profileError } = await db.from('profiles').upsert({ id: user.id, display_name: name }, { onConflict: 'id' });
    if (profileError) throw profileError;
    const { data: store, error: storeError } = await db.from('stores').insert({ owner_id: user.id, username, name, bio: bio || null }).select('*').single();
    if (storeError) {
      if (storeError.code === '23505') return fail('That username is already taken. Try another.', 409);
      throw storeError;
    }
    return NextResponse.json({ ok: true, data: store }, { status: 201 });
  } catch (error) {
    console.error('[studio/store:create]', error);
    return fail(error instanceof Error ? error.message : 'Could not create your store.', 500);
  }
}

export async function PATCH(request: Request) {
  const limited = withRateLimit(request, 'studio-store-update', 20);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Please log in again.', 401);
    const body = await request.json() as { username?: unknown; name?: unknown; bio?: unknown; emailCollection?: unknown; featuredProductId?: unknown; socialLinks?: unknown; themeConfig?: unknown; avatarUrl?: unknown; linkHubConfig?: unknown; expectedUpdatedAt?: unknown };
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.username !== undefined) {
      const username = cleanUsername(body.username);
      if (username.length < 3) return fail('Username must contain at least 3 letters, numbers or underscores.');
      patch.username = username;
    }
    if (body.name !== undefined) {
      const name = String(body.name || '').trim();
      if (!name) return fail('Store name cannot be empty.');
      patch.name = name;
    }
    if (body.bio !== undefined) patch.bio = String(body.bio || '').trim() || null;
    if (body.emailCollection !== undefined) patch.email_collection_enabled = Boolean(body.emailCollection);
    if (body.featuredProductId !== undefined) patch.featured_product_id = String(body.featuredProductId || '').trim() || null;
    if (body.socialLinks !== undefined) patch.social_links = body.socialLinks && typeof body.socialLinks === 'object' ? body.socialLinks : {};
    if (body.themeConfig !== undefined) patch.theme_config = body.themeConfig && typeof body.themeConfig === 'object' ? body.themeConfig : {};
    if (body.avatarUrl !== undefined) patch.avatar_url = String(body.avatarUrl || '').trim() || null;
    const db = getAdminSupabase();
    if (body.linkHubConfig !== undefined) {
      const config = body.linkHubConfig && typeof body.linkHubConfig === 'object' ? body.linkHubConfig as Record<string, unknown> : {};
      const entitlements = await getCreatorEntitlements(user.id);
      const requestedBlocks = normalizeBentoDocument(config.blocks);
      if (!validateBentoDocument(requestedBlocks)) return fail('Invalid Bento document.', 400);
      if (!validateBentoLayout(requestedBlocks)) return fail('Bento block layout overlaps or exceeds the allowed grid.', 400);
      if (requestedBlocks.some(block => block.startAt || block.endAt) && !entitlements.features.link_scheduling) return NextResponse.json(featureDenied(entitlements, 'link_scheduling', 'creator'), { status: 403 });
      const links = Array.isArray(config.links) ? config.links.slice(0, PUBLIC_CONTENT_SAFETY_LIMITS.bentoCollectionItems).map((item: any) => ({
        id: String(item?.id || '').slice(0, 80),
        kind: item?.kind === 'spotify' ? 'spotify' : 'link',
        platform: String(item?.platform || '').trim().slice(0, 40) || undefined,
        label: String(item?.label || '').trim().slice(0, 100),
        url: String(item?.url || '').trim().slice(0, 500),
        enabled: item?.enabled !== false,
        startAt: typeof item?.startAt === 'string' && Number.isFinite(Date.parse(item.startAt)) ? new Date(item.startAt).toISOString() : null,
        endAt: typeof item?.endAt === 'string' && Number.isFinite(Date.parse(item.endAt)) ? new Date(item.endAt).toISOString() : null,
        thumbnailUrl: /^https:\/\//i.test(String(item?.thumbnailUrl || '')) ? String(item?.thumbnailUrl).trim().slice(0, 500) : null,
        collectionId: item?.collectionId ? String(item.collectionId).slice(0, 80) : null,
        layout: item?.layout === 'featured' ? 'featured' : 'classic',
        animate: item?.animate === true,
      })) : [];
      if (links.some(link => link.enabled && (!link.label || !/^https:\/\//i.test(link.url)))) return fail('Every visible link needs a label and a full https:// URL.', 400);
      if (links.some(link => link.thumbnailUrl) && !entitlements.features.link_thumbnails) return NextResponse.json(featureDenied(entitlements, 'link_thumbnails', 'creator'), { status: 403 });
      if (links.some(link => link.startAt || link.endAt) && !entitlements.features.link_scheduling) return NextResponse.json(featureDenied(entitlements, 'link_scheduling', 'creator'), { status: 403 });
      const collections = Array.isArray(config.collections) ? config.collections.slice(0, 100).map((item: any) => ({ id: String(item?.id || '').slice(0, 80), title: String(item?.title || '').trim().slice(0, 80), enabled: item?.enabled !== false })).filter((item: any) => item.title && item.id) : [];
      const collectionIds = new Set(collections.map((item: any) => item.id));
      links.forEach((link: any) => { if (link.collectionId && !collectionIds.has(link.collectionId)) link.collectionId = null; });
      const socialLinks = config.socialLinks && typeof config.socialLinks === 'object' ? Object.fromEntries(Object.entries(config.socialLinks as Record<string, unknown>).slice(0, 12).map(([key, value]) => [key, String(value || '').trim().slice(0, 500)])) : {};
      const legacyProjects = Array.isArray(config.projects) ? config.projects.slice(0, PUBLIC_CONTENT_SAFETY_LIMITS.bentoCollectionItems).map((item: any) => ({
        id: String(item?.id || '').slice(0, 80), name: String(item?.name || '').trim().slice(0, 80), description: String(item?.description || '').trim().slice(0, 180), url: String(item?.url || '').trim().slice(0, 500), image: String(item?.image || '').trim().slice(0, 500),
      })) : [];
      const featured = config.featured && typeof config.featured === 'object' ? {
        title: String((config.featured as any).title || '').trim().slice(0, 100),
        description: String((config.featured as any).description || '').trim().slice(0, 240),
        url: String((config.featured as any).url || '').trim().slice(0, 500),
        image: String((config.featured as any).image || '').trim().slice(0, 500),
      } : null;
      patch.link_hub_config = {
        ...config,
        publicTemplate: config.publicTemplate === 'bento' ? 'bento' : 'default',
        primaryPage: config.primaryPage === 'linkhub' ? 'linkhub' : 'store',
        enabled: config.enabled !== false,
        onboardingComplete: config.onboardingComplete === true,
        theme: ['editorial', 'edge', 'candy', 'minimal', 'midnight', 'garden'].includes(String(config.theme)) ? String(config.theme) : 'editorial',
        title: String(config.title || '').trim().slice(0, 80),
        bio: String(config.bio || '').trim().slice(0, 240),
        location: String(config.location || '').trim().slice(0, 100),
        availability: String(config.availability || '').trim().slice(0, 100),
        verified: config.verified === true,
        contactEmail: String(config.contactEmail || '').trim().slice(0, 320),
        whatsapp: String(config.whatsapp || '').trim().slice(0, 40),
        contactTitle: String(config.contactTitle || '').trim().slice(0, 120),
        newsletterEnabled: config.newsletterEnabled !== false,
        featured,
        projects: legacyProjects,
        background: safeHex(config.background, '#f5f1ea'),
        accent: safeHex(config.accent, '#d7653f'),
        textColor: safeHex(config.textColor, '#171811'),
        mutedTextColor: safeHex(config.mutedTextColor, '#68695e'),
        buttonStyle: ['solid', 'soft', 'outline'].includes(String(config.buttonStyle)) ? String(config.buttonStyle) : 'solid',
        linkShape: ['rounded', 'pill', 'square'].includes(String(config.linkShape)) ? String(config.linkShape) : 'rounded',
        linkShadow: config.linkShadow !== false,
        linkTextAlign: config.linkTextAlign === 'left' ? 'left' : 'center',
        collections,
        sectionOrder: Array.isArray(config.sectionOrder) ? config.sectionOrder.map(value => String(value)).slice(0, 30) : [],
        bentoDesign: normalizeBentoPageDesign(config.bentoDesign),
        links,
        socialLinks,
        blocks: requestedBlocks,
      };
    }
    if (body.linkHubConfig !== undefined && body.expectedUpdatedAt !== undefined) {
      const { data: current, error: currentError } = await db.from('stores').select('updated_at').eq('owner_id', user.id).single();
      if (currentError) throw currentError;
      if (String(current.updated_at || '') !== String(body.expectedUpdatedAt || '')) return fail('This Link Hub changed in another tab or window. Reload before saving again.', 409);
    }
    if (body.linkHubConfig !== undefined && patch.link_hub_config && typeof patch.link_hub_config === 'object') {
      const { data: verification } = await db.from('creator_verifications').select('status').eq('creator_id', user.id).maybeSingle();
      (patch.link_hub_config as Record<string, unknown>).verified = verification?.status === 'verified';
    }
    let updateQuery = db.from('stores').update(patch).eq('owner_id', user.id);
    const expectedUpdatedAt = body.linkHubConfig !== undefined && body.expectedUpdatedAt !== undefined
      ? String(body.expectedUpdatedAt || '')
      : '';
    if (expectedUpdatedAt) updateQuery = updateQuery.eq('updated_at', expectedUpdatedAt);
    const { data: store, error } = await updateQuery.select('*').maybeSingle();
    if (error) {
      if (error.code === '23505') return fail('That username is already taken. Try another.', 409);
      throw error;
    }
    if (!store) {
      if (expectedUpdatedAt) return fail('This Link Hub changed in another tab or window. Reload before saving again.', 409);
      return fail('Store record not found.', 404);
    }
    if (patch.name) await db.from('profiles').update({ display_name: patch.name }).eq('id', user.id);
    return NextResponse.json({ ok: true, data: store });
  } catch (error) {
    console.error('[studio/store:update]', error);
    return fail(error instanceof Error ? error.message : 'Could not save your store settings.', 500);
  }
}