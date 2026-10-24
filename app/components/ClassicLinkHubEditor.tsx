'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Edit3,
  ExternalLink,
  GripVertical,
  Image as ImageIcon,
  Layers3,
  Link2,
  Menu,
  Palette,
  Play,
  Plus,
  Save,
  Share2,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import ClassicLinkHubRenderer from './ClassicLinkHubRenderer';
import { getSocialPlatform, SOCIAL_PLATFORMS, SocialIcon } from './SocialIcon';
import { getLinkHubPath, type PrimaryPublicPage } from '../lib/public-paths';

export type ClassicLinkLayout = 'classic' | 'featured';
export type ClassicLinkCollection = { id: string; title: string; enabled: boolean };
export type ClassicThemeOption = {
  id: string;
  name: string;
  note: string;
  background: string;
  accent: string;
  textColor: string;
  mutedTextColor: string;
};

export type ClassicEditorLink = {
  id: string;
  kind: 'link' | 'spotify';
  label: string;
  url: string;
  enabled: boolean;
  platform?: string;
  startAt?: string | null;
  endAt?: string | null;
  thumbnailUrl?: string | null;
  collectionId?: string | null;
  layout?: ClassicLinkLayout;
  animate?: boolean;
};

type Props = {
  storeId: string;
  username: string;
  primaryPage: PrimaryPublicPage;
  title: string;
  bio: string;
  avatarUrl?: string | null;
  verified?: boolean;
  location?: string;
  availability?: string;
  socialLinks: Record<string, string>;
  links: ClassicEditorLink[];
  collections: ClassicLinkCollection[];
  featured?: { title: string; description: string; url: string; image: string } | null;
  projects?: { id: string; name: string; description: string; url: string; image: string }[];
  contactEmail?: string;
  whatsapp?: string;
  contactTitle?: string;
  newsletterEnabled?: boolean;
  branding?: boolean;
  background: string;
  accent: string;
  textColor: string;
  mutedTextColor: string;
  buttonStyle: 'solid' | 'soft' | 'outline';
  linkShape: 'rounded' | 'pill' | 'square';
  linkShadow: boolean;
  linkTextAlign: 'left' | 'center';
  themeOptions: ClassicThemeOption[];
  onChange: (patch: Record<string, unknown>) => void;
  onSave: () => void;
  saving: boolean;
  profileEditor?: ReactNode;
  onAddLink: (kind: 'link' | 'spotify') => void;
  onUpdateLink: (id: string, patch: Partial<ClassicEditorLink>) => void;
  onRemoveLink: (id: string) => void;
  onMoveLink: (index: number, direction: -1 | 1) => void;
  onAddCollection: (title: string) => void;
  onUpdateCollection: (id: string, patch: Partial<ClassicLinkCollection>) => void;
  onRemoveCollection: (id: string) => void;
  onMoveCollection: (index: number, direction: -1 | 1) => void;
  onFileSelect: (id: string, file: File | null) => void;
};

type Panel = 'none' | 'preview' | 'design' | 'enhance' | 'profile';

