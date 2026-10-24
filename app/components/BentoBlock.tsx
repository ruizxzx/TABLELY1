'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import Link from 'next/link';
import { MapPin } from 'lucide-react';
import { getBentoMusicProvider, isValidBentoMusicUrl, normalizeBentoMusicProvider } from '../lib/bento';
import type { BentoBlock as BentoBlockData, BentoMusicProvider, BentoViewport } from '../lib/bento';
import { getBentoGeometry, getBentoResponsiveGridStyle } from '../lib/bento';
import { inferSocialPlatform, getSocialPlatform, SocialIcon } from './SocialIcon';
import EmailCapture from './EmailCapture';
import { getPrimaryPublicPage, getProductPath, getStorePath } from '../lib/public-paths';
import { PUBLIC_CONTENT_SAFETY_LIMITS } from '../lib/public-limits';
import { createAnalyticsEventId, getAnalyticsAttribution, getAnalyticsIdentity } from '../lib/analytics-client';

function safeLinkUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(https?:|mailto:|tel:|sms:|whatsapp:)/i.test(trimmed)) return trimmed;
  if (/^(\/|#)/.test(trimmed)) return trimmed;
  return null;
}

function safeMediaUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function youtubeId(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).match(/^[\w-]{6,}$/)?.[0] || null;
    if (url.hostname.endsWith('youtube.com')) return url.searchParams.get('v')?.match(/^[\w-]{6,}$/)?.[0] || url.pathname.match(/\/(?:embed|shorts)\/([\w-]{6,})/)?.[1] || null;
  } catch {}
  return null;
}

function Countdown({ target, expiredText }: { target: string; expiredText: string }) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!Number.isFinite(Date.parse(target))) return;
    const update = () => setRemaining(Math.max(0, Date.parse(target) - Date.now()));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  if (!Number.isFinite(Date.parse(target))) return <span>{expiredText || 'Set a target date'}</span>;
  if (remaining === null) return <span>--:--:--</span>;
  if (remaining <= 0) return <span>{expiredText || 'This offer has ended.'}</span>;
  const total = Math.floor(remaining / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return <span>{days ? `${days}d ` : ''}{String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}</span>;
}

const visualDefaults: Record<string, { background: string; background2: string; textColor: string }> = {
  profile: { background: '#ffffff', background2: '#eef0ff', textColor: '#151515' },
  link: { background: '#6D46FF', background2: '#9A72FF', textColor: '#FFFFFF' },
  image: { background: '#111827', background2: '#374151', textColor: '#FFFFFF' },
  youtube: { background: '#ff2c4f', background2: '#ff6d50', textColor: '#FFFFFF' },
  video: { background: '#0F172A', background2: '#334155', textColor: '#FFFFFF' },
  countdown: { background: '#D9F21B', background2: '#A8E063', textColor: '#171811' },
  rich_text: { background: '#F3A6CD', background2: '#A990FF', textColor: '#171811' },
  social: { background: '#172070', background2: '#5C6CFF', textColor: '#FFFFFF' },
  spotify: { background: '#1DB954', background2: '#74E39A', textColor: '#071A0E' },
  gallery: { background: '#252432', background2: '#6D46FF', textColor: '#FFFFFF' },
  quote: { background: '#FFF8EE', background2: '#F1E2D1', textColor: '#171811' },
  announcement: { background: '#FF6B4A', background2: '#FF9675', textColor: '#FFFFFF' },
  cta: { background: '#171811', background2: '#34372A', textColor: '#FFFFFF' },
  socials_section: { background: '#ffffff', background2: '#ecebf7', textColor: '#171515' },
  featured: { background: '#171811', background2: '#34372A', textColor: '#FFFFFF' },
  projects: { background: '#ffffff', background2: '#edf0ff', textColor: '#171515' },
  store: { background: '#ffffff', background2: '#f3eee6', textColor: '#171515' },
  newsletter: { background: '#ffffff', background2: '#edf6e7', textColor: '#171515' },
  contact: { background: '#171811', background2: '#464a36', textColor: '#FFFFFF' },
  links_section: { background: '#ffffff', background2: '#f0ecff', textColor: '#171515' },
  branding_footer: { background: '#ffffff', background2: '#ffffff', textColor: '#55565a' },
};

