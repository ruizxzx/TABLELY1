'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { Link2 } from 'lucide-react';
import { getPrimaryPublicPage, getStorePath } from '../lib/public-paths';
import { createAnalyticsEventId, getAnalyticsAttribution, getAnalyticsIdentity } from '../lib/analytics-client';
import BentoPublicCornerMenu from './BentoPublicCornerMenu';
import EmailCapture from './EmailCapture';
import BentoPublicViewBeacon from './BentoPublicViewBeacon';
import { getSocialPlatform, SocialIcon } from './SocialIcon';

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

type ClassicLink = {
  id: string;
  kind?: string;
  label: string;
  url: string;
  enabled?: boolean;
  platform?: string;
  thumbnailUrl?: string | null;
  collectionId?: string | null;
  layout?: 'classic' | 'featured';
  animate?: boolean;
};

type ClassicProject = {
  id: string;
  name: string;
  description?: string;
  url: string;
  image?: string;
};

type Props = {
  storeId: string;
  shareUrl: string;
  title: string;
  bio: string;
  avatarUrl?: string | null;
  verified?: boolean;
  location?: string;
  availability?: string;
  socialLinks?: Record<string, string>;
  links?: ClassicLink[];
  collections?: { id: string; title: string; enabled: boolean }[];
  featured?: { title: string; description: string; url: string; image: string } | null;
  projects?: ClassicProject[];
  contactEmail?: string;
  whatsapp?: string;
  contactTitle?: string;
  newsletterEnabled?: boolean;
  branding?: boolean;
  username: string;
  primaryPage: ReturnType<typeof getPrimaryPublicPage>;
  background: string;
  accent: string;
  textColor: string;
  mutedTextColor: string;
  buttonStyle: 'solid' | 'soft' | 'outline';
  linkShape?: 'rounded' | 'pill' | 'square';
  linkShadow?: boolean;
  linkTextAlign?: 'left' | 'center';
  analyticsEnabled?: boolean;
};

function getButtonClass(buttonStyle: Props['buttonStyle']) {
  return buttonStyle === 'soft' ? 'classic-linktree-button classic-linktree-button-soft' : buttonStyle === 'outline' ? 'classic-linktree-button classic-linktree-button-outline' : 'classic-linktree-button classic-linktree-button-solid';
}

function renderClassicLink(link: ClassicLink, options: { buttonStyle: Props['buttonStyle']; linkTextAlign: 'left' | 'center'; track: (linkId?: string) => void }) {
  const url = safeLinkUrl(link.url);
  if (!url) return null;
  const internal = url.startsWith('/');
  const thumbnail = safeMediaUrl(link.thumbnailUrl);
  const className = `${getButtonClass(options.buttonStyle)} ${link.layout === 'featured' ? 'classic-linktree-button-featured' : ''} ${link.animate ? 'classic-linktree-button-animated' : ''}`;
  const content = <>
    <span className="classic-linktree-link-leading">{thumbnail ? <img src={thumbnail} alt="" className="classic-linktree-thumb" /> : link.platform ? <SocialIcon platform={link.platform} size="sm" /> : <Link2 size={16} aria-hidden="true" />}</span>
    <span className={`classic-linktree-link-label classic-linktree-align-${options.linkTextAlign}`}>{link.label}</span>
    <b aria-hidden="true">⋮</b>
  </>;
  return internal ? <Link key={link.id} className={className} href={url} onClick={() => options.track(link.id)}>{content}</Link> : <a key={link.id} className={className} href={url} target="_blank" rel="noreferrer" onClick={() => options.track(link.id)}>{content}</a>;
}

