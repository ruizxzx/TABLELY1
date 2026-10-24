'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { BookOpen, BriefcaseBusiness, Code2, ImagePlus, Music2, Palette, Sparkles } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { publicMediaUrl, uploadStoreMedia } from '../../lib/storage';
import { getSocialPlatform, SOCIAL_PLATFORMS, SocialIcon } from '../../components/SocialIcon';
import BentoBlockEditor from '../../components/BentoBlockEditor';
import LinkEnhancementEditor from '../../components/LinkEnhancementEditor';
import ClassicLinkHubEditor, { type ClassicEditorLink, type ClassicLinkCollection, type ClassicThemeOption } from '../../components/ClassicLinkHubEditor';
import type { BentoBlock, BentoPageDesign, BentoStarterTemplateKey } from '../../lib/bento';
import { BENTO_PAGE_DESIGN_DEFAULTS, BENTO_STARTER_TEMPLATES, createBentoStarterBlocks, getBentoStarterDesign, normalizeBentoPageDesign } from '../../lib/bento';
import { extractHubPatchFromBentoBlocks, getCanonicalBentoBlocks } from '../../lib/bento-hub';
import { getLinkHubPath, getStorePath, getPrimaryPublicPage, getLinkHubPublicTemplate, type PrimaryPublicPage, type LinkHubPublicTemplate } from '../../lib/public-paths';

type HubLink = ClassicEditorLink;
type HubConfig = { publicTemplate: LinkHubPublicTemplate; bentoDesign?: BentoPageDesign; linkShape: 'rounded' | 'pill' | 'square'; linkShadow: boolean; linkTextAlign: 'left' | 'center'; collections: ClassicLinkCollection[]; primaryPage: PrimaryPublicPage; enabled: boolean; onboardingComplete?: boolean; theme: 'editorial' | 'edge' | 'candy' | 'minimal' | 'midnight' | 'garden'; title: string; bio: string; location: string; availability: string; verified: boolean; contactEmail: string; whatsapp: string; contactTitle: string; newsletterEnabled: boolean; featured: { title: string; description: string; url: string; image: string } | null; projects: { id: string; name: string; description: string; url: string; image: string }[]; background: string; accent: string; textColor: string; mutedTextColor: string; buttonStyle: 'solid' | 'outline' | 'soft'; links: HubLink[]; socialLinks: Record<string, string>; blocks: BentoBlock[]; sectionOrder: string[] };

const defaults: HubConfig = { publicTemplate: 'default', bentoDesign: { ...BENTO_PAGE_DESIGN_DEFAULTS, cursorFx: 'magnetic' }, linkShape: 'rounded', linkShadow: true, linkTextAlign: 'center', collections: [], primaryPage: 'store', enabled: true, onboardingComplete: false, theme: 'editorial', title: '', bio: '', location: '', availability: '', verified: false, contactEmail: '', whatsapp: '', contactTitle: "Have an idea? Let's build it.", newsletterEnabled: true, featured: null, projects: [], background: '#f5f1ea', accent: '#d7653f', textColor: '#171811', mutedTextColor: '#68695e', buttonStyle: 'solid', links: [], socialLinks: {}, blocks: [], sectionOrder: ['profile', 'socials', 'featured', 'projects', 'store', 'newsletter', 'contact', 'links'] };
const themes: { id: HubConfig['theme']; name: string; note: string; background: string; accent: string; textColor: string; mutedTextColor: string }[] = [
  { id: 'editorial', name: 'Paper editorial', note: 'Warm, expressive and magazine-like', background: '#f5f1ea', accent: '#d7653f', textColor: '#171811', mutedTextColor: '#68695e' },
  { id: 'edge', name: 'Edge eyewear', note: 'Ink, cream and electric lime', background: '#f1efe6', accent: '#b8ed53', textColor: '#171811', mutedTextColor: '#5d6253' },
  { id: 'candy', name: 'Candy social', note: 'Playful pink, soft and loud', background: '#ffd7df', accent: '#e94c88', textColor: '#2a1620', mutedTextColor: '#75495a' },
  { id: 'minimal', name: 'Gallery white', note: 'Quiet, clean and high contrast', background: '#f7f7f4', accent: '#151515', textColor: '#151515', mutedTextColor: '#5b5b5b' },
  { id: 'midnight', name: 'After hours', note: 'Dark, glossy and cinematic', background: '#15151b', accent: '#b49cff', textColor: '#ffffff', mutedTextColor: '#c9c7d0' },
  { id: 'garden', name: 'Soft garden', note: 'Mint, blue and optimistic', background: '#dff4ed', accent: '#287d6e', textColor: '#17342f', mutedTextColor: '#4d7169' },
];
const featuredSocialIds = ['instagram', 'youtube', 'x', 'website', 'spotify', 'threads', 'facebook'];
const allSocialFields = SOCIAL_PLATFORMS.map(platform => [platform.id, platform.label] as const);
const STARTER_ICONS: Record<BentoStarterTemplateKey, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  creator: Sparkles, developer: Code2, musician: Music2, artist: Palette, educator: BookOpen, business: BriefcaseBusiness,
};

function makeId() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function validUrl(value: string) { return /^(https?:\/\/)/i.test(value.trim()); }