type Props = {
  block: BentoBlockData;
  storeId?: string;
  interactive?: boolean;
  layoutContext?: BentoBlockData[];
  layoutMode?: 'positioned' | 'flow';
  editor?: boolean;
  viewport?: BentoViewport;
  globalCardRadius?: number;
  globalCursorFx?: 'none' | 'spotlight' | 'magnetic';
  animationIndex?: number;
};

type JsonRecord = Record<string, unknown>;

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as JsonRecord[] : [];
}

function SystemLabel({ children }: { children: string }) { return <span className="bento-system-eyebrow">{children}</span>; }

export default function BentoBlock({ block, storeId, interactive = false, layoutContext, layoutMode = 'positioned', editor = false, viewport = 'desktop', globalCardRadius, globalCursorFx = 'none', animationIndex = 0 }: Props) {
  const config = block.config || {};
  const desktopGeometry = getBentoGeometry(block, 'desktop');
  const tabletGeometry = getBentoGeometry(block, 'tablet');
  const mobileGeometry = getBentoGeometry(block, 'mobile');
  const defaults = visualDefaults[block.type] || visualDefaults.link;
  const useGlobalRadius = globalCardRadius !== undefined && config.useGlobalRadius !== false;
  const configNumber = (key: string, fallback: number) => {
    const value = Number(config[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  const radius = Math.max(8, Math.min(64, useGlobalRadius ? Number(globalCardRadius) : configNumber('radius', 28)));
  const bg = typeof config.background === 'string' && config.background ? config.background : defaults.background;
  const bg2 = typeof config.background2 === 'string' && config.background2 ? config.background2 : defaults.background2;
  const textColor = typeof config.textColor === 'string' && config.textColor ? config.textColor : defaults.textColor;
  const backgroundType = typeof config.backgroundType === 'string' ? config.backgroundType : 'gradient';
  const shadow = typeof config.shadow === 'string' ? config.shadow : 'soft';
  const animation = typeof config.animation === 'string' ? config.animation : 'lift';
  const align = typeof config.align === 'string' ? config.align : 'left';
  const opacity = Math.min(1, Math.max(.35, configNumber('opacity', 1)));
  const blur = Math.min(28, Math.max(0, configNumber('blur', 0)));
  const border = String(config.border || 'none');
  const borderColor = String(config.borderColor || '#ffffff');
  const animationIntensity = Math.min(100, Math.max(0, configNumber('animationIntensity', 70)));
  const imageBackground = safeMediaUrl(config.backgroundImage);
  const padding = typeof config.padding === 'string' ? config.padding : '';
  const paddingX = Math.min(64, Math.max(0, configNumber('paddingX', 20)));
  const paddingY = Math.min(64, Math.max(0, configNumber('paddingY', 18)));
  const contentGap = Math.min(48, Math.max(0, configNumber('contentGap', 14)));
  const contentAlign = ['left', 'center', 'right'].includes(String(config.contentAlign)) ? String(config.contentAlign) : 'left';
  const contentVertical = ['start', 'center', 'end'].includes(String(config.contentVertical)) ? String(config.contentVertical) : 'center';
  const fontFamily = typeof config.fontFamily === 'string' && config.fontFamily ? config.fontFamily : '';
  const fontSize = Math.min(48, Math.max(8, configNumber('fontSize', 14)));
  const fontWeight = Math.min(900, Math.max(300, configNumber('fontWeight', 500)));
  const lineHeight = Math.min(2.2, Math.max(0.8, configNumber('lineHeight', 1.4)));
  const letterSpacing = Math.min(0.2, Math.max(-0.08, configNumber('letterSpacing', 0)));

  const background = useMemo(() => {
    if (backgroundType === 'solid') return bg;
    if (backgroundType === 'image' && imageBackground) return `linear-gradient(135deg,rgba(0,0,0,.18),rgba(0,0,0,.04)),url(${imageBackground}) center/cover`;
    if (backgroundType === 'mesh') return `radial-gradient(circle at 10% 10%, ${bg2} 0%, transparent 38%), radial-gradient(circle at 90% 82%, ${bg2} 0%, transparent 42%), ${bg}`;
    if (backgroundType === 'aurora') return `radial-gradient(circle at 15% 15%, ${bg2} 0, transparent 34%), radial-gradient(circle at 82% 30%, #f06bff 0, transparent 28%), radial-gradient(circle at 58% 95%, #36e6a5 0, transparent 25%), linear-gradient(135deg,${bg},#181426)`;
    if (backgroundType === 'glass') return `linear-gradient(135deg,${bg}bb,${bg2}44)`;
    if (config.gradient !== false) return `linear-gradient(135deg,${bg} 0%,${bg2} 100%)`;
    return bg;
  }, [backgroundType, imageBackground, bg, bg2, config.gradient]);

  const hasConfig = (key: string) => Object.prototype.hasOwnProperty.call(config, key);
  const hasContentPadding = hasConfig('padding') || hasConfig('paddingX') || hasConfig('paddingY');
  const hasContentGap = hasConfig('contentGap');
  const hasContentAlign = hasConfig('contentAlign');
  const hasContentVertical = hasConfig('contentVertical');
  const hasContentFontFamily = hasConfig('fontFamily') && Boolean(fontFamily);
  const hasContentFontMetrics = hasConfig('fontSize') || hasConfig('fontWeight') || hasConfig('lineHeight') || hasConfig('letterSpacing');
  const contentStyleClasses = [
    hasContentPadding ? 'bento-has-content-padding' : '',
    hasContentGap ? 'bento-has-content-gap' : '',
    hasContentAlign ? 'bento-has-content-align' : '',
    hasContentVertical ? 'bento-has-content-vertical' : '',
    hasContentFontFamily ? 'bento-has-content-font-family' : '',
    hasContentFontMetrics ? 'bento-has-content-font-metrics' : '',
  ].filter(Boolean).join(' ');
  const customContentVariables: CSSProperties = {
    ...(hasConfig('padding') || hasConfig('paddingX') || hasConfig('paddingY') ? { ['--bento-content-padding' as string]: padding || `${paddingY}px ${paddingX}px` } : {}),
    ...(hasConfig('contentGap') ? { ['--bento-content-gap' as string]: `${contentGap}px` } : {}),
    ...(hasConfig('contentAlign') ? {
      ['--bento-content-align' as string]: contentAlign,
      ['--bento-content-justify' as string]: contentAlign === 'right' ? 'flex-end' : contentAlign === 'center' ? 'center' : 'flex-start',
    } : {}),
    ...(hasConfig('contentVertical') ? { ['--bento-content-vertical' as string]: contentVertical === 'end' ? 'flex-end' : contentVertical === 'center' ? 'center' : 'flex-start' } : {}),
    ...(hasConfig('fontFamily') && fontFamily ? { ['--bento-content-font-family' as string]: fontFamily } : {}),
    ...(hasConfig('fontSize') ? { ['--bento-content-font-size' as string]: `${fontSize}px` } : {}),
    ...(hasConfig('fontWeight') ? { ['--bento-content-font-weight' as string]: fontWeight } : {}),
    ...(hasConfig('lineHeight') ? { ['--bento-content-line-height' as string]: lineHeight } : {}),
    ...(hasConfig('letterSpacing') ? { ['--bento-content-letter-spacing' as string]: `${letterSpacing}em` } : {}),
  };

  const style: CSSProperties = {
    ...(layoutMode === 'positioned' ? getBentoResponsiveGridStyle(block, layoutContext || [block]) : {}),
    ['--bento-bg' as string]: bg,
    ['--bento-bg-2' as string]: bg2,
    ['--bento-radius' as string]: `${radius}px`,
    ['--bento-opacity' as string]: opacity,
    ['--bento-blur' as string]: `${blur}px`,
    ['--bento-card-background' as string]: background,
    ['--bento-motion-intensity' as string]: `${animationIntensity / 100}`,
    ['--bento-animation-delay' as string]: `${Math.max(0, Math.min(24, animationIndex)) * 42}ms`,
    ...customContentVariables,
    color: textColor,
    borderRadius: radius,
    border: border === 'none' ? 'none' : border === 'gradient' ? `1px solid transparent` : `${configNumber('borderWidth', 1)}px solid ${borderColor}`,
    boxShadow: border === 'gradient' ? 'inset 0 0 0 1px rgba(255,255,255,0.26)' : undefined,
    opacity,
    ['--focal-x' as string]: `${configNumber('focalX', 50)}%`,
    ['--focal-y' as string]: `${configNumber('focalY', 50)}%`,
  };

  const track = () => {
    const trackableTypes = new Set(['link', 'social', 'spotify', 'cta', 'featured', 'projects', 'links_section']);
    if (!interactive || !storeId || !trackableTypes.has(block.type)) return;
    const { visitorId, sessionId } = getAnalyticsIdentity();
    const attribution = getAnalyticsAttribution();
    void fetch('/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId,
        eventType: 'link_click',
        eventId: createAnalyticsEventId('link_click'),
        linkId: block.id,
        ...attribution,
        sessionId,
        visitorId,
      }),
    }).catch(() => undefined);
  };

  const linkUrl = safeLinkUrl(config.url);
  const imageUrl = safeMediaUrl(config.imageUrl);
  const videoUrl = safeMediaUrl(config.videoUrl);
  const socialUrl = safeLinkUrl(config.url);
  const id = youtubeId(config.url);
  const galleryUrls = String(config.imageUrls || '').split(/\s*,\s*|\s*\n\s*/).map(safeMediaUrl).filter((value): value is string => Boolean(value)).slice(0, PUBLIC_CONTENT_SAFETY_LIMITS.bentoGalleryImages);
  const socials = Object.entries((config.socials && typeof config.socials === 'object') ? config.socials as Record<string,string> : {}).filter(([,url]) => safeLinkUrl(url)).slice(0, PUBLIC_CONTENT_SAFETY_LIMITS.bentoSocials).map(([key,url]) => ({ key, url: safeLinkUrl(url)! }));
  const resolveLimit = (value: unknown, fallback: number, max: number) => value === 'all' ? max : Math.max(1, Math.min(max, Number(value ?? fallback) || fallback));
  const projects = asRecords(config.projects).slice(0, resolveLimit(config.displayLimit, 8, PUBLIC_CONTENT_SAFETY_LIMITS.bentoCollectionItems));
  const products = asRecords(config.products).slice(0, resolveLimit(config.displayLimit, 4, PUBLIC_CONTENT_SAFETY_LIMITS.bentoCollectionItems));
  const links = asRecords(config.links).filter(item => item.enabled !== false && Boolean(safeLinkUrl(item.url))).slice(0, resolveLimit(config.displayLimit, 10, PUBLIC_CONTENT_SAFETY_LIMITS.bentoCollectionItems));

  let content: ReactNode;
  if (block.type === 'profile') {
    const avatar = safeMediaUrl(config.avatarUrl);
    const location = typeof config.location === 'string' ? config.location : '';
    const availability = typeof config.availability === 'string' ? config.availability : '';
    content = <div className="bento-content bento-profile-content">
      <div className="bento-profile-topline"><div className="bento-profile-avatar-wrap">{avatar ? <img src={avatar} alt={`${String(config.title || "Creator")} profile photo`} className="bento-profile-avatar"/> : <div className="bento-profile-avatar fallback">✦</div>}</div><div className="bento-profile-status"><SystemLabel>TABLELY CREATOR</SystemLabel>{config.verified === true && <span className="bento-verified-pill">✓ VERIFIED</span>}</div></div>
      <div className="bento-profile-main"><h1>{String(config.title || 'Your name')}</h1><p>{String(config.bio || 'Your corner of the internet.')}</p><div className="bento-profile-meta">{location && <span className="bento-location-pill"><MapPin size={12} strokeWidth={2.4} aria-hidden="true" />{String(location)}</span>}{availability && <span className="bento-status-pill">{String(availability)}</span>}</div></div>
      {socials.length > 0 && <div className="bento-profile-social-row">{socials.map(item => <a key={item.key} href={item.url} target="_blank" rel="noreferrer" aria-label={getSocialPlatform(item.key).label}><SocialIcon platform={item.key} size="sm"/></a>)}</div>}
    </div>;
  } else if (block.type === 'link') {
    content = <a href={linkUrl || '#'} target="_blank" rel="noreferrer" onClick={track} className="bento-content bento-link-content"><div className="bento-link-copy"><SystemLabel>LINK</SystemLabel><strong>{String(config.label || 'New link')}</strong><small>{config.description ? String(config.description) : linkUrl ? (() => { try { return new URL(linkUrl).hostname.replace(/^www\./,''); } catch { return linkUrl; } })() : 'Add a destination URL'}</small></div><span className="bento-arrow-orb">↗</span></a>;
  } else if (block.type === 'image') {
    if (imageUrl) {
      const image = <div className="bento-content bento-media-content"><img src={imageUrl} alt={String(config.alt || '')} style={{ objectFit: config.objectFit === 'contain' ? 'contain' : 'cover', objectPosition: `${configNumber('focalX', 50)}% ${configNumber('focalY', 50)}%` }}/></div>;
      content = safeLinkUrl(config.linkUrl) ? <a href={safeLinkUrl(config.linkUrl)!} target="_blank" rel="noreferrer">{image}</a> : image;
    } else content = <div className="bento-content bento-empty-media"><SystemLabel>IMAGE</SystemLabel><strong>Add an image URL</strong></div>;
  } else if (block.type === 'youtube') {
    content = id ? <a href={safeLinkUrl(config.url) || '#'} target="_blank" rel="noreferrer" className="bento-content bento-video-content"><img src={`https://img.youtube.com/vi/${id}/hqdefault.jpg`} alt=""/><span className="bento-video-scrim"/><span className="bento-play-orb">▶</span><div className="bento-video-copy"><SystemLabel>YOUTUBE</SystemLabel><strong>{String(config.title || 'Watch on YouTube')}</strong></div></a> : <div className="bento-content bento-empty-media"><SystemLabel>YOUTUBE</SystemLabel><strong>Paste a YouTube URL</strong></div>;
  } else if (block.type === 'video') {
    content = videoUrl ? <div className="bento-content bento-media-content"><video controls preload="metadata" poster={safeMediaUrl(config.posterUrl) || undefined} src={videoUrl}/></div> : <div className="bento-content bento-empty-media"><SystemLabel>VIDEO</SystemLabel><strong>Add a video URL</strong></div>;
  } else if (block.type === 'countdown') {
    content = <div className="bento-content bento-countdown-content"><SystemLabel>{String(config.kicker || 'COMING SOON')}</SystemLabel><strong>{String(config.title || 'Coming soon')}</strong><div className="bento-countdown-value"><Countdown target={String(config.target || '')} expiredText={String(config.expiredText || '')}/></div></div>;
  } else if (block.type === 'rich_text' || block.type === 'announcement' || block.type === 'cta') {
    content = <div className={`bento-content bento-rich-content bento-align-${align}`}><SystemLabel>{String(config.kicker || (block.type === 'cta' ? 'ACTION' : block.type === 'announcement' ? 'UPDATE' : 'NOTE'))}</SystemLabel><strong>{String(config.title || '')}</strong><p>{String(config.body || '')}</p>{block.type === 'cta' && <span className="bento-cta-orb">↗</span>}</div>;
    if (block.type === 'cta' && linkUrl) content = <a href={linkUrl} target="_blank" rel="noreferrer" onClick={track} className={`bento-content bento-rich-content bento-align-${align}`}><SystemLabel>{String(config.kicker || 'ACTION')}</SystemLabel><strong>{String(config.title || 'Do something memorable.')}</strong><p>{String(config.body || 'A high-impact action.')}</p><span className="bento-cta-orb">↗</span></a>;
  } else if (block.type === 'social') {
    const platform = String(config.platform || inferSocialPlatform(String(config.url || ''), String(config.label || 'social')));
    content = <a href={socialUrl || '#'} target="_blank" rel="noreferrer" onClick={track} className="bento-content bento-social-content"><div className="bento-social-icon"><SocialIcon platform={platform} size="lg"/></div><div><SystemLabel>FOLLOW</SystemLabel><strong>{String(config.label || platform)}</strong><small>{String(config.handle || 'Open profile')}</small></div><span className="bento-arrow-orb">↗</span></a>;
  } else if (block.type === 'spotify') {
    const provider = normalizeBentoMusicProvider(config.provider) as BentoMusicProvider;
    const providerInfo = getBentoMusicProvider(provider);
    const musicUrl = isValidBentoMusicUrl(provider, config.url) ? safeLinkUrl(config.url) : null;
    const iconPlatform = provider === 'apple_music' ? 'applemusic' : provider === 'youtube_music' ? 'youtube_music' : 'spotify';
    const musicCard = <div className="bento-content bento-spotify-content"><div className="bento-spotify-disc"><SocialIcon platform={iconPlatform} size="lg" /></div><div><SystemLabel>{providerInfo.label.toUpperCase()}</SystemLabel><strong>{String(config.title || 'Listen now')}</strong><small>{String(config.subtitle || providerInfo.openLabel)}</small></div><span className="bento-arrow-orb">▶</span></div>;
    content = musicUrl ? <a href={musicUrl} target="_blank" rel="noreferrer" onClick={track} aria-label={providerInfo.openLabel} className="bento-music-link">{musicCard}</a> : <div className="bento-music-fallback" role="status">{musicCard}<small>{String(config.url || '').trim() ? `Use a valid ${providerInfo.label} URL.` : `${providerInfo.label} URL required.`}</small></div>;
  } else if (block.type === 'gallery') {
    const galleryCount = Math.min(galleryUrls.length, 5);
    content = <div className={`bento-content bento-gallery-content bento-gallery-count-${galleryCount}`}>{galleryUrls.length ? galleryUrls.map((url, index) => <img key={`${url}-${index}`} src={url} alt={`Gallery image ${index + 1}`}/>) : <div className="bento-empty-media"><SystemLabel>GALLERY</SystemLabel><strong>Add image URLs</strong></div>}</div>;
  } else if (block.type === 'quote') {
    content = <div className="bento-content bento-quote-content"><span className="bento-quote-mark">“</span><p>{String(config.body || 'A memorable thought belongs in the layout.')}</p><span className="bento-quote-author">{String(config.author || 'Your name')}</span></div>;
  } else if (block.type === 'socials_section') {
    content = <div className="bento-content bento-system-list-content"><SystemLabel>CONNECT</SystemLabel><h2>{String(config.title || 'Find me online')}</h2><div className="bento-social-scroll-frame" aria-label="Social links"><div className="bento-system-social-grid">{socials.map(item => <a key={item.key} href={item.url} target="_blank" rel="noreferrer"><SocialIcon platform={item.key} size="sm"/><span className="bento-system-social-label">{getSocialPlatform(item.key).label}</span><b>↗</b></a>)}</div></div></div>;
  } else if (block.type === 'featured') {
    const feature = (config.featured && typeof config.featured === 'object') ? { ...(config.featured as JsonRecord), ...config } : config;
    const featureUrl = safeLinkUrl(feature.url) || '#';
    const image = safeMediaUrl(feature.image);
    content = <a href={featureUrl} target="_blank" rel="noreferrer" onClick={track} className="bento-content bento-featured-content" style={image ? { backgroundImage: `linear-gradient(135deg,rgba(7,7,10,.85),rgba(7,7,10,.16)),url(${image})` } : undefined}><SystemLabel>FEATURED</SystemLabel><strong>{String(feature.title || 'Featured project')}</strong><p>{String(feature.description || 'Showcase the thing you want everyone to see first.')}</p><span className="bento-featured-link">Explore ↗</span></a>;
  } else if (block.type === 'projects') {
    content = <div className="bento-content bento-system-list-content"><SystemLabel>SELECTED WORK</SystemLabel><h2>{String(config.title || 'Projects')}</h2><div className="bento-project-grid">{projects.length ? projects.map((project, index) => <a key={String(project.id || index)} href={safeLinkUrl(project.url) || '#'} target="_blank" rel="noreferrer" onClick={track} className="bento-project-card">{safeMediaUrl(project.image) ? <img src={String(project.image)} alt={String(project.title || "Project image")}/> : <span className="bento-project-mark">✦</span>}<span><b>{String(project.name || 'Project')}</b><small>{String(project.description || '')}</small></span><em>↗</em></a>) : <p className="bento-empty-copy">Add projects in Link Hub to populate this space.</p>}</div></div>;
  } else if (block.type === 'store') {
    content = <div className="bento-content bento-system-list-content"><SystemLabel>SHOP</SystemLabel><h2>{String(config.title || 'My store')}</h2><p>{String(config.description || 'Digital products, templates and resources.')}</p><div className="bento-product-grid">{products.length ? products.map((product,index) => <Link key={String(product.id || index)} href={getProductPath(String(config.username || ''), String(product.slug || ''))} className="bento-product-card">{safeMediaUrl(product.image) ? <img src={String(product.image)} alt={String(product.title || "Product image")}/> : <span className="bento-product-mark">✦</span>}<span><b>{String(product.title || 'Product')}</b><small>{String(product.currency || 'INR') === 'INR' ? '₹' : `${String(product.currency || '')} `}{Number(product.price || 0).toLocaleString('en-IN')}</small></span></Link>) : <p className="bento-empty-copy">Your live products will appear here.</p>}</div><Link href={getStorePath(String(config.username || ''), getPrimaryPublicPage(config.primaryPage))} className="bento-text-link">Visit store ↗</Link></div>;
  } else if (block.type === 'newsletter') {
    content = <div className="bento-content bento-system-list-content"><SystemLabel>STAY IN THE LOOP</SystemLabel><h2>{String(config.title || 'Useful stuff. No clutter.')}</h2><p>{String(config.description || 'Projects, tutorials, new drops and things worth knowing.')}</p>{storeId ? <EmailCapture storeId={storeId}/> : <div className="bento-newsletter-placeholder"><span>you@example.com</span><b>Join list</b></div>}</div>;
  } else if (block.type === 'contact') {
    const email = String(config.contactEmail || '');
    const whatsapp = String(config.whatsapp || '').replace(/\D/g, '');
    content = <div className="bento-content bento-contact-content"><SystemLabel>CONTACT</SystemLabel><h2>{String(config.contactTitle || 'Let’s build something.')}</h2><p>{String(config.description || 'Freelance work, collaborations, startup ideas or sponsorships.')}</p><div className="bento-contact-actions">{email && <a href={`mailto:${email}`}>Email ↗</a>}{whatsapp && <a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noreferrer">WhatsApp ↗</a>}</div></div>;
  } else if (block.type === 'links_section') {
    content = <div className="bento-content bento-system-list-content"><SystemLabel>MORE LINKS</SystemLabel><h2>{String(config.title || 'More links')}</h2><div className="bento-links-grid">{links.length ? links.map((link,index) => <a key={String(link.id || index)} href={safeLinkUrl(link.url) || '#'} target="_blank" rel="noreferrer" onClick={track} className="bento-system-link">{safeMediaUrl(link.thumbnailUrl) ? <img src={String(link.thumbnailUrl)} alt=""/> : null}{typeof link.platform === 'string' && link.platform ? <SocialIcon platform={String(link.platform)} size="sm"/> : null}<span>{String(link.label || 'Link')}</span><b>↗</b></a>) : <p className="bento-empty-copy">Your saved links will appear here.</p>}</div></div>;
  } else if (block.type === 'branding_footer') {
    const footerUrl = String(config.url || '/').replace(/^https:\/\/www\.instaly\.in\/?$/i, '/');
    content = <a className="bento-content bento-branding-content" href={footerUrl} target={footerUrl.startsWith('/') ? undefined : '_blank'} rel={footerUrl.startsWith('/') ? undefined : 'noreferrer'}><span>{String(config.label || 'Made with TABLELY').replace(/^Made with Instaly$/i, 'Made with TABLELY')}</span><b>↗</b></a>;
  } else {
    content = null;
  }

  const interactivePhysics = !editor && (animation === 'magnetic' || animation === 'tilt' || globalCursorFx === 'magnetic');
  const physicsFrameRef = useRef<number | null>(null);
  const physicsEventRef = useRef<{ target: HTMLElement; clientX: number; clientY: number } | null>(null);
  function handlePhysicsMove(event: ReactPointerEvent<HTMLElement>) {
    if (!interactivePhysics || event.pointerType === 'touch' || event.pointerType === 'pen') return;
    physicsEventRef.current = { target: event.currentTarget, clientX: event.clientX, clientY: event.clientY };
    if (physicsFrameRef.current !== null) return;
    physicsFrameRef.current = window.requestAnimationFrame(() => {
      physicsFrameRef.current = null;
      const latest = physicsEventRef.current;
      if (!latest) return;
      const rect = latest.target.getBoundingClientRect();
      const x = ((latest.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
      const y = ((latest.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1;
      const isTilt = animation === 'tilt';
      const tiltStrength = isTilt ? 1 : 0;
      const magneticStrength = animation === 'magnetic' ? 1 : globalCursorFx === 'magnetic' ? .42 : 0;
      latest.target.style.setProperty('--bento-tilt-x', `${(-y * 4 * tiltStrength).toFixed(2)}deg`);
      latest.target.style.setProperty('--bento-tilt-y', `${(x * 4 * tiltStrength).toFixed(2)}deg`);
      latest.target.style.setProperty('--bento-magnetic-x', `${(x * 8 * magneticStrength).toFixed(2)}px`);
      latest.target.style.setProperty('--bento-magnetic-y', `${(y * 8 * magneticStrength).toFixed(2)}px`);
    });
  }
  useEffect(() => () => { if (physicsFrameRef.current !== null) window.cancelAnimationFrame(physicsFrameRef.current); }, []);

  function resetPhysics(event: ReactPointerEvent<HTMLElement>) {
    if (!interactivePhysics) return;
    event.currentTarget.style.setProperty('--bento-tilt-x', '0deg');
    event.currentTarget.style.setProperty('--bento-tilt-y', '0deg');
    event.currentTarget.style.setProperty('--bento-magnetic-x', '0px');
    event.currentTarget.style.setProperty('--bento-magnetic-y', '0px');
  }

  return <article data-bento-id={block.id} data-bento-type={block.type} data-bento-background-type={backgroundType} data-bento-animation-index={animationIndex} data-bento-global-cursor-fx={globalCursorFx} data-bento-desktop-column-span={desktopGeometry.columnSpan} data-bento-desktop-row-span={desktopGeometry.rowSpan} data-bento-tablet-column-span={tabletGeometry.columnSpan} data-bento-tablet-row-span={tabletGeometry.rowSpan} data-bento-mobile-column-span={mobileGeometry.columnSpan} data-bento-mobile-row-span={mobileGeometry.rowSpan} onPointerMove={handlePhysicsMove} onPointerLeave={resetPhysics} className={`bento-block-v2 bento-${block.type} bento-animation-${animation} bento-shadow-${shadow} ${layoutMode === 'flow' ? 'bento-flow' : ''} ${editor ? 'bento-editor-block' : ''} ${block.locked ? 'is-locked' : ''} ${contentStyleClasses}`} style={style}>
    <span className="bento-card-background" aria-hidden="true" />
    {content}
    <span className="bento-card-noise" aria-hidden="true" />
    {editor && <span className="bento-editor-selection" aria-hidden="true" />}
  </article>;
}