function makeLocalId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function safeDisplayUrl(value: string) {
  return value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function isValidHttpUrl(value: string) {
  return /^https:\/\//i.test(value.trim());
}

export default function ClassicLinkHubEditor(props: Props) {
  const {
    storeId,
    username,
    primaryPage,
    title,
    bio,
    avatarUrl,
    verified,
    socialLinks,
    links,
    collections,
    background,
    accent,
    textColor,
    mutedTextColor,
    buttonStyle,
    linkShape,
    linkShadow,
    linkTextAlign,
    themeOptions,
    onChange,
    onSave,
    saving,
    profileEditor,
    onAddLink,
    onUpdateLink,
    onRemoveLink,
    onMoveLink,
    onAddCollection,
    onUpdateCollection,
    onRemoveCollection,
    onMoveCollection,
    onFileSelect,
    ...rendererProps
  } = props;

  const [panel, setPanel] = useState<Panel>('none');
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(links[0]?.id || null);
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set(collections.map(item => item.id)));
  const [showAllSocials, setShowAllSocials] = useState(false);
  const [collectionDraft, setCollectionDraft] = useState('');
  const [addingCollection, setAddingCollection] = useState(false);
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null);
  const [editingCollectionTitle, setEditingCollectionTitle] = useState('');

  const selectedLink = links.find(item => item.id === selectedLinkId) || null;
  const publicUrl = getLinkHubPath(username, primaryPage);
  const visibleSocials = useMemo(() => {
    const configured = Object.entries(socialLinks || {}).filter(([, value]) => value);
    return showAllSocials ? configured : configured.slice(0, 7);
  }, [socialLinks, showAllSocials]);

  const ungroupedLinks = useMemo(() => links.filter(link => !link.collectionId), [links]);
  const groupedCollections = useMemo(() => {
    const known = new Map(collections.map(collection => [collection.id, collection]));
    return collections.map(collection => ({
      collection,
      links: links.filter(link => link.collectionId === collection.id),
    })).concat(links.filter(link => link.collectionId && !known.has(link.collectionId)).length ? [{ collection: { id: '__orphaned', title: 'Other links', enabled: true }, links: links.filter(link => link.collectionId && !known.has(link.collectionId)) }] : []);
  }, [collections, links]);

  function togglePanel(next: Exclude<Panel, 'none'>) {
    setPanel(current => current === next ? 'none' : next);
  }

  function addCollection() {
    const title = collectionDraft.trim();
    if (!title) return;
    onAddCollection(title);
    setCollectionDraft('');
    setAddingCollection(false);
  }

  function startCollectionEdit(collection: ClassicLinkCollection) { setEditingCollectionId(collection.id); setEditingCollectionTitle(collection.title); }
  function finishCollectionEdit() { if (!editingCollectionId) return; const title = editingCollectionTitle.trim(); if (title) onUpdateCollection(editingCollectionId, { title }); setEditingCollectionId(null); setEditingCollectionTitle(''); }

  function toggleCollection(id: string) {
    setExpandedCollections(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function updateSocial(id: string, value: string) {
    onChange({ socialLinks: { ...socialLinks, [id]: value.trim() } });
  }

  return (
    <div className="classic-linkhub-editor-shell">
      <div className="classic-linkhub-editor-header">
        <div className="classic-linkhub-editor-brand">
          <div className="classic-linkhub-editor-icon"><Link2 size={17} /></div>
          <div>
            <div className="eyebrow">LINK IN BIO / DEFAULT</div>
            <h2>Links</h2>
            <p>Build the stacked Linktree-style version of your page. Your Bento layout stays saved separately.</p>
          </div>
        </div>
        <div className="classic-linkhub-editor-actions">
          <a className="btn" href={publicUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /> View page</a>
          <button className="btn btn-primary" type="button" onClick={onSave} disabled={saving}><Save size={15} /> {saving ? 'Saving…' : 'Save hub'}</button>
        </div>
      </div>

      <div className="classic-linkhub-layout">
        <section className="classic-linkhub-main">
          <div className="classic-editor-profile-card">
            <div className="classic-editor-profile-top">
              <div className="classic-editor-avatar">
                {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{title.slice(0, 1).toUpperCase() || '✦'}</span>}
              </div>
              <div className="classic-editor-profile-copy">
                <span className="eyebrow">PROFILE</span>
                <h3>{title || 'Your name'}</h3>
                <p>{bio || 'Your corner of the internet.'}</p>
                {verified ? <span className="classic-editor-verified"><Check size={12} /> Verified</span> : null}
              </div>
              <button className="icon-btn" type="button" aria-label="Edit profile" onClick={() => togglePanel('profile')}><Edit3 size={17} /></button>
            </div>
            {visibleSocials.length > 0 ? (
              <div className="classic-editor-social-row">
                {visibleSocials.map(([id, value]) => <button className="classic-editor-social-chip" type="button" key={id} title={getSocialPlatform(id).label} onClick={() => togglePanel('profile')}><SocialIcon platform={id} size="sm" /><span>{getSocialPlatform(id).label}</span></button>)}
                {Object.keys(socialLinks || {}).length > 7 ? <button className="classic-editor-more" type="button" onClick={() => setShowAllSocials(value => !value)}>{showAllSocials ? 'Less' : `+${Object.keys(socialLinks).length - 7}`}</button> : null}
              </div>
            ) : <button className="classic-editor-add-social" type="button" onClick={() => togglePanel('profile')}><Plus size={14} /> Add social profile</button>}
          </div>

          <div className="classic-editor-section-head">
            <div>
              <span className="eyebrow">CONTENT</span>
              <h3>Your links</h3>
              <p>Drag the order, group links into collections and customize each card.</p>
            </div>
            <button className="btn btn-sm" type="button" onClick={() => onAddLink('link')}><Plus size={14} /> Add link</button>
          </div>

          <div className="classic-editor-add-bar">
            <button type="button" onClick={() => onAddLink('link')}><Link2 size={16} /><span><b>Link</b><small>Any URL or destination</small></span></button>
            <button type="button" onClick={() => onAddLink('spotify')}><Play size={16} /><span><b>Spotify</b><small>Playlist, track or profile</small></span></button>
            <button type="button" onClick={() => setAddingCollection(true)}><Layers3 size={16} /><span><b>Collection</b><small>Group related links</small></span></button>
          </div>

          {addingCollection ? (
            <div className="classic-editor-inline-form">
              <input className="input" autoFocus value={collectionDraft} onChange={event => setCollectionDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addCollection(); if (event.key === 'Escape') setAddingCollection(false); }} placeholder="Collection name, e.g. Social media" maxLength={70} />
              <button className="btn btn-primary" type="button" onClick={addCollection}>Add collection</button>
              <button className="btn" type="button" onClick={() => { setCollectionDraft(''); setAddingCollection(false); }}>Cancel</button>
            </div>
          ) : null}

          {ungroupedLinks.map((link) => (
            <ClassicEditorLinkRow
              key={link.id}
              link={link}
              selected={link.id === selectedLinkId}
              collections={collections}
              onSelect={() => setSelectedLinkId(link.id)}
              onChange={patch => onUpdateLink(link.id, patch)}
              onRemove={() => onRemoveLink(link.id)}
              onMove={(direction) => onMoveLink(links.findIndex(item => item.id === link.id), direction)}
              onFileSelect={file => onFileSelect(link.id, file)}
            />
          ))}

          {groupedCollections.map(({ collection, links: collectionLinks }) => {
            if (!collection.enabled && collection.id !== '__orphaned') return null;
            const expanded = expandedCollections.has(collection.id);
            return (
              <div className="classic-editor-collection" key={collection.id}>
                <div className="classic-editor-collection-head">
                  <button type="button" className="classic-editor-collection-toggle" onClick={() => toggleCollection(collection.id)} aria-expanded={expanded}>
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    {editingCollectionId === collection.id ? <input className="classic-editor-collection-input" value={editingCollectionTitle} autoFocus onClick={event => event.stopPropagation()} onChange={event => setEditingCollectionTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); finishCollectionEdit(); } if (event.key === 'Escape') { setEditingCollectionId(null); setEditingCollectionTitle(''); } }} onBlur={finishCollectionEdit} aria-label="Collection title" maxLength={80} /> : <span>{collection.title}</span>}
                  </button>
                  {collection.id !== '__orphaned' ? <div className="row-actions">
                    <button className="icon-btn icon-btn-sm" type="button" onClick={() => startCollectionEdit(collection)} aria-label="Rename collection"><Edit3 size={14} /></button>
                    <button className="icon-btn icon-btn-sm" type="button" onClick={() => onMoveCollection(collections.findIndex(item => item.id === collection.id), -1)} aria-label="Move collection up"><ArrowUp size={14} /></button>
                    <button className="icon-btn icon-btn-sm" type="button" onClick={() => onMoveCollection(collections.findIndex(item => item.id === collection.id), 1)} aria-label="Move collection down"><ArrowDown size={14} /></button>
                    <button className="icon-btn icon-btn-sm danger" type="button" onClick={() => onRemoveCollection(collection.id)} aria-label="Delete collection"><Trash2 size={14} /></button>
                  </div> : null}
                </div>
                {expanded ? <div className="classic-editor-collection-body">
                  {collectionLinks.length ? collectionLinks.map((link) => <ClassicEditorLinkRow
                    key={link.id}
                    link={link}
                    selected={link.id === selectedLinkId}
                    collections={collections}
                    onSelect={() => setSelectedLinkId(link.id)}
                    onChange={patch => onUpdateLink(link.id, patch)}
                    onRemove={() => onRemoveLink(link.id)}
                    onMove={(direction) => onMoveLink(links.findIndex(item => item.id === link.id), direction)}
                    onFileSelect={file => onFileSelect(link.id, file)}
                  />) : <div className="classic-editor-empty-collection">No links in this collection yet. Add a link and assign it below.</div>}
                </div> : null}
              </div>
            );
          })}

          {!links.length ? <div className="classic-editor-empty"><Link2 size={20} /><b>Start with your first link</b><span>Your existing links will appear here when you switch from Bento.</span><button className="btn btn-primary" type="button" onClick={() => onAddLink('link')}>Add your first link</button></div> : null}

          {panel === 'profile' ? (
            <div className="classic-editor-sheet">
              <div className="classic-editor-sheet-head"><div><span className="eyebrow">PROFILE & SOCIALS</span><h3>Edit your profile</h3></div><button className="icon-btn" type="button" onClick={() => setPanel('none')} aria-label="Close profile editor"><X size={18} /></button></div>
              {profileEditor}
              <div className="classic-editor-social-fields">
                <div className="classic-editor-subhead"><b>Social profiles</b><small>Add full profile URLs and choose which ones appear on the page.</small></div>
                {(showAllSocials ? SOCIAL_PLATFORMS : SOCIAL_PLATFORMS.filter(platform => ['instagram', 'youtube', 'x', 'spotify', 'threads', 'facebook', 'website'].includes(platform.id))).map(platform => (
                  <label className="classic-social-field" key={platform.id}>
                    <span><SocialIcon platform={platform.id} size="sm" /><b>{platform.label}</b></span>
                    <input className="input" value={socialLinks[platform.id] || ''} onChange={event => updateSocial(platform.id, event.target.value)} placeholder={getSocialPlatform(platform.id).placeholder} />
                  </label>
                ))}
                <button className="btn btn-sm" type="button" onClick={() => setShowAllSocials(value => !value)}>{showAllSocials ? 'Show featured platforms' : 'Show all platforms'}</button>
              </div>
            </div>
          ) : null}
        </section>

        <aside className="classic-linkhub-preview-column">
          <div className="classic-editor-preview-toolbar">
            <div><span className="eyebrow">LIVE PREVIEW</span><b>Default / stacked</b></div>
            <button className="icon-btn" type="button" aria-label="Share public page" onClick={() => togglePanel('preview')}><Share2 size={17} /></button>
          </div>
          <div className="classic-editor-phone-frame">
            <ClassicLinkHubRenderer
              {...rendererProps}
              storeId={storeId}
              shareUrl={publicUrl}
              title={title}
              bio={bio}
              avatarUrl={avatarUrl}
              verified={verified}
              socialLinks={socialLinks}
              links={links}
              collections={collections}
              username={username}
              primaryPage={primaryPage}
              background={background}
              accent={accent}
              textColor={textColor}
              mutedTextColor={mutedTextColor}
              buttonStyle={buttonStyle}
              linkShape={linkShape}
              linkShadow={linkShadow}
              linkTextAlign={linkTextAlign}
              analyticsEnabled={false}
            />
          </div>
        </aside>
      </div>

      <div className="classic-editor-action-bar" aria-label="Link Hub editing tools">
        <button type="button" onClick={() => setAddingCollection(true)}><Plus size={18} /><span>Add</span></button>
        <button type="button" onClick={() => togglePanel('preview')}><Menu size={18} /><span>Preview</span></button>
        <button type="button" onClick={() => togglePanel('design')}><Palette size={18} /><span>Design</span></button>
        <button type="button" onClick={() => togglePanel('enhance')} disabled={!selectedLink}><Sparkles size={18} /><span>Enhance</span></button>
      </div>

      {panel === 'preview' ? (
        <div className="classic-editor-overlay" role="dialog" aria-modal="true" aria-label="Link Hub preview">
          <div className="classic-editor-modal classic-editor-modal-preview"><div className="classic-editor-sheet-head"><div><span className="eyebrow">PREVIEW</span><h3>How your Link Hub looks</h3></div><button className="icon-btn" type="button" onClick={() => setPanel('none')} aria-label="Close preview"><X size={18} /></button></div><div className="classic-editor-modal-preview-body"><div className="classic-editor-phone-frame"><ClassicLinkHubRenderer {...rendererProps} storeId={storeId} shareUrl={publicUrl} title={title} bio={bio} avatarUrl={avatarUrl} verified={verified} socialLinks={socialLinks} links={links} collections={collections} username={username} primaryPage={primaryPage} background={background} accent={accent} textColor={textColor} mutedTextColor={mutedTextColor} buttonStyle={buttonStyle} linkShape={linkShape} linkShadow={linkShadow} linkTextAlign={linkTextAlign} analyticsEnabled={false} /></div></div></div>
        </div>
      ) : null}

      {panel === 'design' ? (
        <div className="classic-editor-overlay" role="dialog" aria-modal="true" aria-label="Link Hub design editor">
          <div className="classic-editor-modal"><div className="classic-editor-sheet-head"><div><span className="eyebrow">DESIGN</span><h3>Make the stack yours</h3></div><button className="icon-btn" type="button" onClick={() => setPanel('none')} aria-label="Close design editor"><X size={18} /></button></div>
            <div className="classic-editor-design-content">
              <div className="classic-editor-subhead"><b>Theme</b><small>Start with one of your onboarding looks, then fine-tune the stack.</small></div>
              <div className="classic-design-theme-grid">{themeOptions.map(theme => <button key={theme.id} className={`classic-design-theme ${background === theme.background && accent === theme.accent ? 'selected' : ''}`} type="button" onClick={() => onChange({ theme: theme.id, background: theme.background, accent: theme.accent, textColor: theme.textColor, mutedTextColor: theme.mutedTextColor })}><span style={{ background: `linear-gradient(135deg, ${theme.background}, ${theme.accent})` }} /><b>{theme.name}</b><small>{theme.note}</small>{background === theme.background && accent === theme.accent ? <i><Check size={12} /></i> : null}</button>)}</div>
              <div className="classic-editor-design-grid">
                <label className="classic-design-field"><span>Background</span><input type="color" value={background} onChange={event => onChange({ background: event.target.value })} /></label>
                <label className="classic-design-field"><span>Accent</span><input type="color" value={accent} onChange={event => onChange({ accent: event.target.value })} /></label>
                <label className="classic-design-field"><span>Text</span><input type="color" value={textColor} onChange={event => onChange({ textColor: event.target.value })} /></label>
                <label className="classic-design-field"><span>Muted text</span><input type="color" value={mutedTextColor} onChange={event => onChange({ mutedTextColor: event.target.value })} /></label>
              </div>
              <div className="classic-editor-subhead"><b>Link cards</b><small>These controls only affect the Default/stacked template.</small></div>
              <div className="classic-segmented">
                {(['solid', 'soft', 'outline'] as const).map(value => <button key={value} type="button" className={buttonStyle === value ? 'active' : ''} onClick={() => onChange({ buttonStyle: value })}>{value}</button>)}
              </div>
              <div className="classic-segmented">
                {(['rounded', 'pill', 'square'] as const).map(value => <button key={value} type="button" className={linkShape === value ? 'active' : ''} onClick={() => onChange({ linkShape: value })}>{value}</button>)}
              </div>
              <div className="classic-segmented">
                {(['left', 'center'] as const).map(value => <button key={value} type="button" className={linkTextAlign === value ? 'active' : ''} onClick={() => onChange({ linkTextAlign: value })}>{value} text</button>)}
              </div>
              <label className="classic-check-row"><input type="checkbox" checked={linkShadow} onChange={event => onChange({ linkShadow: event.target.checked })} /><span>Use card shadows</span></label>
            </div>
          </div>
        </div>
      ) : null}

      {panel === 'enhance' && selectedLink ? (
        <div className="classic-editor-overlay" role="dialog" aria-modal="true" aria-label="Link enhancement editor">
          <div className="classic-editor-modal"><div className="classic-editor-sheet-head"><div><span className="eyebrow">ENHANCE LINK</span><h3>{selectedLink.label || 'Untitled link'}</h3></div><button className="icon-btn" type="button" onClick={() => setPanel('none')} aria-label="Close enhancement editor"><X size={18} /></button></div>
            <div className="classic-editor-enhance-content">
              <label className="classic-enhance-field"><span>Label</span><input className="input" value={selectedLink.label} onChange={event => onUpdateLink(selectedLink.id, { label: event.target.value })} /></label>
              <label className="classic-enhance-field"><span>URL</span><input className="input" value={selectedLink.url} onChange={event => onUpdateLink(selectedLink.id, { url: event.target.value })} placeholder="https://example.com" /></label>
              <div className="classic-editor-subhead"><b>Layout</b><small>Choose how this link appears in the stacked page.</small></div>
              <div className="classic-layout-choice-grid">
                <button type="button" className={selectedLink.layout !== 'featured' ? 'selected' : ''} onClick={() => onUpdateLink(selectedLink.id, { layout: 'classic' })}><div className="classic-layout-sample classic-layout-sample-classic"><span /><i>•••</i></div><b>Classic</b><small>Efficient, direct and compact.</small></button>
                <button type="button" className={selectedLink.layout === 'featured' ? 'selected' : ''} onClick={() => onUpdateLink(selectedLink.id, { layout: 'featured' })}><div className="classic-layout-sample classic-layout-sample-featured"><span /><strong>{selectedLink.label || 'Featured link'}</strong></div><b>Featured</b><small>Larger and more prominent.</small></button>
              </div>
              <div className="classic-editor-subhead"><b>Thumbnail</b><small>Upload an image or use a public HTTPS image URL.</small></div>
              <input className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={event => onFileSelect(selectedLink.id, event.target.files?.[0] || null)} />
              <input className="input" value={selectedLink.thumbnailUrl || ''} onChange={event => onUpdateLink(selectedLink.id, { thumbnailUrl: event.target.value || null })} placeholder="https://…" />
              <label className="classic-check-row"><input type="checkbox" checked={selectedLink.animate === true} onChange={event => onUpdateLink(selectedLink.id, { animate: event.target.checked })} /><span><Zap size={15} /> Animate this link</span></label>
              <div className="classic-editor-subhead"><b>Collection</b><small>Move this link into a group.</small></div>
              <select className="input" value={selectedLink.collectionId || ''} onChange={event => onUpdateLink(selectedLink.id, { collectionId: event.target.value || null })}><option value="">No collection</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.title}</option>)}</select>
              <div className="classic-editor-subhead"><b>Schedule</b><small>Optional visibility window; existing entitlement checks still apply.</small></div>
              <div className="form-grid-2">
                <label className="label">Start<input className="input" type="datetime-local" value={selectedLink.startAt ? selectedLink.startAt.slice(0, 16) : ''} onChange={event => onUpdateLink(selectedLink.id, { startAt: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label>
                <label className="label">End<input className="input" type="datetime-local" value={selectedLink.endAt ? selectedLink.endAt.slice(0, 16) : ''} onChange={event => onUpdateLink(selectedLink.id, { endAt: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label>
              </div>
              {!isValidHttpUrl(selectedLink.url) && <div className="warning-box">Visible links must use a full HTTPS URL before you save.</div>}
            </div>
          </div>
        </div>
      ) : null}

      <div className="classic-editor-mobile-save"><button className="btn btn-primary" type="button" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></div>
    </div>
  );
}

function ClassicEditorLinkRow({
  link,
  selected,
  collections,
  onSelect,
  onChange,
  onRemove,
  onMove,
  onFileSelect,
}: {
  link: ClassicEditorLink;
  selected: boolean;
  collections: ClassicLinkCollection[];
  onSelect: () => void;
  onChange: (patch: Partial<ClassicEditorLink>) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
  onFileSelect: (file: File | null) => void;
}) {
  const thumbnail = link.thumbnailUrl;
  return (
    <div className={`classic-editor-link-card ${selected ? 'selected' : ''}`}>
      <button type="button" className="classic-editor-link-select" onClick={onSelect} aria-label={`Edit ${link.label || 'link'}`}>
        <GripVertical size={15} className="classic-editor-drag" />
        <span className="classic-editor-link-copy">
          <b>{link.label || 'Untitled link'}</b>
          <small>{link.url ? safeDisplayUrl(link.url) : 'Add a URL'}</small>
        </span>
        {thumbnail ? <img src={thumbnail} alt="" className="classic-editor-link-thumb" /> : link.platform ? <SocialIcon platform={link.platform} size="sm" /> : null}
      </button>
      <div className="classic-editor-link-actions">
        <button className="icon-btn icon-btn-sm" type="button" onClick={() => onMove(-1)} aria-label="Move link up"><ArrowUp size={14} /></button>
        <button className="icon-btn icon-btn-sm" type="button" onClick={() => onMove(1)} aria-label="Move link down"><ArrowDown size={14} /></button>
        <label className="switch-control"><input type="checkbox" checked={link.enabled !== false} onChange={event => onChange({ enabled: event.target.checked })} /><span /></label>
        <button className="icon-btn icon-btn-sm danger" type="button" onClick={onRemove} aria-label="Delete link"><Trash2 size={14} /></button>
      </div>
      {selected ? (
        <div className="classic-editor-link-expanded">
          <div className="classic-editor-inline-fields">
            <input className="input" value={link.label} onChange={event => onChange({ label: event.target.value })} placeholder="Link title" />
            <input className="input" value={link.url} onChange={event => onChange({ url: event.target.value })} placeholder="https://example.com" />
          </div>
          <div className="classic-editor-link-mini-actions">
            <button className="btn btn-sm" type="button" onClick={() => onChange({ layout: link.layout === 'featured' ? 'classic' : 'featured' })}><Zap size={13} /> {link.layout === 'featured' ? 'Featured' : 'Classic'}</button>
            <select className="input" value={link.collectionId || ''} onChange={event => onChange({ collectionId: event.target.value || null })} aria-label="Collection"><option value="">No collection</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.title}</option>)}</select>
          </div>
        </div>
      ) : null}
    </div>
  );
}