async function cropProfileImage(file: File, zoom: number, offsetX: number, offsetY: number) {
  const image = new Image();
  const sourceUrl = URL.createObjectURL(file);
  image.src = sourceUrl;
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Could not read this image.')); });
  const cropSize = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
  const maxX = (image.naturalWidth - cropSize) / 2;
  const maxY = (image.naturalHeight - cropSize) / 2;
  const sourceX = Math.max(0, Math.min(image.naturalWidth - cropSize, (image.naturalWidth - cropSize) / 2 - (offsetX / 50) * maxX));
  const sourceY = Math.max(0, Math.min(image.naturalHeight - cropSize, (image.naturalHeight - cropSize) / 2 - (offsetY / 50) * maxY));
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  canvas.getContext('2d')?.drawImage(image, sourceX, sourceY, cropSize, cropSize, 0, 0, 512, 512);
  URL.revokeObjectURL(sourceUrl);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Could not prepare the cropped image.');
  return new File([blob], 'profile-picture.jpg', { type: 'image/jpeg' });
}

export default function LinkHubEditor() {
  const [store, setStore] = useState<any>(null);
  const [productsForBento, setProductsForBento] = useState<any[]>([]);
  const [hub, setHub] = useState<HubConfig>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedRevision, setSavedRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [thumbnailFiles, setThumbnailFiles] = useState<Record<string, File>>({});
  const [onboarding, setOnboarding] = useState(false);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const cropStageRef = useRef<HTMLDivElement>(null);
  const cropDragRef = useRef<{ pointerId: number; x: number; y: number; cropX: number; cropY: number } | null>(null);

  useEffect(() => {
    (async () => {
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setMessage('Please sign in again.'); setLoading(false); return; }
      const { data, error } = await supabase.from('stores').select('id,username,name,avatar_url,verified_badge,updated_at,link_hub_config').eq('owner_id', user.id).maybeSingle();
      if (error) setMessage(error.message);
      if (data) {
        setStore(data);
        setAvatarUrl(publicMediaUrl(data.avatar_url));
        const saved = data.link_hub_config || {};
        setHub({ ...defaults, ...saved, publicTemplate: getLinkHubPublicTemplate(saved.publicTemplate), primaryPage: getPrimaryPublicPage(saved.primaryPage), verified: Boolean(data.verified_badge), links: Array.isArray(saved.links) ? saved.links : [], socialLinks: saved.socialLinks || {}, collections: Array.isArray(saved.collections) ? saved.collections : [], blocks: Array.isArray(saved.blocks) ? saved.blocks : [] });
        setOnboarding(saved.onboardingComplete !== true);
        const { data: products } = await supabase.from('public_products').select('id,title,slug,short_description,price,currency,cover_image_path,category_name').eq('store_id', data.id).order('created_at', { ascending: false }).limit(500);
        setProductsForBento((products || []).map((product: any) => ({ ...product, image: publicMediaUrl(product.cover_image_path) })));
      }
      setLoading(false);
    })();
  }, []);

  function selectAvatar(file: File | null) {
    if (!file) return;
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    setAvatar(file);
    setAvatarPreviewUrl(URL.createObjectURL(file));
    setCropZoom(1);
    setCropX(0);
    setCropY(0);
  }

  async function applyCrop() {
    if (!avatar) return;
    try {
      const cropped = await cropProfileImage(avatar, cropZoom, cropX, cropY);
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
      setAvatar(cropped);
      setAvatarPreviewUrl(URL.createObjectURL(cropped));
      setCropZoom(1);
      setCropX(0);
      setCropY(0);
      setMessage('Profile picture crop ready. Save the Link Hub to sync it everywhere.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not crop this image.'); }
  }

  function startCropDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!cropStageRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, cropX, cropY };
  }

  function moveCropDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = cropDragRef.current;
    const stage = cropStageRef.current;
    if (!drag || !stage || drag.pointerId !== event.pointerId) return;
    const bounds = stage.getBoundingClientRect();
    const nextX = Math.max(-50, Math.min(50, drag.cropX + ((event.clientX - drag.x) / bounds.width) * 100));
    const nextY = Math.max(-50, Math.min(50, drag.cropY + ((event.clientY - drag.y) / bounds.height) * 100));
    setCropX(nextX);
    setCropY(nextY);
  }

  function stopCropDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (cropDragRef.current?.pointerId === event.pointerId) cropDragRef.current = null;
  }

  const profilePhotoPicker = <label className="profile-upload"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={event=>selectAvatar(event.target.files?.[0] || null)}/><span className="profile-upload-icon"><ImagePlus size={21} strokeWidth={1.8}/></span><span className="profile-upload-copy"><b>{avatar ? 'Profile picture selected' : 'Upload your profile picture'}</b><small>{avatar ? avatar.name : 'JPG, PNG or WebP · up to 5 MB'}</small></span><span className="profile-upload-action">Choose image</span></label>;
  const profileCropEditor = avatarPreviewUrl && <div className="profile-crop-editor"><div ref={cropStageRef} className="profile-crop-stage" onPointerDown={startCropDrag} onPointerMove={moveCropDrag} onPointerUp={stopCropDrag} onPointerCancel={stopCropDrag}><img src={avatarPreviewUrl} alt="Crop preview" style={{ transform: `translate(${cropX / 2}%, ${cropY / 2}%) scale(${cropZoom})` }}/><span className="profile-crop-ring" /><span className="profile-crop-hint">Drag to position</span></div><div className="profile-crop-copy"><b>Frame your profile picture</b><small>Drag the photo inside the circle. This exact view will be used everywhere.</small></div><label className="crop-range">Zoom <input type="range" min="1" max="3" step="0.01" value={cropZoom} onChange={event => setCropZoom(Number(event.target.value))}/></label><button type="button" className="btn btn-dark crop-apply" onClick={() => void applyCrop()}>Use this crop</button></div>;

  const hubUrl = store?.username ? getLinkHubPath(store.username, hub.primaryPage) : '/links/your-handle';
  const storeUrl = store?.username ? getStorePath(store.username, hub.primaryPage) : '/store/your-handle';
  const bentoCanvasBlocks = useMemo(() => getCanonicalBentoBlocks({
    title: hub.title, bio: hub.bio, location: hub.location, availability: hub.availability, verified: hub.verified,
    avatarUrl: avatarPreviewUrl || avatarUrl || publicMediaUrl(store?.avatar_url), socialLinks: hub.socialLinks, featured: hub.featured,
    projects: hub.projects, links: hub.links, newsletterEnabled: hub.newsletterEnabled, contactEmail: hub.contactEmail, whatsapp: hub.whatsapp,
    contactTitle: hub.contactTitle, username: store?.username, primaryPage: hub.primaryPage, products: productsForBento, branding: true, existingBlocks: hub.blocks,
  }), [hub, avatarPreviewUrl, avatarUrl, productsForBento, store?.username, store?.avatar_url]);
  async function uploadBentoImage(file: File) {
    if (!supabase || !store) return null;
    if (!file.type.startsWith('image/')) { setMessage('Please choose an image file.'); return null; }
    if (file.size > 8 * 1024 * 1024) { setMessage('Bento images must be 8 MB or smaller.'); return null; }
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Please sign in again.');
      const path = await uploadStoreMedia(user.id, `bento-image-${Date.now()}`, file);
      return publicMediaUrl(path);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not upload the image.');
      return null;
    }
  }

  function update(patch: Partial<HubConfig>) { setHub(current => ({ ...current, ...patch })); setMessage(''); }
  function addLink(kind: 'link' | 'spotify') { update({ links: [...hub.links, { id: makeId(), kind, label: kind === 'spotify' ? 'Listen on Spotify' : 'New link', url: '', enabled: true, platform: kind === 'spotify' ? 'spotify' : 'website', startAt: null, endAt: null, thumbnailUrl: null }] }); }
  function updateLink(id: string, patch: Partial<HubLink>) { update({ links: hub.links.map(link => link.id === id ? { ...link, ...patch } : link) }); }
  function removeLink(id: string) { update({ links: hub.links.filter(link => link.id !== id) }); }
  function moveLink(index: number, direction: -1 | 1) { const next = [...hub.links]; const target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; update({ links: next }); }
  function moveLinkTo(linkId: string, targetId: string) { if (linkId === targetId) return; const next = [...hub.links]; const from = next.findIndex(link => link.id === linkId); const to = next.findIndex(link => link.id === targetId); if (from < 0 || to < 0) return; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); update({ links: next }); }
  function addCollection(title: string) { const trimmed = title.trim(); if (!trimmed) return; update({ collections: [...hub.collections, { id: makeId(), title: trimmed, enabled: true }] }); }
  function updateCollection(id: string, patch: Partial<ClassicLinkCollection>) { update({ collections: hub.collections.map(collection => collection.id === id ? { ...collection, ...patch } : collection) }); }
  function removeCollection(id: string) { update({ collections: hub.collections.filter(collection => collection.id !== id), links: hub.links.map(link => link.collectionId === id ? { ...link, collectionId: null } : link) }); }
  function moveCollection(index: number, direction: -1 | 1) { const next = [...hub.collections]; const target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; update({ collections: next }); }
  function addProject() { update({ projects: [...hub.projects, { id: makeId(), name: 'New project', description: '', url: '', image: '' }] }); }
  function updateProject(id: string, patch: Partial<HubConfig['projects'][number]>) { update({ projects: hub.projects.map(project => project.id === id ? { ...project, ...patch } : project) }); }
  function removeProject(id: string) { update({ projects: hub.projects.filter(project => project.id !== id) }); }
  function moveProject(index: number, direction: -1 | 1) { const next = [...hub.projects]; const target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; update({ projects: next }); }
  function moveSection(index: number, direction: -1 | 1) { const next = [...hub.sectionOrder]; const target = index + direction; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; update({ sectionOrder: next }); }

  async function save() {
    if (!supabase || !store) return;
    const invalid = hub.links.find(link => link.enabled && (!link.label.trim() || !validUrl(link.url)));
    if (invalid) { setMessage('Every enabled link needs a label and a full https:// URL.'); return; }
    if (hub.featured && hub.featured.url && !validUrl(hub.featured.url)) { setMessage('Featured project URL must start with https://.'); return; }
    setSaving(true); setMessage('Saving link hub…');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Please sign in again.');
      const { data: { user } } = await supabase.auth.getUser();
      let nextAvatar = store.avatar_url || null;
      if (avatar && user) nextAvatar = await uploadStoreMedia(user.id, 'profile', avatar);
      let nextHub = hub;
      if (user && Object.keys(thumbnailFiles).length) {
        const links = [...hub.links];
        for (const [linkId, file] of Object.entries(thumbnailFiles)) {
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Link thumbnails must be JPG, PNG or WebP images up to 5 MB.');
          const path = await uploadStoreMedia(user.id, `link-${linkId}`, file);
          const link = links.find(item => item.id === linkId);
          if (link) link.thumbnailUrl = publicMediaUrl(path);
        }
        nextHub = { ...hub, links };
      }
      const response = await fetch('/api/studio/store', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ linkHubConfig: nextHub, avatarUrl: nextAvatar, expectedUpdatedAt: store.updated_at }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not save link hub.');
      const savedConfig = payload.data.link_hub_config || hub;
      setHub({ ...defaults, ...savedConfig, publicTemplate: getLinkHubPublicTemplate(savedConfig.publicTemplate ?? hub.publicTemplate), primaryPage: getPrimaryPublicPage(savedConfig.primaryPage ?? hub.primaryPage), links: Array.isArray(savedConfig.links) ? savedConfig.links : hub.links, socialLinks: savedConfig.socialLinks || hub.socialLinks, collections: Array.isArray(savedConfig.collections) ? savedConfig.collections : hub.collections, blocks: Array.isArray(savedConfig.blocks) ? savedConfig.blocks : hub.blocks });
      setStore(payload.data);
      setAvatar(null);
      setThumbnailFiles({});
      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
      setAvatarPreviewUrl(null);
      setAvatarUrl(publicMediaUrl(payload.data.avatar_url));
      setSavedRevision(value => value + 1);
      setMessage('Link hub saved.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save link hub.'); }
    finally { setSaving(false); }
  }

  const linksEditor = <div className="bento-legacy-link-tools">
    <div className="row-actions"><button className="btn btn-sm" type="button" onClick={() => addLink('link')}>+ Add link</button><button className="btn btn-sm" type="button" onClick={() => addLink('spotify')}>+ Spotify</button></div>
    {hub.links.map((link, index) => <div className="bento-node-link-row" key={link.id}>
      <div className="bento-node-link-row-head"><b>{link.kind === 'spotify' ? 'Spotify' : 'Link'} {index + 1}</b><div className="row-actions"><button className="btn btn-sm" type="button" onClick={() => moveLink(index, -1)} disabled={index === 0}>↑</button><button className="btn btn-sm" type="button" onClick={() => moveLink(index, 1)} disabled={index === hub.links.length - 1}>↓</button><button className="btn btn-sm" type="button" onClick={() => removeLink(link.id)}>Remove</button></div></div>
      <input className="bento-input" value={link.label} onChange={event => updateLink(link.id, { label: event.target.value })} placeholder="Button label" />
      <input className="bento-input" value={link.url} onChange={event => updateLink(link.id, { url: event.target.value })} placeholder={link.kind === 'spotify' ? 'https://open.spotify.com/…' : 'https://…'} />
      <label className="bento-toggle-row"><input type="checkbox" checked={link.enabled} onChange={event => updateLink(link.id, { enabled: event.target.checked })}/><span>Visible</span></label>
    </div>)}
    {!hub.links.length && <p className="bento-help">No links yet. Add one to place it in the Links node.</p>}
    <LinkEnhancementEditor links={hub.links} onChange={(id, patch) => updateLink(id, patch)} onFileSelect={(id, file) => { if (file) setThumbnailFiles(current => ({ ...current, [id]: file })); }} />
  </div>;

  if (loading) return <div className="studio-content"><div className="loading-card card">Loading link hub…</div></div>;
  if (!store) return <LinkHubFirstRun message={message} onCreated={data => { setStore(data); setHub({ ...defaults, title: data.name || '' }); setOnboarding(true); setMessage(''); }} />;
  if (onboarding) return <LinkHubOnboarding store={store} initial={hub} avatar={avatar} avatarUrl={avatarUrl} avatarPreviewUrl={avatarPreviewUrl} profilePhotoPicker={profilePhotoPicker} profileCropEditor={profileCropEditor} onDone={(next, savedStore) => { setHub(next); if (savedStore) setStore(savedStore); setOnboarding(false); }} />;

  return <div className="studio-content link-hub-editor">
    <div className="page-title"><div><div className="eyebrow">LINK IN BIO</div><h1>Link hub</h1><p>Turn your audience profile into one beautiful home for your work, socials, playlists and store.</p></div><div className="row-actions"><button className="btn" type="button" onClick={() => setOnboarding(true)}>Change look</button><Link className="btn" href={hubUrl} target="_blank">View page ↗</Link><button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save hub'}</button></div></div>
    <div className="card panel public-path-settings"><div className="section-label">PUBLIC PAGE TEMPLATE</div><p className="muted">Choose how visitors see your Link Hub. Switching templates never deletes your links or your saved Bento layout.</p><div className="public-template-options" role="radiogroup" aria-label="Public page template"><button type="button" role="radio" aria-checked={hub.publicTemplate === 'default'} className={`public-template-option ${hub.publicTemplate === 'default' ? 'active' : ''}`} onClick={() => update({ publicTemplate: 'default' })}><b>Default</b><span>Classic link-in-bio</span><small>Vertical link stack, socials and creator profile.</small></button><button type="button" role="radio" aria-checked={hub.publicTemplate === 'bento'} className={`public-template-option ${hub.publicTemplate === 'bento' ? 'active' : ''}`} onClick={() => update({ publicTemplate: 'bento' })}><b>Bento</b><span>Grid layout</span><small>Your saved Bento blocks, positions and styling.</small></button></div></div>
    <div className="card panel public-path-settings"><div className="section-label">PUBLIC URLS</div><p className="muted">Choose which page owns your clean URL. The other page automatically gets its explicit namespace.</p><div className="public-path-options" role="radiogroup" aria-label="Primary public page"><button type="button" role="radio" aria-checked={hub.primaryPage === 'linkhub'} className={`public-path-option ${hub.primaryPage === 'linkhub' ? 'active' : ''}`} onClick={() => update({ primaryPage: 'linkhub' })}><b>Link Hub</b><span>/{store?.username || 'your-handle'}</span><small>Storefront: {storeUrl}</small></button><button type="button" role="radio" aria-checked={hub.primaryPage === 'store'} className={`public-path-option ${hub.primaryPage === 'store' ? 'active' : ''}`} onClick={() => update({ primaryPage: 'store' })}><b>Storefront</b><span>/{store?.username || 'your-handle'}</span><small>Link Hub: {hubUrl}</small></button></div></div>
    {message && <div className={message.includes('saved') ? 'success-box' : 'error-box'} style={{ marginBottom: 16 }}>{message}</div>}
    {hub.publicTemplate === 'bento' ? <BentoBlockEditor
      blocks={bentoCanvasBlocks}
      shareUrl={hubUrl}
      storeId={store.id}
      pageDesign={hub.bentoDesign}
      savedRevision={savedRevision}
      onPageDesignChange={bentoDesign => update({ bentoDesign })}
      onChange={blocks => update({ blocks, ...extractHubPatchFromBentoBlocks(blocks) as Partial<HubConfig> })}
      onUploadMedia={uploadBentoImage}
      profileMediaEditor={<>{profilePhotoPicker}{profileCropEditor}<small className="bento-help">The cropped image syncs to your Store and Link Hub when you save.</small></>}
      linksEditor={linksEditor}
    /> : <ClassicLinkHubEditor
      storeId={store.id}
      username={store.username}
      primaryPage={hub.primaryPage}
      title={hub.title}
      bio={hub.bio}
      avatarUrl={avatarPreviewUrl || avatarUrl || publicMediaUrl(store.avatar_url)}
      verified={hub.verified}
      location={hub.location}
      availability={hub.availability}
      socialLinks={hub.socialLinks}
      links={hub.links}
      collections={hub.collections}
      featured={hub.featured}
      projects={hub.projects}
      contactEmail={hub.contactEmail}
      whatsapp={hub.whatsapp}
      contactTitle={hub.contactTitle}
      newsletterEnabled={hub.newsletterEnabled}
      branding={true}
      background={hub.background}
      accent={hub.accent}
      textColor={hub.textColor}
      mutedTextColor={hub.mutedTextColor}
      buttonStyle={hub.buttonStyle}
      linkShape={hub.linkShape}
      linkShadow={hub.linkShadow}
      linkTextAlign={hub.linkTextAlign}
      themeOptions={themes as ClassicThemeOption[]}
      onChange={patch => update(patch as Partial<HubConfig>)}
      onSave={save}
      saving={saving}
      profileEditor={<>{profilePhotoPicker}{profileCropEditor}<div className="classic-editor-profile-fields"><label className="label">Display name<input className="input" value={hub.title} onChange={event => update({ title: event.target.value })} maxLength={80}/></label><label className="label">Bio<textarea className="input" value={hub.bio} onChange={event => update({ bio: event.target.value })} maxLength={240} style={{ minHeight: 100, paddingTop: 12 }}/></label><div className="form-grid-2"><label className="label">Location<input className="input" value={hub.location} onChange={event => update({ location: event.target.value })} maxLength={100}/></label><label className="label">Availability<input className="input" value={hub.availability} onChange={event => update({ availability: event.target.value })} maxLength={100}/></label></div></div></>}
      onAddLink={addLink}
      onUpdateLink={(id, patch) => updateLink(id, patch)}
      onRemoveLink={removeLink}
      onMoveLink={moveLink}
      onAddCollection={addCollection}
      onUpdateCollection={updateCollection}
      onRemoveCollection={removeCollection}
      onMoveCollection={moveCollection}
      onFileSelect={(id, file) => { if (file) setThumbnailFiles(current => ({ ...current, [id]: file })); }}
    />}
  </div>;
}

