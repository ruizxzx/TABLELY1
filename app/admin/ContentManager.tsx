'use client';

import { useEffect, useMemo, useState } from 'react';
import StructuredContentEditor from './StructuredContentEditor';

const labels: Record<string, string> = {
  home: 'Landing Page', site: 'Global Navigation & Footer', contact: 'Contact', vision: 'Our Vision',
  founder: 'From the Founder', privacy: 'Privacy Policy', terms: 'Terms & Conditions', refunds: 'Refund & Cancellation',
};

export default function ContentManager({ token }: { token: string }) {
  const [data, setData] = useState<any>({ pages: [], contacts: [] });
  const [slug, setSlug] = useState('home');
  const [raw, setRaw] = useState('{}');
  const [title, setTitle] = useState('');
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  function select(pages: any[], nextSlug: string) {
    const page = pages.find((item: any) => item.slug === nextSlug);
    if (!page) return;
    setSlug(nextSlug); setTitle(page.title || ''); setSeoTitle(page.seo_title || ''); setSeoDescription(page.seo_description || ''); setRaw(JSON.stringify(page.draft_content || {}, null, 2));
  }

  async function load() {
    const response = await fetch('/api/admin?section=content', { headers: { Authorization: `Bearer ${token}` } });
    const json = await response.json();
    if (response.ok) { setData(json.data); select(json.data.pages, json.data.pages.find((page: any) => page.slug === slug)?.slug || json.data.pages[0]?.slug || 'home'); }
    else setMessage(json.error || 'Could not load content.');
  }

  useEffect(() => { if (token) void load(); }, [token]);
  useEffect(() => {
    function syncFounderPhoto(event: Event) {
      const url = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (!url || slug !== 'founder') return;
      try { const content = JSON.parse(raw); content.photoUrl = url; setRaw(JSON.stringify(content, null, 2)); }
      catch { setMessage('Photo uploaded. Refresh the Founder editor before publishing.'); }
    }
    window.addEventListener('founder-photo-uploaded', syncFounderPhoto);
    return () => window.removeEventListener('founder-photo-uploaded', syncFounderPhoto);
  }, [raw, slug]);

  const page = useMemo(() => data.pages.find((item: any) => item.slug === slug), [data.pages, slug]);
  const draftContent = useMemo(() => {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }, [raw]);
  const isLandingPage = slug === 'home';
  const previewTitle = isLandingPage ? String(draftContent.heroTitle || title || labels[slug] || slug) : String(draftContent.title || draftContent.heading || title || labels[slug] || slug);
  const previewIntro = isLandingPage ? (draftContent.heroDescription || draftContent.description || draftContent.body || '') : (draftContent.intro || draftContent.description || draftContent.body || '');
  const previewParagraphs = Array.isArray(draftContent.body) ? draftContent.body.filter(Boolean) : (typeof previewIntro === 'string' && previewIntro && !draftContent.quote && !isLandingPage ? [previewIntro] : []);
  const previewSections = isLandingPage ? [
    ...(draftContent.featuresTitle ? [{ heading: draftContent.featuresTitle, body: Array.isArray(draftContent.features) ? draftContent.features.slice(0, 3).map((feature: any) => `${feature.title || 'Feature'} — ${feature.description || ''}`) : [] }] : []),
    ...(draftContent.howTitle ? [{ heading: draftContent.howTitle, body: Array.isArray(draftContent.howSteps) ? draftContent.howSteps.map((step: any) => `${step.title || 'Step'} — ${step.description || ''}`) : [] }] : []),
    ...(draftContent.faqTitle ? [{ heading: draftContent.faqTitle, body: Array.isArray(draftContent.faq) ? draftContent.faq.map((item: any) => `${item.question || 'Question'} — ${item.answer || ''}`) : [] }] : []),
  ].filter((section: any) => section && (section.heading || section.body?.length)) : (Array.isArray(draftContent.sections) ? draftContent.sections.filter((section: any) => section && (section.heading || section.title || section.body)) : []);
  const previewLinks = isLandingPage ? [
    ...(draftContent.primaryCta || draftContent.primaryHref ? [{ label: draftContent.primaryCta || 'Get started', href: draftContent.primaryHref || '#' }] : []),
    ...(draftContent.secondaryCta || draftContent.secondaryHref ? [{ label: draftContent.secondaryCta || 'Learn more', href: draftContent.secondaryHref || '#' }] : []),
  ] : (Array.isArray(draftContent.links) ? draftContent.links.filter((link: any) => link?.label || link?.href) : []);

  async function save(publish = false) {
    setSaving(true); setMessage('');
    try {
      const content = JSON.parse(raw);
      if (slug === 'founder') {
        const latestResponse = await fetch('/api/admin?section=content', { headers: { Authorization: `Bearer ${token}` } });
        const latestJson = await latestResponse.json();
        const latestPhoto = latestJson.data?.pages?.find((item: any) => item.slug === 'founder')?.draft_content?.photoUrl;
        if (latestPhoto && latestPhoto !== content.photoUrl) { content.photoUrl = latestPhoto; setRaw(JSON.stringify(content, null, 2)); }
      }
      const response = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'save_public_content', slug, title, seo_title: seoTitle, seo_description: seoDescription, content }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'Save failed.');
      if (publish) {
        const publishResponse = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'publish_public_content', slug }) });
        const publishJson = await publishResponse.json();
        if (!publishResponse.ok) throw new Error(publishJson.error || 'Publish failed.');
        setMessage('Saved and published.');
      } else setMessage('Draft saved.');
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid content.'); }
    finally { setSaving(false); }
  }

  async function updateContact(id: string, status: string, notes: string) {
    const response = await fetch('/api/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'update_contact_submission', id, status, internal_notes: notes }) });
    if (response.ok) await load();
  }

  return <div>
    <div className="content-admin-tabs">{data.pages.map((item: any) => <button key={item.slug} className={`btn btn-sm ${slug === item.slug ? 'btn-primary' : ''}`} onClick={() => select(data.pages, item.slug)}>{labels[item.slug] || item.slug}</button>)}</div>
    <div className="content-admin-grid">
      <div className="card panel">
        <div className="eyebrow">CONTENT EDITOR</div><h2>{labels[slug] || slug}</h2>
        <label className="label">Internal title</label><input className="input" value={title} onChange={event => setTitle(event.target.value)} />
        <label className="label">SEO title</label><input className="input" value={seoTitle} onChange={event => setSeoTitle(event.target.value)} />
        <label className="label">SEO description</label><textarea className="input" style={{ minHeight: 90, paddingTop: 12 }} value={seoDescription} onChange={event => setSeoDescription(event.target.value)} />
        <StructuredContentEditor value={raw} onChange={setRaw} />
        <div className="row-actions" style={{ marginTop: 14 }}><button className="btn" disabled={saving} onClick={() => void save(false)}>Save Draft</button><button className="btn btn-primary" disabled={saving} onClick={() => void save(true)}>Publish</button>{page?.published && <span className="status live">PUBLISHED v{page.published_version}</span>}</div>
        {message && <div className="info-note">{message}</div>}<p className="muted" style={{ fontSize: 12, marginTop: 14 }}>Public visitors see only the published version. The structured content editor writes directly to each page section and keeps the existing save and publish workflow.</p>
      </div>
      <div>
        <div className="card panel content-preview-panel">
          <div className="eyebrow">LIVE PREVIEW</div>
          <div className="content-preview-surface">
            {draftContent.photoUrl && <img className="content-preview-image" src={String(draftContent.photoUrl)} alt={previewTitle} />}
            {draftContent.eyebrow && <span className="pill content-preview-pill">{String(draftContent.eyebrow)}</span>}
            <h3>{previewTitle}</h3>
            {draftContent.quote && <blockquote className="content-preview-quote">“{String(draftContent.quote)}”</blockquote>}
            {previewIntro && typeof previewIntro === 'string' && <p className="content-preview-intro">{previewIntro}</p>}
            {previewParagraphs.length > 0 && <div className="content-preview-body">{previewParagraphs.map((paragraph: any, index: number) => <p key={index}>{String(paragraph)}</p>)}</div>}
            {previewSections.length > 0 && <div className="content-preview-sections">{previewSections.map((section: any, index: number) => <div key={index}><b>{String(section.heading || section.title || `Section ${index + 1}`)}</b>{Array.isArray(section.body) ? section.body.map((item: any, subIndex: number) => <p key={subIndex}>{String(item)}</p>) : section.body && <p>{String(section.body)}</p>}</div>)}</div>}
            {previewLinks.length > 0 && <div className="content-preview-links">{previewLinks.map((link: any, index: number) => <a key={index} href={String(link.href || '#')} className="btn btn-sm" target={String(link.href || '').startsWith('http') ? '_blank' : undefined}>{String(link.label || link.href || `Link ${index + 1}`)}</a>)}</div>}
            {!draftContent.photoUrl && !draftContent.quote && !previewIntro && !previewParagraphs.length && !previewSections.length && !previewLinks.length && <p className="muted">Your page preview will appear here as you edit the content.</p>}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