export default function ClassicLinkHubRenderer({
  storeId,
  shareUrl,
  title,
  bio,
  avatarUrl,
  verified = false,
  location = '',
  availability = '',
  socialLinks = {},
  links = [],
  collections = [],
  featured = null,
  projects = [],
  contactEmail = '',
  whatsapp = '',
  contactTitle = "Let's build something.",
  newsletterEnabled = true,
  branding = false,
  username,
  primaryPage,
  background,
  accent,
  textColor,
  mutedTextColor,
  buttonStyle,
  linkShape = 'rounded',
  linkShadow = true,
  linkTextAlign = 'center',
  analyticsEnabled = true,
}: Props) {
  const cleanSocials = Object.entries(socialLinks)
    .filter(([, value]) => Boolean(safeLinkUrl(value)))
    .slice(0, 12)
    .map(([id, url]) => ({ id, url: safeLinkUrl(url)! }));
  const visibleLinks = links.filter((link) => link.enabled !== false && link.label && safeLinkUrl(link.url)).slice(0, 500);
  const visibleProjects = projects.filter((project) => project?.name && safeLinkUrl(project?.url)).slice(0, 100);
  const visibleCollections = collections.filter(collection => collection?.enabled !== false && collection.title).slice(0, 100);
  const collectionMap = new Map(visibleCollections.map(collection => [collection.id, collection]));
  const orphanedLinks = visibleLinks.filter(link => link.collectionId && !collectionMap.has(link.collectionId));
  const ungroupedLinks = visibleLinks.filter(link => !link.collectionId);
  const safeFeaturedUrl = safeLinkUrl(featured?.url);
  const safeWhatsapp = whatsapp.replace(/\D/g, '');
  const storePath = getStorePath(username, primaryPage);

  const track = useCallback((linkId?: string) => {
    if (!analyticsEnabled) return;
    const { visitorId, sessionId } = getAnalyticsIdentity();
    const attribution = getAnalyticsAttribution();
    void fetch('/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId,
        eventType: 'link_click',
        eventId: createAnalyticsEventId('link_click'),
        linkId: linkId || null,
        ...attribution,
        sessionId,
        visitorId,
      }),
      keepalive: true,
    }).catch(() => undefined);
  }, [analyticsEnabled, storeId]);

  const pageStyle = {
    background,
    color: textColor,
    ['--hub-accent' as string]: accent,
    ['--hub-muted' as string]: mutedTextColor,
    ['--classic-button-bg' as string]: `${accent}e8`,
    ['--classic-button-radius' as string]: linkShape === 'pill' ? '999px' : linkShape === 'square' ? '5px' : '17px',
    ['--classic-button-shadow' as string]: linkShadow ? '0 8px 20px rgba(28,20,15,.07)' : 'none',
  };

  return (
    <div className="classic-linktree-shell" style={pageStyle}>
      {analyticsEnabled ? <BentoPublicViewBeacon storeId={storeId} /> : null}
      <main className="classic-linktree-page">
        <div className="classic-linktree-topbar">
          <span className="classic-linktree-brand">TABLELY</span>
          <BentoPublicCornerMenu shareUrl={shareUrl} />
        </div>

        <div className="classic-linktree-inner">
          <header className="classic-linktree-profile">
            {avatarUrl ? <img src={avatarUrl} alt="" className="classic-linktree-avatar" /> : <div className="classic-linktree-avatar classic-linktree-avatar-fallback">{title.slice(0, 1).toUpperCase() || '✦'}</div>}
            <div className="classic-linktree-handle">@{username}{verified ? <span className="classic-linktree-verified" aria-label="Verified creator">✓</span> : null}</div>
            <h1>{title || 'Your name'}</h1>
            <p>{bio || 'Your corner of the internet.'}</p>
            {(location || availability) && <div className="classic-linktree-meta">{location ? <span>{location}</span> : null}{availability ? <span>{availability}</span> : null}</div>}
            {cleanSocials.length > 0 && (
              <nav className="classic-linktree-socials" aria-label="Social profiles">
                {cleanSocials.map((item) => (
                  <a key={item.id} href={item.url} target="_blank" rel="noreferrer" aria-label={getSocialPlatform(item.id).label} onClick={() => track()}>
                    <SocialIcon platform={item.id} size="sm" />
                  </a>
                ))}
              </nav>
            )}
          </header>

          <section className="classic-linktree-links" aria-label="Creator links">
            <Link className={`${getButtonClass(buttonStyle)} classic-linktree-store-link`} href={storePath} onClick={() => track()}>
              <span>Shop my store</span><b aria-hidden="true">↗</b>
            </Link>
            {visibleLinks.map(link => !link.collectionId ? renderClassicLink(link, { buttonStyle, linkTextAlign, track }) : null)}
          </section>

          {visibleCollections.map(collection => {
            const collectionLinks = visibleLinks.filter(link => link.collectionId === collection.id);
            if (!collectionLinks.length) return null;
            return <section className="classic-linktree-section classic-linktree-link-section" aria-labelledby={`classic-collection-${collection.id}`} key={collection.id}>
              <div className="classic-linktree-section-head"><small>COLLECTION</small><h2 id={`classic-collection-${collection.id}`}>{collection.title}</h2></div>
              <div className="classic-linktree-links classic-linktree-collection-links">{collectionLinks.map(link => renderClassicLink(link, { buttonStyle, linkTextAlign, track }))}</div>
            </section>;
          })}
          {orphanedLinks.length ? <section className="classic-linktree-section classic-linktree-link-section" aria-labelledby="classic-other-links-heading"><div className="classic-linktree-section-head"><small>LINKS</small><h2 id="classic-other-links-heading">Other links</h2></div><div className="classic-linktree-links classic-linktree-collection-links">{orphanedLinks.map(link => renderClassicLink(link, { buttonStyle, linkTextAlign, track }))}</div></section> : null}

          {safeFeaturedUrl ? (
            <a className="classic-linktree-featured" href={safeFeaturedUrl} target="_blank" rel="noreferrer" onClick={() => track()}>
              {safeMediaUrl(featured?.image) ? <img src={safeMediaUrl(featured?.image)!} alt="" /> : <span className="classic-linktree-featured-placeholder" aria-hidden="true" />}
              <span><small>FEATURED</small><strong>{featured?.title || 'Featured project'}</strong><em>{featured?.description || 'Showcase your best work.'}</em></span>
              <b aria-hidden="true">↗</b>
            </a>
          ) : null}

          {visibleProjects.length > 0 ? (
            <section className="classic-linktree-section" aria-labelledby="classic-projects-heading">
              <div className="classic-linktree-section-head"><small>SELECTED WORK</small><h2 id="classic-projects-heading">Projects</h2></div>
              <div className="classic-linktree-project-grid">
                {visibleProjects.map((project) => (
                  <a key={project.id} href={safeLinkUrl(project.url)!} target="_blank" rel="noreferrer" onClick={() => track()}>
                    {safeMediaUrl(project.image) ? <img src={safeMediaUrl(project.image)!} alt="" /> : <span className="classic-linktree-project-mark">✦</span>}
                    <span><strong>{project.name}</strong><small>{project.description || ''}</small></span>
                    <b aria-hidden="true">↗</b>
                  </a>
                ))}
              </div>
            </section>
          ) : null}

          {(contactEmail || safeWhatsapp) ? (
            <section className="classic-linktree-contact" aria-labelledby="classic-contact-heading">
              <small>CONTACT</small>
              <h2 id="classic-contact-heading">{contactTitle}</h2>
              <p>Freelance work, collaborations, startup ideas or sponsorships.</p>
              <div>
                {contactEmail ? <a href={`mailto:${contactEmail}`}>Email ↗</a> : null}
                {safeWhatsapp ? <a href={`https://wa.me/${safeWhatsapp}`} target="_blank" rel="noreferrer">WhatsApp ↗</a> : null}
              </div>
            </section>
          ) : null}

          {newsletterEnabled ? (
            <div className="classic-linktree-newsletter"><EmailCapture storeId={storeId} /></div>
          ) : null}

          {branding ? (
            <footer className="classic-linktree-footer"><span>Made with TABLELY</span><a href="/">Create your page ↗</a></footer>
          ) : null}
        </div>
      </main>
    </div>
  );
}