function LinkHubFirstRun({ message, onCreated }: { message: string; onCreated: (store: any) => void }) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function create() {
    const cleanUsername = username.trim().replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!name.trim()) { setError('Add a display name to continue.'); return; }
    if (cleanUsername.length < 3) { setError('Choose an @handle with at least 3 letters, numbers or underscores.'); return; }
    setSaving(true); setError('');
    try {
      const { data: { session } } = await supabase!.auth.getSession();
      if (!session?.access_token) throw new Error('Please sign in again.');
      const response = await fetch('/api/studio/store', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ name: name.trim(), username: cleanUsername }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not create your Link Hub.');
      onCreated(payload.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create your Link Hub.'); }
    finally { setSaving(false); }
  }

  return <div className="studio-content link-hub-first-run"><div className="link-hub-first-run-card"><div className="eyebrow">LINK IN BIO</div><h1>Create your Link Hub first.</h1><p>Start with one beautiful page for your links, socials and projects. You can add a storefront whenever you are ready.</p><div className="first-run-preview"><div className="first-run-avatar">✦</div><b>{name || 'Your name'}</b><span>@{username.replace(/^@+/, '') || 'your-handle'}</span><i>Instagram</i><i>Shop my store</i></div><label className="label">Display name</label><input className="input" value={name} onChange={event => setName(event.target.value)} placeholder="Your name or brand" maxLength={80}/><label className="label">Your @handle</label><div className="handle-input"><span>@</span><input className="input" value={username.replace(/^@+/, '')} onChange={event => setUsername(event.target.value)} placeholder="yourhandle" maxLength={30}/></div><small className="muted">This handle powers both your Link Hub at <b>/handle</b> and your storefront at <b>/store/handle</b>. You can change it later if available.</small>{(error || message) && <div className="error-box" style={{ marginTop: 16 }}>{error || message}</div>}<button className="btn btn-primary first-run-submit" onClick={() => void create()} disabled={saving}>{saving ? 'Creating your page…' : 'Continue to Link Hub onboarding'}</button></div></div>;
}

