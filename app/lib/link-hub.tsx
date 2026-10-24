import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import BentoPublicRenderer from '../components/BentoPublicRenderer';
import ClassicLinkHubRenderer from '../components/ClassicLinkHubRenderer';
import { normalizeBentoPageDesign } from './bento';
import { getCanonicalBentoBlocks } from './bento-hub';
import { PUBLIC_CONTENT_SAFETY_LIMITS } from './public-limits';
import { getLinkHubPath, getLinkHubPublicTemplate, getPrimaryPublicPage, withPreservedQuery, type PublicSearchParams } from './public-paths';
import { getAppBaseUrl } from './site';
import { publicMediaUrl } from './storage';
import { supabase } from './supabase';

type HubRouteProps = {
  params: Promise<{ username: string }>;
  searchParams?: Promise<PublicSearchParams>;
};

function normalizeUsername(rawUsername: string) {
  return rawUsername.replace(/^@/, '').toLowerCase();
}

function resolveAvatarUrl(avatar: unknown) {
  if (typeof avatar !== 'string' || avatar.startsWith('http')) return null;
  return publicMediaUrl(avatar);
}

function normalizeButtonStyle(value: unknown): 'solid' | 'soft' | 'outline' {
  return value === 'soft' || value === 'outline' ? value : 'solid';
}

function normalizeLinkShape(value: unknown): 'rounded' | 'pill' | 'square' {
  return value === 'pill' || value === 'square' ? value : 'rounded';
}

export async function generateMetadata({ params }: HubRouteProps, explicitLinkHubPath: unknown = false): Promise<Metadata> {
  const explicit = explicitLinkHubPath === true;
  const rawUsername = decodeURIComponent((await params).username);
  const username = normalizeUsername(rawUsername);
  if (!supabase) return { title: 'Link hub unavailable — TABLELY' };
  const { data } = await supabase.from('stores').select('name,bio,status,avatar_url,link_hub_config').eq('username', username).maybeSingle();
  if (!data || data.status !== 'active') return { title: 'Link hub not found — TABLELY' };
  const hub = data.link_hub_config || {};
  const primaryPage = getPrimaryPublicPage(hub.primaryPage);
  const title = hub.title || data.name;
  const description = hub.bio || `Links from @${username}.`;
  const canonicalPath = explicit ? getLinkHubPath(username, 'store') : getLinkHubPath(username, primaryPage);
  const canonical = `${getAppBaseUrl()}${canonicalPath}`;
  const avatar = resolveAvatarUrl(data.avatar_url);
  return {
    title: `${title} — TABLELY`,
    description,
    alternates: { canonical },
    openGraph: {
      title: `${title} — TABLELY`,
      description,
      url: canonical,
      type: 'website',
      images: avatar ? [{ url: avatar }] : undefined,
    },
  };
}

export async function renderLinkHubPage({ params, searchParams }: HubRouteProps, _explicitLinkHubPath = false) {
  const rawUsername = decodeURIComponent((await params).username);
  const username = normalizeUsername(rawUsername);
  if (!supabase) notFound();

  const { data: store, error } = await supabase.from('stores').select('*').eq('username', username).maybeSingle();
  if (error || !store || store.status !== 'active') notFound();

  const hub = store.link_hub_config || {};
  if (hub.enabled === false) notFound();
  const primaryPage = getPrimaryPublicPage(hub.primaryPage);

  if (rawUsername.startsWith('@')) {
    redirect(withPreservedQuery(getLinkHubPath(username, primaryPage), searchParams ? await searchParams : undefined));
  }

  const shareUrl = `${getAppBaseUrl()}${getLinkHubPath(store.username, primaryPage)}`;
  const avatarUrl = resolveAvatarUrl(store.avatar_url);
  const verified = Boolean(store.verified_badge ?? hub.verified);
  const links = Array.isArray(hub.links) ? hub.links : [];
  const collections = Array.isArray(hub.collections) ? hub.collections : [];
  const projects = Array.isArray(hub.projects) ? hub.projects : [];

  if (getLinkHubPublicTemplate(hub.publicTemplate) === 'bento') {
    const { data: products } = await supabase
      .from('public_products')
      .select('id,title,slug,short_description,price,currency,cover_image_path,category_name')
      .eq('store_id', store.id)
      .order('created_at', { ascending: false })
      .limit(PUBLIC_CONTENT_SAFETY_LIMITS.storeProducts);
    const blocks = getCanonicalBentoBlocks({
      title: hub.title || store.name,
      bio: hub.bio,
      location: hub.location,
      availability: hub.availability,
      verified,
      avatarUrl,
      socialLinks: hub.socialLinks || {},
      featured: hub.featured || null,
      projects,
      links,
      newsletterEnabled: hub.newsletterEnabled !== false,
      contactEmail: hub.contactEmail || '',
      whatsapp: hub.whatsapp || '',
      contactTitle: hub.contactTitle,
      username: store.username,
      primaryPage,
      products: (products || []).map((product: any) => ({ ...product, image: publicMediaUrl(product.cover_image_path) })),
      branding: true,
      existingBlocks: Array.isArray(hub.blocks) ? hub.blocks : [],
    });
    return (
      <BentoPublicRenderer
        blocks={blocks}
        design={normalizeBentoPageDesign(hub.bentoDesign)}
        storeId={store.id}
        shareUrl={shareUrl}
        interactive
        showBeacon
      />
    );
  }

  return (
    <ClassicLinkHubRenderer
      storeId={store.id}
      shareUrl={shareUrl}
      title={hub.title || store.name}
      bio={hub.bio || ''}
      avatarUrl={avatarUrl}
      verified={verified}
      location={hub.location || ''}
      availability={hub.availability || ''}
      socialLinks={hub.socialLinks || {}}
      links={links}
      collections={collections}
      featured={hub.featured || null}
      projects={projects}
      contactEmail={hub.contactEmail || ''}
      whatsapp={hub.whatsapp || ''}
      contactTitle={hub.contactTitle}
      newsletterEnabled={hub.newsletterEnabled !== false}
      branding
      username={store.username}
      primaryPage={primaryPage}
      background={hub.background || '#f5f1ea'}
      accent={hub.accent || '#d7653f'}
      textColor={hub.textColor || '#171811'}
      mutedTextColor={hub.mutedTextColor || '#68695e'}
      buttonStyle={normalizeButtonStyle(hub.buttonStyle)}
      linkShape={normalizeLinkShape(hub.linkShape)}
      linkShadow={hub.linkShadow !== false}
      linkTextAlign={hub.linkTextAlign === 'left' ? 'left' : 'center'}
    />
  );
}

export default function LinkHubPage({ params, searchParams }: HubRouteProps) {
  return renderLinkHubPage({ params, searchParams });
}