function LinkHubOnboarding({ store, initial, avatar, avatarUrl, avatarPreviewUrl, profilePhotoPicker, profileCropEditor, onDone }: { store: any; initial: HubConfig; avatar: File | null; avatarUrl: string | null; avatarPreviewUrl: string | null; profilePhotoPicker: ReactNode; profileCropEditor: ReactNode; onDone: (hub: HubConfig, savedStore?: any) => void }) {
  const [step, setStep] = useState(1);
  const [showAllPlatforms, setShowAllPlatforms] = useState(false);
  const [theme, setTheme] = useState(initial.theme);
  const [templateKey, setTemplateKey] = useState<BentoStarterTemplateKey>('creator');
  const hasLegacyCreatorContent = Boolean(
    initial.blocks.length ||
    initial.title.trim() ||
    initial.bio.trim() ||
    initial.location.trim() ||
    initial.contactEmail.trim() ||
    initial.whatsapp.trim() ||
    Object.values(initial.socialLinks || {}).some(value => Boolean(String(value || '').trim())) ||
    initial.links.length ||
    initial.projects.length ||
    initial.featured
  );
  const isEmptyPage = !hasLegacyCreatorContent;
  const [selected, setSelected] = useState<string[]>(Object.keys(initial.socialLinks || {}).filter(key => initial.socialLinks[key]));
  const [handles, setHandles] = useState<Record<string, string>>(initial.socialLinks || {});
  const [quickLinks, setQuickLinks] = useState<HubLink[]>(Array.isArray(initial.links) ? initial.links.map(link => ({ ...link })) : []);
  const initialProfile = initial.blocks.find(block => block.systemKey === 'profile');
  const [title, setTitle] = useState(String(initialProfile?.config?.title || initial.title || store.name || ''));
  const [bio, setBio] = useState(String(initialProfile?.config?.bio || initial.bio || ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const selectedTheme = themes.find(item => item.id === theme) || themes[0];
  const visibleSocialFields = (showAllPlatforms ? allSocialFields : allSocialFields.filter(([id]) => featuredSocialIds.includes(id) || selected.includes(id)));

  function togglePlatform(id: string) {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : current.length < 7 ? [...current, id] : current);
    setError('');
  }

  function platformUrl(id: string, value: string) {
    const input = value.trim();
    if (!input) return '';
    if (validUrl(input)) return input;
    const clean = input.replace(/^@/, '');
    return `${getSocialPlatform(id).base}${clean}`;
  }

  function addQuickLink() {
    if (quickLinks.length >= 5) return;
    setQuickLinks(current => [...current, { id: makeId(), kind: 'link', label: '', url: '', enabled: true, platform: 'website', startAt: null, endAt: null, thumbnailUrl: null }]);
  }

  function updateQuickLink(id: string, patch: Partial<HubLink>) {
    setQuickLinks(current => current.map(link => link.id === id ? { ...link, ...patch } : link));
  }

  function removeQuickLink(id: string) {
    setQuickLinks(current => current.filter(link => link.id !== id));
  }

  async function finish() {
    setSaving(true); setError('');
    try {
      if (!title.trim()) throw new Error('Add a display name to continue.');
      const socialLinks = Object.fromEntries(selected.filter(id => handles[id]?.trim()).map(id => [id, platformUrl(id, handles[id])]));
      const incompleteLink = quickLinks.find(link => {
        const hasAny = Boolean(link.label.trim() || link.url.trim());
        return hasAny && (!link.label.trim() || !validUrl(link.url));
      });
      if (incompleteLink) throw new Error('Complete each custom link with a label and a full https:// URL, or remove the empty row.');
      const links = quickLinks.filter(link => link.label.trim() && validUrl(link.url)).map(link => ({ ...link, label: link.label.trim(), url: link.url.trim(), enabled: link.enabled !== false }));
      const chosen = themes.find(item => item.id === theme) || themes[0];
      const templateDesign = getBentoStarterDesign(templateKey);
      const nextDesign = normalizeBentoPageDesign(isEmptyPage ? { ...templateDesign, background: chosen.background, accent: chosen.accent, textColor: chosen.textColor, mutedTextColor: chosen.mutedTextColor } : { ...defaults.bentoDesign, ...(initial.bentoDesign || {}), background: chosen.background, accent: chosen.accent, textColor: chosen.textColor, mutedTextColor: chosen.mutedTextColor });
      const { data: { session } } = await supabase!.auth.getSession();
      if (!session?.access_token) throw new Error('Please sign in again.');
      const { data: { user } } = await supabase!.auth.getUser();
      const uploadedAvatarUrl = avatar && user ? await uploadStoreMedia(user.id, 'profile', avatar) : null;
      const resolvedAvatarUrl = uploadedAvatarUrl || avatarUrl || publicMediaUrl(store?.avatar_url) || undefined;
      const source = {
        title: title.trim(), bio: bio.trim(), avatarUrl: resolvedAvatarUrl, socialLinks, featured: initial.featured,
        projects: initial.projects, links, newsletterEnabled: initial.newsletterEnabled, contactEmail: initial.contactEmail,
        whatsapp: initial.whatsapp, contactTitle: initial.contactTitle, username: store?.username, primaryPage: initial.primaryPage, branding: true,
        existingBlocks: isEmptyPage ? createBentoStarterBlocks(templateKey) : initial.blocks,
        starterTemplate: isEmptyPage ? templateKey : undefined,
      };
      const generatedBlocks = getCanonicalBentoBlocks(source).map(block => {
        if (block.systemKey === 'profile') return { ...block, config: { ...block.config, title: title.trim(), bio: bio.trim(), avatarUrl: resolvedAvatarUrl || '', socials: socialLinks } };
        if (block.systemKey === 'socials_section') return { ...block, enabled: Object.keys(socialLinks).length > 0, config: { ...block.config, socials: socialLinks } };
        if (block.systemKey === 'links_section') return { ...block, enabled: links.some(link => link.enabled !== false), config: { ...block.config, links } };
        return block;
      });
      const next: HubConfig = {
        ...initial,
        onboardingComplete: true,
        theme,
        title: title.trim(),
        bio: bio.trim(),
        background: chosen.background,
        accent: chosen.accent,
        textColor: chosen.textColor,
        mutedTextColor: chosen.mutedTextColor,
        socialLinks,
        links,
        bentoDesign: nextDesign,
        blocks: generatedBlocks,
      };
      const response = await fetch('/api/studio/store', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ linkHubConfig: next, expectedUpdatedAt: store?.updated_at, ...(uploadedAvatarUrl ? { avatarUrl: uploadedAvatarUrl } : {}) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not create your link hub.');
      onDone({ ...next, ...(payload.data.link_hub_config || {}) }, payload.data);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create your link hub.'); }
    finally { setSaving(false); }
  }

  const previewAvatar = avatarPreviewUrl || avatarUrl || publicMediaUrl(store?.avatar_url);
  const previewSocials = selected.slice(0, 4).map(id => ({ id, label: allSocialFields.find(item => item[0] === id)?.[1] || getSocialPlatform(id).label, value: handles[id] || '' }));

  return <div className="link-hub-onboarding">
    <div className="onboarding-top"><span>TABLELY / LINK HUB</span><Link href="/studio">Skip for now</Link></div>
    <div className="onboarding-progress" aria-label={`Step ${step} of 4`}><i style={{ width: `${(step / 4) * 100}%` }}/></div>
    <div className="onboarding-shell">
      <div className="onboarding-content">
        <div className="eyebrow">STEP {step} OF 4</div>
        {step === 1 && <>
          <h1>Choose a look that feels like you.</h1>
          <p className="muted">Pick a starting visual direction. Every color, radius and detail stays editable in the Link Hub editor later.</p>
          <div className="onboarding-theme-grid">{themes.map(item => <button type="button" key={item.id} className={`onboarding-theme ${theme === item.id ? 'selected' : ''}`} onClick={() => { setTheme(item.id); setError(''); }}><span className={`theme-swatch theme-swatch-${item.id}`}><i/><i/><i/></span><b>{item.name}</b><small>{item.note}</small></button>)}</div>
          <div className="onboarding-section-title onboarding-section-title-with-action"><span>STARTER LAYOUT</span><span className="onboarding-step-note">{isEmptyPage ? 'Applies to this new page' : 'Existing layout will be preserved'}</span></div>
          <div className="onboarding-template-grid">{(Object.keys(BENTO_STARTER_TEMPLATES) as BentoStarterTemplateKey[]).map(key => { const Icon = STARTER_ICONS[key]; const item = BENTO_STARTER_TEMPLATES[key]; return <button type="button" key={key} className={`onboarding-template-card ${templateKey === key ? 'selected' : ''}`} onClick={() => setTemplateKey(key)} disabled={!isEmptyPage} aria-pressed={templateKey === key}><span className="onboarding-template-icon"><Icon size={17}/></span><b>{item.label}</b><small>{item.note}</small></button>; })}</div>
        </>}
        {step === 2 && <>
          <div className="onboarding-step-head"><div><h1>Where do people find you?</h1><p className="muted">Select the platforms you use. You can enter a username or full profile URL next.</p></div><span className="onboarding-count">{selected.length}/7 selected</span></div>
          <div className="onboarding-platform-grid">{visibleSocialFields.map(([id, label]) => <button type="button" key={id} className={`onboarding-platform ${selected.includes(id) ? 'selected' : ''}`} onClick={() => togglePlatform(id)}><SocialIcon platform={id} size="lg"/><b>{label}</b><small>{selected.includes(id) ? 'Selected' : 'Add platform'}</small>{selected.includes(id) && <span className="platform-selected-mark">✓</span>}</button>)}</div>
          {!showAllPlatforms && <button type="button" className="social-more-toggle" onClick={() => setShowAllPlatforms(true)}>Show all platforms <span>→</span></button>}
          {showAllPlatforms && <button type="button" className="social-more-toggle" onClick={() => setShowAllPlatforms(false)}>Show featured platforms <span>↑</span></button>}
        </>}
        {step === 3 && <>
          <h1>Add the links you want people to click.</h1>
          <p className="muted">Add your social profiles first, then optional custom links such as your portfolio, booking page, Discord or latest release.</p>
          <div className="onboarding-section-title">SOCIAL PROFILES</div>
          <div className="onboarding-link-fields">{selected.length ? selected.map(id => <label key={id}><span className="onboarding-link-label"><SocialIcon platform={id} size="sm"/><b>{allSocialFields.find(item => item[0] === id)?.[1] || getSocialPlatform(id).label}</b><small>{getSocialPlatform(id).placeholder}</small></span><input className="input" value={handles[id] || ''} onChange={event => { setHandles(current => ({ ...current, [id]: event.target.value })); setError(''); }} placeholder={getSocialPlatform(id).placeholder}/></label>) : <div className="info-note">No social platforms selected. You can still add custom links below.</div>}</div>
          <div className="onboarding-section-title onboarding-section-title-with-action"><span>CUSTOM LINKS</span><button type="button" className="btn btn-sm" onClick={addQuickLink} disabled={quickLinks.length >= 5}>+ Add link</button></div>
          <div className="onboarding-custom-links">{quickLinks.map(link => <div className="onboarding-custom-link" key={link.id}><div><label>Label<input className="input" value={link.label} onChange={event => updateQuickLink(link.id, { label: event.target.value })} placeholder="My portfolio" /></label><label>URL<input className="input" value={link.url} onChange={event => updateQuickLink(link.id, { url: event.target.value })} placeholder="https://example.com" /></label></div><button type="button" className="btn btn-sm" onClick={() => removeQuickLink(link.id)}>Remove</button></div>)}{!quickLinks.length && <div className="info-note">Optional. Add a few high-value destinations so your page is useful before you add products.</div>}</div>
        </>}
        {step === 4 && <>
          <h1>Make the profile yours.</h1>
          <p className="muted">Your photo, display name and bio become the hero card at the top of your Link Hub.</p>
          <div className="onboarding-profile">
            {profilePhotoPicker}
            {profileCropEditor}
            {previewAvatar && <div className="onboarding-photo-confirmation"><img src={previewAvatar} alt="Profile preview"/><span>Profile photo ready</span></div>}
            <label className="label">Display name</label>
            <input className="input" value={title} onChange={event => { setTitle(event.target.value); setError(''); }} placeholder={store.name || 'Your name'} maxLength={80}/>
            <label className="label">Bio</label>
            <textarea className="input" value={bio} onChange={event => setBio(event.target.value)} placeholder="Building things on the internet…" maxLength={240} style={{ minHeight: 110, paddingTop: 12 }}/>
          </div>
        </>}
        {error && <div className="error-box">{error}</div>}
        <div className="onboarding-actions">
          {step > 1 && <button className="btn" type="button" onClick={() => { setError(''); setStep(value => value - 1); }}>Back</button>}
          {step < 4 ? <button className="btn btn-primary" type="button" onClick={() => { setError(''); setStep(value => value + 1); }}>Continue</button> : <button className="btn btn-primary" type="button" onClick={() => void finish()} disabled={saving}>{saving ? 'Building your page…' : 'Build my page'}</button>}
        </div>
      </div>
      <aside className="onboarding-preview-card" style={{ background: selectedTheme.background, color: selectedTheme.textColor }}>
        <div className="onboarding-preview-head"><span>LIVE PREVIEW</span><b>STEP {step}</b></div>
        <div className="onboarding-preview-profile">
          <div className="onboarding-preview-avatar">{previewAvatar ? <img src={previewAvatar} alt=""/> : <span>{title.slice(0, 1).toUpperCase() || '✦'}</span>}</div>
          <div className="onboarding-preview-handle">@{String(store.username || 'your-handle')}</div>
          <h2>{title || 'Your name'}</h2>
          <p>{bio || 'Your corner of the internet.'}</p>
        </div>
        <div className="onboarding-preview-stack">
          <div className="onboarding-preview-store" style={{ background: selectedTheme.accent }}>Shop my store <span>↗</span></div>
          {previewSocials.map(item => <div className="onboarding-preview-link" key={item.id} style={{ background: selectedTheme.accent, color: selectedTheme.textColor }}><SocialIcon platform={item.id} size="sm"/><span>{item.label}{item.value ? ` · ${item.value.replace(/^https?:\/\//i, '').replace(/\/$/, '')}` : ''}</span><b>↗</b></div>)}
          {quickLinks.slice(0, 2).map(link => <div className="onboarding-preview-link" key={link.id} style={{ background: 'rgba(255,255,255,.68)' }}><span>{link.label || 'Custom link'}</span><b>↗</b></div>)}
          <div className="onboarding-preview-newsletter"><span>STAY IN THE LOOP</span><b>Useful stuff. No clutter.</b></div>
        </div>
        <small className="onboarding-preview-note"><b>{BENTO_STARTER_TEMPLATES[templateKey].label} starter</b> · This preview updates as you work. Your content stays saved when you switch between Default and Bento later.</small>
      </aside>
    </div>
  </div>;
}
