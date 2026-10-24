'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronRight, Copy,
  Eye, EyeOff, Grid2X2, GripVertical, Image as ImageIcon, Layers3, Link2, Lock, Maximize2, Monitor, Move,
  Palette, Play, Plus, Redo2, Search, Settings2, Smartphone, Tablet, Text, Trash2, Unlock, Video, Timer,
  Music2, Images, Quote, Megaphone, MousePointer2, Undo2, WandSparkles, X, Check, LayoutGrid, Sparkles,
} from 'lucide-react';
import type { CSSProperties, ComponentType, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { getBentoMusicProvider, isValidBentoMusicUrl, normalizeBentoMusicProvider } from '../lib/bento';
import type { BentoBlock, BentoBlockType, BentoGeometry, BentoPageDesign, BentoViewport } from '../lib/bento';
import {
  BENTO_TYPES, BENTO_VIEWPORT_COLUMNS, BENTO_GAP, BENTO_PAGE_DESIGN_DEFAULTS, getBentoRowHeight, arrangeBentoBlocks, getBentoGeometry,
  getBentoLayout, getBentoSpan, normalizeBentoSize, normalizeBentoPageDesign, packBentoBlocks, validateBentoLayout, withBentoGeometry, getBentoPageBackground, getBentoCardShadow, findBentoAvailableGeometry, replaceBentoBlockWithPush, isBentoGeometryEqual, scaleGeometryToViewport, getBentoEffectiveGridGap,
} from '../lib/bento';
import BentoBlockView from './BentoBlock';
import BentoPublicPreviewFrame from './BentoPublicPreviewFrame';
import { getSocialPlatform, SOCIAL_PLATFORMS, SocialIcon } from './SocialIcon';

const CUSTOM_TYPES = BENTO_TYPES.filter(item => !['profile', 'socials_section', 'featured', 'projects', 'store', 'newsletter', 'contact', 'links_section', 'branding_footer'].includes(item.type));

const COLOR_PRESETS = [
  { name: 'Violet', background: '#6D46FF', background2: '#9A72FF', textColor: '#FFFFFF' },
  { name: 'Coral', background: '#FF6B4A', background2: '#FF9675', textColor: '#FFFFFF' },
  { name: 'Sky', background: '#3B82F6', background2: '#60A5FA', textColor: '#FFFFFF' },
  { name: 'Lime', background: '#D9F21B', background2: '#9EDC63', textColor: '#171811' },
  { name: 'Pink', background: '#F3A6CD', background2: '#A990FF', textColor: '#171811' },
  { name: 'Ink', background: '#111827', background2: '#334155', textColor: '#FFFFFF' },
  { name: 'Cream', background: '#FFF8EE', background2: '#F2E5D5', textColor: '#171811' },
  { name: 'Red', background: '#FF234C', background2: '#FF5A6E', textColor: '#FFFFFF' },
];

const TYPE_ICONS: Record<BentoBlockType, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  profile: Sparkles, link: Link2, image: ImageIcon, youtube: Play, video: Video, countdown: Timer, rich_text: Text,
  social: MousePointer2, spotify: Music2, gallery: Images, quote: Quote, announcement: Megaphone, cta: WandSparkles,
  socials_section: Layers3, featured: Sparkles, projects: Grid2X2, store: LayoutGrid, newsletter: Text,
  contact: Link2, links_section: Layers3, branding_footer: Sparkles,
};

const DEFAULT_DESIGN = BENTO_PAGE_DESIGN_DEFAULTS satisfies BentoPageDesign;

const FONT_OPTIONS = [
  { id: 'modern', label: 'Modern' }, { id: 'editorial', label: 'Editorial' }, { id: 'mono', label: 'Tech mono' }, { id: 'clean', label: 'Clean' },
] as const;

const PAGE_PRESETS: Record<string, Partial<BentoPageDesign>> = {
  Minimal: { background: '#f7f7f4', accent: '#151515', cardRadius: 24, gridGap: 12, font: 'clean', motion: 'calm', texture: 'none', contentDensity: 'comfortable' },
  Aurora: { background: '#10111b', accent: '#8e74ff', cardRadius: 30, gridGap: 14, font: 'modern', motion: 'cinematic', texture: 'grain' },
  Candy: { background: '#ffd9e5', accent: '#e94c88', cardRadius: 34, gridGap: 10, font: 'modern', motion: 'expressive', texture: 'dots' },
  Mono: { background: '#0e0e10', accent: '#ffffff', cardRadius: 18, gridGap: 8, font: 'mono', motion: 'calm', texture: 'noise' },
  Editorial: { background: '#f5f1ea', accent: '#d7653f', cardRadius: 28, gridGap: 12, font: 'editorial', motion: 'calm', texture: 'grain' },
  Neo: { background: '#dfe6ff', accent: '#5b58ff', cardRadius: 36, gridGap: 16, font: 'modern', motion: 'expressive', texture: 'dots' },
  Glass: { background: '#e8ecf5', accent: '#6d46ff', cardRadius: 32, gridGap: 14, font: 'clean', motion: 'cinematic', texture: 'grain' },
  Cyber: { background: '#090b10', accent: '#00e7ff', cardRadius: 22, gridGap: 10, font: 'mono', motion: 'cinematic', texture: 'noise' },
  Pastel: { background: '#eef5ff', accent: '#7b68ee', cardRadius: 30, gridGap: 12, font: 'modern', motion: 'calm', texture: 'none' },
  Creator: { background: '#f4f0e8', accent: '#6d46ff', cardRadius: 30, gridGap: 12, font: 'modern', motion: 'expressive', texture: 'grain' },
};

const TEMPLATES: Record<string, { label: string; note: string; sizes: Array<[number, number]> }> = {
  creator: { label: 'Creator', note: 'Profile, work, video and audience', sizes: [[12, 5], [6, 4], [6, 4], [4, 4], [4, 3], [4, 3]] },
  developer: { label: 'Developer', note: 'Projects, GitHub, writing and contact', sizes: [[12, 4], [8, 4], [4, 4], [4, 3], [8, 3], [4, 3]] },
  musician: { label: 'Musician', note: 'Music, releases, shows and audience', sizes: [[12, 4], [6, 5], [6, 5], [8, 3], [4, 3], [12, 3]] },
  artist: { label: 'Artist', note: 'Gallery-led portfolio and visual work', sizes: [[12, 5], [8, 5], [4, 5], [6, 4], [6, 4], [12, 3]] },
  educator: { label: 'Educator', note: 'Lessons, resources, writing and community', sizes: [[12, 4], [6, 4], [6, 4], [4, 4], [8, 3], [12, 3]] },
  business: { label: 'Business', note: 'Offer, proof, conversion and contact', sizes: [[12, 4], [8, 4], [4, 4], [6, 3], [6, 3], [12, 3]] },
  designer: { label: 'Designer', note: 'Editorial portfolio composition', sizes: [[12, 4], [7, 5], [5, 5], [4, 4], [8, 3], [4, 3]] },
  student: { label: 'Student', note: 'Projects, resume and social identity', sizes: [[12, 4], [6, 4], [6, 4], [4, 4], [8, 3], [4, 3]] },
};

type ResizeDirection = 'nw' | 'ne' | 'sw' | 'se';
type Tab = 'content' | 'layout' | 'style' | 'animation' | 'responsive' | 'advanced';

type EditorSnapshot = { blocks: BentoBlock[]; design: BentoPageDesign };

function cloneBlocks(items: BentoBlock[]): BentoBlock[] {
  return items.map(block => ({
    ...block,
    geometry: block.geometry ? JSON.parse(JSON.stringify(block.geometry)) : undefined,
    config: block.config ? JSON.parse(JSON.stringify(block.config)) : {},
  }));
}

function cloneDesign(value: BentoPageDesign): BentoPageDesign {
  return { ...value };
}


function makeId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `block-${crypto.randomUUID()}`;
  } catch {}
  return `block-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function defaultVisual(type: BentoBlockType, index = 0): Record<string, unknown> {
  const preset = COLOR_PRESETS[(index * 3 + type.length) % COLOR_PRESETS.length];
  return { background: preset.background, background2: preset.background2, textColor: preset.textColor, gradient: true, backgroundType: 'gradient', radius: 28, animation: 'lift', shadow: 'soft', align: 'left', opacity: 1, blur: 0, border: 'none', borderColor: '#ffffff', borderWidth: 1 };
}

function defaultConfig(type: BentoBlockType, index = 0): Record<string, unknown> {
  const visual = defaultVisual(type, index);
  switch (type) {
    case 'link': return { label: 'New link', description: '', url: '', ...visual };
    case 'image': return { imageUrl: '', alt: '', linkUrl: '', objectFit: 'cover', focalX: 50, focalY: 50, ...visual };
    case 'youtube': return { url: '', title: 'Watch on YouTube', ...visual };
    case 'video': return { videoUrl: '', posterUrl: '', ...visual };
    case 'countdown': return { title: 'Coming soon', target: '', expiredText: 'This offer has ended.', kicker: 'COMING SOON', ...visual };
    case 'rich_text': return { title: 'A note for your audience', body: 'Share a useful update here.', kicker: 'NOTE', ...visual };
    case 'social': return { platform: 'instagram', label: 'Instagram', handle: '@you', url: '', ...visual };
    case 'spotify': return { provider: 'spotify', title: 'Listen now', subtitle: 'Open in Spotify', url: '', ...visual };
    case 'gallery': return { imageUrls: '', ...visual };
    case 'quote': return { body: 'A memorable thought belongs in the layout.', author: 'Your name', ...visual };
    case 'announcement': return { kicker: 'UPDATE', title: 'Something new is here', body: 'Share an important update with your audience.', ...visual };
    case 'cta': return { kicker: 'ACTION', title: 'Do something memorable.', body: 'A high-impact card designed to earn the click.', url: '', ...visual };
    case 'profile': return { system: true, ...visual };
    case 'socials_section': return { system: true, title: 'Find me online', ...visual };
    case 'featured': return { system: true, ...visual };
    case 'projects': return { system: true, title: 'Projects', ...visual };
    case 'store': return { system: true, title: 'My store', ...visual };
    case 'newsletter': return { system: true, title: 'Useful stuff. No clutter.', ...visual };
    case 'contact': return { system: true, ...visual };
    case 'links_section': return { system: true, title: 'More links', ...visual };
    case 'branding_footer': return { system: true, ...visual };
  }
}

function makeBlock(type: BentoBlockType, index = 0): BentoBlock {
  return {
    id: makeId(), type, size: type === 'rich_text' || type === 'cta' ? '2x1' : '1x1', enabled: true,
    startAt: null, endAt: null, position: null, config: defaultConfig(type, index), locked: false,
    lockPosition: false, lockSize: false, lockStyle: false,
  };
}

function labelForBlock(block: BentoBlock) {
  return String(block.config?.label || block.config?.title || block.config?.author || BENTO_TYPES.find(item => item.type === block.type)?.label || 'Widget');
}

function getDeviceLabel(viewport: BentoViewport) { return viewport === 'desktop' ? 'Desktop' : viewport === 'tablet' ? 'Tablet' : 'Mobile'; }

function InspectorField({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="bento-inspector-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function ColorSwatches({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className="bento-color-swatches">{COLOR_PRESETS.map(preset => <button key={preset.name} type="button" title={preset.name} aria-label={`Use ${preset.name}`} className="bento-color-swatch" style={{ background: `linear-gradient(135deg,${preset.background},${preset.background2})` }} onClick={() => { onChange(preset.background); }} />)}<input type="color" value={value.startsWith('#') ? value : '#6d46ff'} onChange={event => onChange(event.target.value)} aria-label="Custom color" /></div>;
}


function PageInspector({ design, onUpdate, onClose }: {
  design: BentoPageDesign;
  onUpdate: (patch: Partial<BentoPageDesign>) => void;
  onClose: () => void;
}) {
  const pageWidth = design.pageWidth || 'balanced';
  const density = design.contentDensity || 'comfortable';
  return <aside className="bento-inspector bento-page-inspector">
    <div className="bento-inspector-head"><div><span className="bento-inspector-kicker">PAGE</span><h3>Global Bento design</h3></div><button type="button" className="bento-icon-button" onClick={onClose} aria-label="Close page inspector"><X size={17}/></button></div>
    <div className="bento-inspector-scroll">
          <section className="bento-setting-section">
            <div className="bento-setting-title">Canvas</div>
        <InspectorField label="Background"><input type="color" value={design.background || '#f4f0e8'} onChange={e => onUpdate({ background: e.target.value })}/></InspectorField>
        <InspectorField label="Background type"><select className="bento-input" value={design.backgroundType || 'solid'} onChange={e => onUpdate({ backgroundType: e.target.value as BentoPageDesign['backgroundType'] })}><option value="solid">Solid</option><option value="gradient">Gradient</option><option value="mesh">Mesh</option><option value="aurora">Aurora</option></select></InspectorField>
        <InspectorField label="Secondary background"><input type="color" value={design.background2 || '#ffffff'} onChange={e => onUpdate({ background2: e.target.value })}/></InspectorField>
        <div className="bento-four-grid">
          <InspectorField label="Page width"><select className="bento-input" value={pageWidth} onChange={e => onUpdate({ pageWidth: e.target.value as BentoPageDesign['pageWidth'] })}><option value="compact">Compact</option><option value="balanced">Balanced</option><option value="wide">Wide</option></select></InspectorField>
          <InspectorField label="Alignment"><select className="bento-input" value={design.pageAlignment || 'center'} onChange={e => onUpdate({ pageAlignment: e.target.value as BentoPageDesign['pageAlignment'] })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></InspectorField>
          <InspectorField label="Grid gap"><input className="bento-input" type="number" min={0} max={40} value={Number.isFinite(Number(design.gridGap)) ? Number(design.gridGap) : 12} onChange={e => onUpdate({ gridGap: Math.min(40, Math.max(0, Number(e.target.value) || 0)) })}/></InspectorField>
          <InspectorField label="Card radius"><input className="bento-input" type="number" min={8} max={64} value={Number(design.cardRadius || 28)} onChange={e => onUpdate({ cardRadius: Math.min(64, Math.max(8, Number(e.target.value) || 8)) })}/></InspectorField>
        </div>
      </section>
      <section className="bento-setting-section">
        <div className="bento-setting-title">Typography & color</div>
        <InspectorField label="Font"><select className="bento-input" value={design.font || 'modern'} onChange={e => onUpdate({ font: e.target.value as BentoPageDesign['font'] })}><option value="modern">Modern</option><option value="editorial">Editorial</option><option value="mono">Tech mono</option><option value="clean">Clean</option></select></InspectorField>
        <div className="bento-four-grid">
          <InspectorField label="Text"><input type="color" value={design.textColor || '#171811'} onChange={e => onUpdate({ textColor: e.target.value })}/></InspectorField>
          <InspectorField label="Muted text"><input type="color" value={design.mutedTextColor || '#68695e'} onChange={e => onUpdate({ mutedTextColor: e.target.value })}/></InspectorField>
          <InspectorField label="Accent"><input type="color" value={design.accent || '#6d46ff'} onChange={e => onUpdate({ accent: e.target.value })}/></InspectorField>
          <InspectorField label="Density"><select className="bento-input" value={density} onChange={e => onUpdate({ contentDensity: e.target.value as BentoPageDesign['contentDensity'] })}><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option></select></InspectorField>
        </div>
        <InspectorField label="Button style"><select className="bento-input" value={design.buttonStyle || 'solid'} onChange={e => onUpdate({ buttonStyle: e.target.value as BentoPageDesign['buttonStyle'] })}><option value="solid">Solid</option><option value="soft">Soft</option><option value="outline">Outline</option></select></InspectorField>
        <InspectorField label="Card shadow"><select className="bento-input" value={design.cardShadow || 'soft'} onChange={e => onUpdate({ cardShadow: e.target.value as BentoPageDesign['cardShadow'] })}><option value="none">None</option><option value="soft">Soft</option><option value="deep">Deep</option><option value="glow">Glow</option></select></InspectorField>
      </section>
      <section className="bento-setting-section">
        <div className="bento-setting-title">Motion & responsive</div>
        <InspectorField label="Motion"><select className="bento-input" value={design.motion || 'expressive'} onChange={e => onUpdate({ motion: e.target.value as BentoPageDesign['motion'] })}><option value="calm">Calm</option><option value="expressive">Expressive</option><option value="cinematic">Cinematic</option></select></InspectorField>
        <InspectorField label="Animation intensity"><input type="range" min={0} max={100} value={Number(design.animationIntensity ?? 70)} onChange={e => onUpdate({ animationIntensity: Number(e.target.value) })}/></InspectorField>
        <InspectorField label="Cursor FX"><select className="bento-input" value={design.cursorFx || 'spotlight'} onChange={e => onUpdate({ cursorFx: e.target.value as BentoPageDesign['cursorFx'] })}><option value="none">None</option><option value="spotlight">Spotlight</option><option value="magnetic">Magnetic</option></select></InspectorField>
        <InspectorField label="Mobile mode"><select className="bento-input" value={design.mobileMode || 'smart'} onChange={e => onUpdate({ mobileMode: e.target.value as BentoPageDesign['mobileMode'] })}><option value="smart">Smart repair</option><option value="custom">Saved geometry only</option></select></InspectorField>
        <InspectorField label="Texture"><select className="bento-input" value={design.texture || 'grain'} onChange={e => onUpdate({ texture: e.target.value as BentoPageDesign['texture'] })}><option value="none">None</option><option value="noise">Noise</option><option value="grain">Grain</option><option value="dots">Dots</option></select></InspectorField>
        <div className="bento-four-grid"><label className="bento-design-check"><input type="checkbox" checked={design.spotlight !== false} onChange={e => onUpdate({ spotlight: e.target.checked })}/><span>Spotlight</span></label><label className="bento-design-check"><input type="checkbox" checked={design.noise !== false} onChange={e => onUpdate({ noise: e.target.checked })}/><span>Noise</span></label></div>
      </section>
      <section className="bento-setting-section"><div className="bento-setting-title">Quick presets</div><div className="bento-preset-grid">{Object.entries(PAGE_PRESETS).map(([name, patch]) => <button type="button" key={name} className="bento-action-row" onClick={() => onUpdate(patch)}>{name}<ChevronRight size={13}/></button>)}</div></section>
    </div>
  </aside>;
}

function BlockInspector({ block, viewport, currentBlocks, onUpdate, onDuplicate, onDelete, onClose, onUploadMedia, profileMediaEditor, linksEditor, globalCardRadius }: {
  block: BentoBlock;
  viewport: BentoViewport;
  currentBlocks: BentoBlock[];
  onUpdate: (patch: Partial<BentoBlock>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
  onUploadMedia?: (file: File) => Promise<string | null>;
  profileMediaEditor?: ReactNode;
  linksEditor?: ReactNode;
  globalCardRadius?: number;
}) {
  const [tab, setTab] = useState<Tab>('content');
  const [uploadingImage, setUploadingImage] = useState(false);
  const config = block.config || {};
  const currentBlocksRef = { current: currentBlocks };
  const geometry = getBentoGeometry(block, viewport);
  const str = (key: string, fallback = '') => String(config[key] ?? fallback);
  const num = (key: string, fallback: number) => { const value = Number(config[key]); return Number.isFinite(value) ? value : fallback; };
  const setConfig = (key: string, value: unknown) => onUpdate({ config: { ...config, [key]: value } });
  const setGeometry = (patch: Partial<BentoGeometry>) => {
    const columns = BENTO_VIEWPORT_COLUMNS[viewport];
    const proposed: BentoGeometry = {
      ...geometry,
      ...patch,
      column: Math.max(1, Math.min(columns, Number(patch.column ?? geometry.column) || 1)),
      row: Math.max(1, Math.min(4096, Number(patch.row ?? geometry.row) || 1)),
      columnSpan: Math.max(1, Math.min(columns, Number(patch.columnSpan ?? geometry.columnSpan) || 1)),
      rowSpan: Math.max(1, Math.min(64, Number(patch.rowSpan ?? geometry.rowSpan) || 1)),
    };
    proposed.column = Math.min(proposed.column, Math.max(1, columns - proposed.columnSpan + 1));
    const placed = findBentoAvailableGeometry(currentBlocks, proposed, viewport, block.id);
    onUpdate({ geometry: { ...(block.geometry || {}), [viewport]: placed } });
  };
  const socialConfig = config.socials && typeof config.socials === 'object' ? config.socials as Record<string, unknown> : {};
  const socialEntries = Object.entries(socialConfig).filter(([key]) => SOCIAL_PLATFORMS.some(item => item.id === key));
  const socialOptions = SOCIAL_PLATFORMS.filter(item => !Object.prototype.hasOwnProperty.call(socialConfig, item.id));
  const projects = Array.isArray(config.projects) ? config.projects.filter(item => item && typeof item === 'object') as Record<string, unknown>[] : [];
  const getDisplayLimitValue = (fallback: number) => config.displayLimit === 'all' ? 'all' : String(Math.max(1, Number(config.displayLimit ?? fallback) || fallback));
  const setProject = (index: number, patch: Record<string, unknown>) => {
    const next = projects.map((item, i) => i === index ? { ...item, ...patch } : item);
    setConfig('projects', next);
  };
  const removeProject = (index: number) => setConfig('projects', projects.filter((_, i) => i !== index));
  const addProject = () => setConfig('projects', [...projects, { id: `project-${Date.now()}`, name: 'New project', description: '', url: '', image: '' }]);

  return <aside className="bento-inspector">
    <div className="bento-inspector-head"><div><span className="bento-inspector-kicker">{block.systemKey ? 'SYSTEM NODE' : 'WIDGET'}</span><h3>{labelForBlock(block)}</h3></div><button type="button" className="bento-icon-button" onClick={onClose} aria-label="Close inspector"><X size={17}/></button></div>
    <div className="bento-inspector-tabs">{(['content','layout','style','animation','responsive','advanced'] as Tab[]).map(item => <button type="button" key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
    <div className="bento-inspector-scroll">
      {tab === 'content' && <section className="bento-setting-section">
        <div className="bento-setting-title">Content</div>
        {block.type === 'profile' && <>
          {profileMediaEditor && <div className="bento-node-editor-slot"><div className="bento-node-editor-slot-title">Profile media</div>{profileMediaEditor}</div>}
          <InspectorField label="Display name"><input className="bento-input" value={str('title')} onChange={e => setConfig('title', e.target.value)} maxLength={80}/></InspectorField>
          <InspectorField label="Bio"><textarea className="bento-input" value={str('bio')} onChange={e => setConfig('bio', e.target.value)} maxLength={240}/></InspectorField>
          <InspectorField label="Location"><input className="bento-input" value={str('location')} onChange={e => setConfig('location', e.target.value)}/></InspectorField>
          <InspectorField label="Availability"><input className="bento-input" value={str('availability')} onChange={e => setConfig('availability', e.target.value)}/></InspectorField>
          <div className="bento-help">Verified status is controlled by TABLELY verification. It cannot be manually enabled from the page editor.</div>
        </>}
        {block.type === 'link' && <><InspectorField label="Title"><input className="bento-input" value={str('label', 'New link')} onChange={e => setConfig('label', e.target.value)} maxLength={80}/></InspectorField><InspectorField label="Description"><input className="bento-input" value={str('description')} onChange={e => setConfig('description', e.target.value)} maxLength={120}/></InspectorField><InspectorField label="Destination"><input className="bento-input" value={str('url')} onChange={e => setConfig('url', e.target.value)} placeholder="https://…"/></InspectorField></>}
        {block.type === 'image' && <><InspectorField label="Upload image" hint={uploadingImage ? 'Uploading…' : 'JPG, PNG, WebP or GIF'}><input className="bento-input" type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={uploadingImage || !onUploadMedia} onChange={async e => { const input = e.currentTarget as HTMLInputElement | null; const file = input?.files?.[0]; if (!file || !onUploadMedia) return; setUploadingImage(true); try { const url = await onUploadMedia(file); if (url) setConfig('imageUrl', url); } finally { setUploadingImage(false); if (input) input.value = ''; } }}/></InspectorField><InspectorField label="Image URL"><input className="bento-input" value={str('imageUrl')} onChange={e => setConfig('imageUrl', e.target.value)} placeholder="https://…"/></InspectorField><InspectorField label="Alt text"><input className="bento-input" value={str('alt')} onChange={e => setConfig('alt', e.target.value)}/></InspectorField><InspectorField label="Image link"><input className="bento-input" value={str('linkUrl')} onChange={e => setConfig('linkUrl', e.target.value)} placeholder="Optional destination"/></InspectorField><InspectorField label="Image fit"><div className="bento-pill-select"><button type="button" className={str('objectFit','cover') === 'cover' ? 'active' : ''} onClick={() => setConfig('objectFit','cover')}>Cover</button><button type="button" className={str('objectFit') === 'contain' ? 'active' : ''} onClick={() => setConfig('objectFit','contain')}>Contain</button></div></InspectorField><InspectorField label="Focal point"><div className="bento-focal-picker" style={{ backgroundImage: str('imageUrl') ? `url(${str('imageUrl')})` : undefined }} onPointerDown={event => { const rect = event.currentTarget.getBoundingClientRect(); setConfig('focalX', Math.round(((event.clientX - rect.left) / rect.width) * 100)); setConfig('focalY', Math.round(((event.clientY - rect.top) / rect.height) * 100)); }}><span className="bento-focal-dot" style={{ left: `${num('focalX',50)}%`, top: `${num('focalY',50)}%` }}/></div><small className="bento-help">Click or drag the focus point to choose what stays visible when the card crops.</small></InspectorField></>}
        {block.type === 'youtube' && <><InspectorField label="YouTube URL"><input className="bento-input" value={str('url')} onChange={e => setConfig('url', e.target.value)} placeholder="https://youtube.com/watch?v=…"/></InspectorField><InspectorField label="Title"><input className="bento-input" value={str('title','Watch on YouTube')} onChange={e => setConfig('title', e.target.value)}/></InspectorField></>}
        {block.type === 'video' && <><InspectorField label="Video URL"><input className="bento-input" value={str('videoUrl')} onChange={e => setConfig('videoUrl', e.target.value)} placeholder="https://…/video.mp4"/></InspectorField><InspectorField label="Poster URL"><input className="bento-input" value={str('posterUrl')} onChange={e => setConfig('posterUrl', e.target.value)} placeholder="https://…"/></InspectorField></>}
        {block.type === 'countdown' && <><InspectorField label="Kicker"><input className="bento-input" value={str('kicker','COMING SOON')} onChange={e => setConfig('kicker',e.target.value)}/></InspectorField><InspectorField label="Title"><input className="bento-input" value={str('title','Coming soon')} onChange={e => setConfig('title',e.target.value)}/></InspectorField><InspectorField label="Target"><input className="bento-input" type="datetime-local" value={str('target').slice(0,16)} onChange={e=>setConfig('target', e.target.value ? new Date(e.target.value).toISOString() : '')}/></InspectorField></>}
        {['rich_text','announcement','cta'].includes(block.type) && <><InspectorField label="Kicker"><input className="bento-input" value={str('kicker')} onChange={e => setConfig('kicker', e.target.value)}/></InspectorField><InspectorField label="Title"><input className="bento-input" value={str('title')} onChange={e => setConfig('title', e.target.value)}/></InspectorField><InspectorField label="Body"><textarea className="bento-input" value={str('body')} onChange={e => setConfig('body', e.target.value)}/></InspectorField>{block.type === 'cta' && <InspectorField label="Destination"><input className="bento-input" value={str('url')} onChange={e => setConfig('url', e.target.value)}/></InspectorField>}</>}
        {block.type === 'social' && <><InspectorField label="Platform"><input className="bento-input" value={str('platform','instagram')} onChange={e => setConfig('platform', e.target.value)}/></InspectorField><InspectorField label="Label"><input className="bento-input" value={str('label','Instagram')} onChange={e => setConfig('label', e.target.value)}/></InspectorField><InspectorField label="Handle"><input className="bento-input" value={str('handle','@you')} onChange={e => setConfig('handle', e.target.value)}/></InspectorField><InspectorField label="URL"><input className="bento-input" value={str('url')} onChange={e => setConfig('url', e.target.value)}/></InspectorField></>}
        {block.type === 'spotify' && <><InspectorField label="Music provider"><select className="bento-input" value={normalizeBentoMusicProvider(config.provider)} onChange={e => { const provider = normalizeBentoMusicProvider(e.target.value); onUpdate({ config: { ...config, provider, subtitle: getBentoMusicProvider(provider).openLabel } }); }}><option value="spotify">Spotify</option><option value="youtube_music">YouTube Music</option><option value="apple_music">Apple Music</option></select></InspectorField><InspectorField label="Title"><input className="bento-input" value={str('title','Listen now')} onChange={e => setConfig('title', e.target.value)}/></InspectorField><InspectorField label="Subtitle"><input className="bento-input" value={str('subtitle', getBentoMusicProvider(config.provider).openLabel)} onChange={e => setConfig('subtitle', e.target.value)}/></InspectorField><InspectorField label={`${getBentoMusicProvider(config.provider).label} URL`} hint="Supported provider URLs only"><input className="bento-input" value={str('url')} onChange={e => setConfig('url', e.target.value)} placeholder={getBentoMusicProvider(config.provider).label === 'Spotify' ? 'https://open.spotify.com/…' : getBentoMusicProvider(config.provider).label === 'YouTube Music' ? 'https://music.youtube.com/…' : 'https://music.apple.com/…'}/></InspectorField>{!isValidBentoMusicUrl(config.provider, config.url) && <div className="bento-help bento-error-text">{String(config.url || '').trim() ? `Use a valid ${getBentoMusicProvider(config.provider).label} URL.` : `${getBentoMusicProvider(config.provider).label} URL is required.`}</div>}</>}
        {block.type === 'gallery' && <InspectorField label="Image URLs" hint="Comma or newline separated"><textarea className="bento-input" value={str('imageUrls')} onChange={e => setConfig('imageUrls', e.target.value)}/></InspectorField>}
        {block.type === 'quote' && <><InspectorField label="Quote"><textarea className="bento-input" value={str('body')} onChange={e => setConfig('body', e.target.value)}/></InspectorField><InspectorField label="Author"><input className="bento-input" value={str('author')} onChange={e => setConfig('author', e.target.value)}/></InspectorField></>}
        {block.type === 'socials_section' && <>
          <InspectorField label="Section title"><input className="bento-input" value={str('title','Find me online')} onChange={e => setConfig('title', e.target.value)}/></InspectorField>
          {socialEntries.map(([key, value]) => <div key={key} className="bento-social-inspector-row"><SocialIcon platform={key} size="sm"/><input className="bento-input" value={String(value || '')} onChange={e => setConfig('socials', { ...socialConfig, [key]: e.target.value })} placeholder={getSocialPlatform(key).placeholder}/><button type="button" className="bento-mini-button danger" onClick={() => { const next = { ...socialConfig }; delete next[key]; setConfig('socials', next); }}>×</button></div>)}
          {socialOptions.length > 0 && <InspectorField label="Add social"><select className="bento-input" value="" onChange={e => { const key=e.target.value; if (!key) return; setConfig('socials', { ...socialConfig, [key]: '' }); }}><option value="">Choose a platform…</option>{socialOptions.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></InspectorField>}
        </>}
        {block.type === 'featured' && <><InspectorField label="Title"><input className="bento-input" value={str('title','Featured project')} onChange={e => setConfig('title', e.target.value)}/></InspectorField><InspectorField label="Description"><textarea className="bento-input" value={str('description')} onChange={e => setConfig('description', e.target.value)}/></InspectorField><InspectorField label="Destination"><input className="bento-input" value={str('url')} onChange={e => setConfig('url', e.target.value)} placeholder="https://…"/></InspectorField><InspectorField label="Hero image"><input className="bento-input" value={str('image')} onChange={e => setConfig('image', e.target.value)} placeholder="https://…"/></InspectorField></>}
        {block.type === 'projects' && <>
          <InspectorField label="Section title"><input className="bento-input" value={str('title','Projects')} onChange={e => setConfig('title', e.target.value)}/></InspectorField>
          <InspectorField label="Display count"><select className="bento-input" value={getDisplayLimitValue(8)} onChange={e => setConfig('displayLimit', e.target.value === 'all' ? 'all' : Number(e.target.value))}><option value="3">3</option><option value="6">6</option><option value="8">8</option><option value="12">12</option><option value="all">All</option></select></InspectorField>
          <div className="bento-node-list">{projects.map((project, index) => <div className="bento-node-list-row" key={String(project.id || index)}><b>Project {index + 1}</b><input className="bento-input" value={String(project.name || '')} onChange={e => setProject(index,{name:e.target.value})} placeholder="Project name"/><input className="bento-input" value={String(project.description || '')} onChange={e => setProject(index,{description:e.target.value})} placeholder="Description"/><input className="bento-input" value={String(project.url || '')} onChange={e => setProject(index,{url:e.target.value})} placeholder="https://…"/><input className="bento-input" value={String(project.image || '')} onChange={e => setProject(index,{image:e.target.value})} placeholder="Image URL"/><button type="button" className="bento-action-row danger" onClick={() => removeProject(index)}><Trash2 size={13}/> Remove</button></div>)}<button type="button" className="bento-action-row" onClick={addProject}><Plus size={13}/> Add project</button></div>
        </>}
        {block.type === 'store' && <><InspectorField label="Section title"><input className="bento-input" value={str('title','My store')} onChange={e => setConfig('title', e.target.value)}/></InspectorField><InspectorField label="Description"><textarea className="bento-input" value={str('description')} onChange={e => setConfig('description', e.target.value)}/></InspectorField><InspectorField label="Display count"><select className="bento-input" value={getDisplayLimitValue(4)} onChange={e => setConfig('displayLimit', e.target.value === 'all' ? 'all' : Number(e.target.value))}><option value="2">2</option><option value="4">4</option><option value="6">6</option><option value="8">8</option><option value="12">12</option><option value="all">All</option></select></InspectorField></>}
        {block.type === 'newsletter' && <><InspectorField label="Title"><input className="bento-input" value={str('title','Useful stuff. No clutter.')} onChange={e => setConfig('title', e.target.value)}/></InspectorField><InspectorField label="Description"><textarea className="bento-input" value={str('description')} onChange={e => setConfig('description', e.target.value)}/></InspectorField><label className="bento-toggle-row"><input type="checkbox" checked={config.enabled !== false} onChange={e => onUpdate({ enabled: e.target.checked, config: { ...config, enabled: e.target.checked } })}/><span>Collect newsletter subscribers</span></label></>}
        {block.type === 'contact' && <><InspectorField label="Contact headline"><input className="bento-input" value={str('contactTitle','Let’s build something.')} onChange={e => setConfig('contactTitle', e.target.value)}/></InspectorField><InspectorField label="Description"><textarea className="bento-input" value={str('description')} onChange={e => setConfig('description', e.target.value)}/></InspectorField><InspectorField label="Email"><input className="bento-input" value={str('contactEmail')} onChange={e => setConfig('contactEmail', e.target.value)}/></InspectorField><InspectorField label="WhatsApp"><input className="bento-input" value={str('whatsapp')} onChange={e => setConfig('whatsapp', e.target.value)}/></InspectorField></>}
        {block.type === 'links_section' && <><InspectorField label="Section title"><input className="bento-input" value={str('title','More links')} onChange={e => setConfig('title', e.target.value)}/></InspectorField><InspectorField label="Display count"><select className="bento-input" value={getDisplayLimitValue(10)} onChange={e => setConfig('displayLimit', e.target.value === 'all' ? 'all' : Number(e.target.value))}><option value="3">3</option><option value="6">6</option><option value="10">10</option><option value="20">20</option><option value="all">All</option></select></InspectorField>{linksEditor && <div className="bento-node-editor-slot"><div className="bento-node-editor-slot-title">Link management</div>{linksEditor}</div>}</>}
        {block.type === 'branding_footer' && <InspectorField label="Footer text"><input className="bento-input" value={str('label','Made with TABLELY')} onChange={e => setConfig('label', e.target.value)}/></InspectorField>}
      </section>}

      {tab === 'layout' && <section className="bento-setting-section"><div className="bento-setting-title">Geometry · {getDeviceLabel(viewport)}</div><p className="bento-help">Use the canvas handles for direct manipulation or set exact grid values here.</p><div className="bento-four-grid"><InspectorField label="Column"><input className="bento-input" type="number" min={1} max={BENTO_VIEWPORT_COLUMNS[viewport]} value={geometry.column} onChange={e => setGeometry({ column: Number(e.target.value) })}/></InspectorField><InspectorField label="Row"><input className="bento-input" type="number" min={1} value={geometry.row} onChange={e => setGeometry({ row: Number(e.target.value) })}/></InspectorField><InspectorField label="Width"><input className="bento-input" type="number" min={1} max={BENTO_VIEWPORT_COLUMNS[viewport]} value={geometry.columnSpan} onChange={e => setGeometry({ columnSpan: Number(e.target.value) })}/></InspectorField><InspectorField label="Height"><input className="bento-input" type="number" min={1} max={64} value={geometry.rowSpan} onChange={e => setGeometry({ rowSpan: Number(e.target.value) })}/></InspectorField></div><div className="bento-pill-select"><button type="button" className={block.lockPosition ? 'active' : ''} onClick={() => onUpdate({ lockPosition: !block.lockPosition })}><Move size={12}/> Lock position</button><button type="button" className={block.lockSize ? 'active' : ''} onClick={() => onUpdate({ lockSize: !block.lockSize })}><Maximize2 size={12}/> Lock size</button></div><label className="bento-toggle-row"><input type="checkbox" checked={block.locked === true} onChange={e => onUpdate({ locked: e.target.checked })}/><span>Lock entire node</span></label></section>}

      {tab === 'style' && <section className="bento-setting-section"><div className="bento-setting-title">Visual system</div><InspectorField label="Background"><ColorSwatches value={str('background','#6d46ff')} onChange={value => setConfig('background', value)}/></InspectorField><div className="bento-four-grid"><InspectorField label="Secondary"><input type="color" value={str('background2','#9a72ff')} onChange={e => setConfig('background2', e.target.value)}/></InspectorField><InspectorField label="Text"><input type="color" value={str('textColor','#ffffff')} onChange={e => setConfig('textColor', e.target.value)}/></InspectorField><InspectorField label="Radius"><input type="range" min="8" max="64" value={num('radius',28)} disabled={config.useGlobalRadius !== false} onChange={e => setConfig('radius', Number(e.target.value))}/></InspectorField><label className="bento-toggle-row"><input type="checkbox" checked={config.useGlobalRadius !== false} onChange={e => setConfig('useGlobalRadius', e.target.checked)}/><span>Use global card radius{globalCardRadius ? ` (${globalCardRadius}px)` : ''}</span></label><InspectorField label="Opacity"><input type="range" min="0.35" max="1" step="0.01" value={num('opacity',1)} onChange={e => setConfig('opacity', Number(e.target.value))}/></InspectorField></div><InspectorField label="Background treatment"><select className="bento-input" value={str('backgroundType','gradient')} onChange={e => setConfig('backgroundType', e.target.value)}><option value="solid">Solid</option><option value="gradient">Gradient</option><option value="mesh">Mesh</option><option value="aurora">Aurora</option><option value="glass">Glass</option><option value="image">Image</option></select></InspectorField>{str('backgroundType','gradient') === 'image' && <InspectorField label="Background image"><input className="bento-input" value={str('backgroundImage')} onChange={e => setConfig('backgroundImage', e.target.value)} placeholder="https://…"/></InspectorField>}<InspectorField label="Blur"><input type="range" min="0" max="28" value={num('blur',0)} onChange={e => setConfig('blur', Number(e.target.value))}/></InspectorField><InspectorField label="Shadow"><select className="bento-input" value={str('shadow','soft')} onChange={e => setConfig('shadow', e.target.value)}><option value="none">None</option><option value="soft">Soft</option><option value="deep">Deep</option><option value="glow">Glow</option></select></InspectorField><InspectorField label="Border"><select className="bento-input" value={str('border','none')} onChange={e => setConfig('border', e.target.value)}><option value="none">None</option><option value="subtle">Subtle</option><option value="solid">Solid</option><option value="gradient">Gradient</option></select></InspectorField>{str('border','none') !== 'none' && <div className="bento-four-grid"><InspectorField label="Border color"><input type="color" value={str('borderColor','#ffffff')} onChange={e => setConfig('borderColor', e.target.value)}/></InspectorField><InspectorField label="Width"><input className="bento-input" type="number" min="1" max="5" value={num('borderWidth',1)} onChange={e => setConfig('borderWidth', Number(e.target.value))}/></InspectorField></div>}<InspectorField label="Alignment"><div className="bento-pill-select"><button type="button" className={str('align','left')==='left'?'active':''} onClick={()=>setConfig('align','left')}><AlignLeft size={13}/></button><button type="button" className={str('align')==='center'?'active':''} onClick={()=>setConfig('align','center')}><AlignCenter size={13}/></button><button type="button" className={str('align')==='right'?'active':''} onClick={()=>setConfig('align','right')}><AlignRight size={13}/></button></div></InspectorField><section className="bento-inspector-subsection"><div className="bento-setting-subtitle">Typography</div><div className="bento-four-grid"><InspectorField label="Font family"><select className="bento-input" value={str('fontFamily')} onChange={e => setConfig('fontFamily', e.target.value)}><option value="">Inherit page font</option><option value="system-ui, sans-serif">System</option><option value="Georgia, serif">Editorial serif</option><option value="ui-monospace, SFMono-Regular, Menlo, monospace">Mono</option></select></InspectorField><InspectorField label="Base size"><input className="bento-input" type="number" min={8} max={48} value={num('fontSize',14)} onChange={e => setConfig('fontSize', Number(e.target.value))}/></InspectorField><InspectorField label="Weight"><select className="bento-input" value={String(config.fontWeight ?? 500)} onChange={e => setConfig('fontWeight', Number(e.target.value))}>{[400,500,600,700,800,900].map(value => <option key={value} value={value}>{value}</option>)}</select></InspectorField><InspectorField label="Line height"><input className="bento-input" type="number" min={0.8} max={2.2} step={0.05} value={num('lineHeight',1.4)} onChange={e => setConfig('lineHeight', Number(e.target.value))}/></InspectorField></div><InspectorField label="Letter spacing"><input className="bento-input" type="number" min={-0.08} max={0.2} step={0.01} value={num('letterSpacing',0)} onChange={e => setConfig('letterSpacing', Number(e.target.value))}/></InspectorField></section><section className="bento-inspector-subsection"><div className="bento-setting-subtitle">Content spacing</div><div className="bento-four-grid"><InspectorField label="Horizontal"><input className="bento-input" type="number" min={0} max={64} value={num('paddingX',20)} onChange={e => setConfig('paddingX', Number(e.target.value))}/></InspectorField><InspectorField label="Vertical"><input className="bento-input" type="number" min={0} max={64} value={num('paddingY',18)} onChange={e => setConfig('paddingY', Number(e.target.value))}/></InspectorField><InspectorField label="Internal gap"><input className="bento-input" type="number" min={0} max={48} value={num('contentGap',14)} onChange={e => setConfig('contentGap', Number(e.target.value))}/></InspectorField><InspectorField label="Horizontal align"><select className="bento-input" value={str('contentAlign','left')} onChange={e => setConfig('contentAlign', e.target.value)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></InspectorField><InspectorField label="Vertical align"><select className="bento-input" value={str('contentVertical','center')} onChange={e => setConfig('contentVertical', e.target.value)}><option value="start">Top</option><option value="center">Center</option><option value="end">Bottom</option></select></InspectorField></div></section></section>}
      {tab === 'animation' && <section className="bento-setting-section"><div className="bento-setting-title">Motion</div><InspectorField label="Entrance / hover"><select className="bento-input" value={str('animation','lift')} onChange={e => setConfig('animation', e.target.value)}><option value="still">Still</option><option value="fade">Fade</option><option value="rise">Rise</option><option value="scale">Scale</option><option value="blur">Blur</option><option value="slide">Slide</option><option value="lift">Lift</option><option value="float">Float</option><option value="pulse">Pulse</option><option value="shine">Shine</option><option value="tilt">Tilt</option><option value="magnetic">Magnetic</option></select></InspectorField><InspectorField label="Hover strength"><input type="range" min="0" max="100" value={num('animationIntensity',70)} onChange={e => setConfig('animationIntensity', Number(e.target.value))}/></InspectorField><label className="bento-toggle-row"><input type="checkbox" checked={config.hoverGlow !== false} onChange={e => setConfig('hoverGlow', e.target.checked)}/><span>Subtle interactive glow</span></label></section>}
      {tab === 'responsive' && <section className="bento-setting-section"><div className="bento-setting-title">Responsive geometry</div><p className="bento-help">Switch the device at the top of the canvas, then edit its geometry. Manual device changes are kept independently.</p><div className="bento-responsive-summary">{(['desktop','tablet','mobile'] as BentoViewport[]).map(mode => { const g = getBentoGeometry(block, mode); return <div key={mode}><span>{getDeviceLabel(mode)}</span><b>{g.columnSpan} × {g.rowSpan}</b><small>col {g.column} · row {g.row}</small></div>; })}</div><label className="bento-toggle-row"><input type="checkbox" checked={String(block.config?.mobileMode || '') === 'stack' ? true : false} onChange={() => setConfig('mobileMode', String(config.mobileMode || '') === 'stack' ? 'smart' : 'stack')}/><span>Prefer stacked mobile content</span></label><div className="bento-responsive-actions"><button type="button" className="bento-action-row" onClick={() => { const source = getBentoGeometry(block,'desktop'); const scaled = scaleGeometryToViewport(source, viewport); const placed = findBentoAvailableGeometry(currentBlocksRef.current, scaled, viewport, block.id); onUpdate({ geometry: { ...(block.geometry || {}), [viewport]: placed } }); }}>Copy desktop geometry here <ChevronRight size={13}/></button><p className="bento-help">Desktop is 12 columns, tablet 8, mobile 4. The copy is scaled to the active grid, then collision-checked.</p></div></section>}
      {tab === 'advanced' && <section className="bento-setting-section"><div className="bento-setting-title">Behavior</div><label className="bento-toggle-row"><input type="checkbox" checked={block.enabled} onChange={e => onUpdate({ enabled: e.target.checked })}/><span>Visible on public page</span></label><label className="bento-toggle-row"><input type="checkbox" checked={block.lockPosition === true} onChange={e => onUpdate({ lockPosition: e.target.checked })}/><span>Lock position during reflow</span></label><label className="bento-toggle-row"><input type="checkbox" checked={block.lockSize === true} onChange={e => onUpdate({ lockSize: e.target.checked })}/><span>Lock size</span></label><label className="bento-toggle-row"><input type="checkbox" checked={block.lockStyle === true} onChange={e => onUpdate({ lockStyle: e.target.checked })}/><span>Lock styling</span></label><InspectorField label="Starts"><input className="bento-input" type="datetime-local" value={block.startAt ? block.startAt.slice(0,16) : ''} onChange={e => onUpdate({ startAt: e.target.value ? new Date(e.target.value).toISOString() : null })}/></InspectorField><InspectorField label="Ends"><input className="bento-input" type="datetime-local" value={block.endAt ? block.endAt.slice(0,16) : ''} onChange={e => onUpdate({ endAt: e.target.value ? new Date(e.target.value).toISOString() : null })}/></InspectorField><div className="bento-inspector-actions"><button type="button" className="bento-action-row" onClick={onDuplicate}><Copy size={15}/> Duplicate <ChevronRight size={14}/></button><button type="button" className="bento-action-row danger" onClick={onDelete}><Trash2 size={15}/> Delete <ChevronRight size={14}/></button></div></section>}
    </div>
  </aside>;
}

export default function BentoBlockEditor({ blocks, onChange, pageDesign, onPageDesignChange, storeId, shareUrl, onUploadMedia, savedRevision, profileMediaEditor, linksEditor }: { blocks: BentoBlock[]; onChange: (blocks: BentoBlock[]) => void; pageDesign?: BentoPageDesign; onPageDesignChange?: (design: BentoPageDesign) => void; storeId?: string; shareUrl?: string; onUploadMedia?: (file: File) => Promise<string | null>; savedRevision?: number; profileMediaEditor?: ReactNode; linksEditor?: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(blocks.find(block => block.enabled)?.id || blocks[0]?.id || null);
  const [selectedIds, setSelectedIds] = useState<string[]>(() => { const first = blocks.find(block => block.enabled)?.id || blocks[0]?.id; return first ? [first] : []; });
  const [viewport, setViewport] = useState<BentoViewport>('desktop');
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [zoom, setZoom] = useState(70);
  const [dragState, setDragState] = useState<{ id: string; startX: number; startY: number; geometry: BentoGeometry; group?: Array<{ id: string; geometry: BentoGeometry }> } | null>(null);
  const [resizeState, setResizeState] = useState<{ id: string; startX: number; startY: number; geometry: BentoGeometry; direction: ResizeDirection } | null>(null);
  const [previewBlocks, setPreviewBlocks] = useState<BentoBlock[] | null>(null);
  const [interactionFeedback, setInteractionFeedback] = useState<{ type: 'drag' | 'resize'; snapped: boolean } | null>(null);
  const [isAddDragOver, setIsAddDragOver] = useState(false);
  const [addDropPreview, setAddDropPreview] = useState<{ type: BentoBlockType; geometry: BentoGeometry } | null>(null);
  const addDragDepthRef = useRef(0);
  const suppressAddClickRef = useRef(false);
  const [history, setHistory] = useState<EditorSnapshot[]>([]);
  const [future, setFuture] = useState<EditorSnapshot[]>([]);
  const currentBlocksRef = useRef(blocks);
  const currentDesignRef = useRef<BentoPageDesign>({ ...DEFAULT_DESIGN, ...(pageDesign || {}) });
  const transactionRef = useRef<{ snapshot: EditorSnapshot; timer: number | null } | null>(null);
  const [search, setSearch] = useState('');
  const [pageInspectorOpen, setPageInspectorOpen] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [pushMode, setPushMode] = useState(false);
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const [showArrange, setShowArrange] = useState(false);
  const [templateKey, setTemplateKey] = useState('creator');
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const layerTouchDragRef = useRef<{ pointerId: number; sourceId: string; lastTargetId: string | null } | null>(null);
  const dragMovedRef = useRef(false);
  const resizeMovedRef = useRef(false);
  const interactionFinishingRef = useRef(false);
  const baselineRef = useRef<EditorSnapshot>({ blocks: cloneBlocks(blocks), design: cloneDesign(currentDesignRef.current) });
  const design = normalizeBentoPageDesign(pageDesign || DEFAULT_DESIGN);
  useEffect(() => { currentBlocksRef.current = blocks; }, [blocks]);
  useEffect(() => { currentDesignRef.current = design; }, [pageDesign]);
  useEffect(() => { if (savedRevision !== undefined) baselineRef.current = { blocks: cloneBlocks(blocks), design: cloneDesign(currentDesignRef.current) }; }, [savedRevision]);
  useEffect(() => {
    const updateViewportForDevice = () => {
      setViewport(window.innerWidth <= 760 ? 'mobile' : window.innerWidth <= 1100 ? 'tablet' : 'desktop');
    };
    updateViewportForDevice();
  }, []);
  useEffect(() => () => { if (transactionRef.current?.timer) window.clearTimeout(transactionRef.current.timer); }, []);
  useEffect(() => () => {
    layerTouchDragRef.current = null;
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
  }, []);
  const activeBlocks = previewBlocks || blocks;
  const activeBlockById = new Map(activeBlocks.map(block => [block.id, block]));
  const selectedBlock = activeBlocks.find(block => block.id === selectedId) || null;
  const selectBlock = (id: string, additive = false) => {
    setSelectedId(id);
    setSelectedIds(current => (additive || multiSelectMode) ? current.includes(id) ? current.filter(item => item !== id) : [...current, id] : [id]);
  };
  const layout = useMemo(() => getBentoLayout(activeBlocks, viewport), [activeBlocks, viewport]);
  const rowHeight = getBentoRowHeight(viewport);
  const maxRow = layout.reduce((max, item) => Math.max(max, item.row + item.rowSpan - 1), 5);
  const effectiveGridGap = getBentoEffectiveGridGap(design);
  const gridHeight = Math.max(540, maxRow * rowHeight + Math.max(0, maxRow - 1) * effectiveGridGap + 56);
  const isValid = validateBentoLayout(activeBlocks, viewport);
  const filteredTypes = CUSTOM_TYPES.filter(item => `${item.label} ${item.hint} ${item.category}`.toLowerCase().includes(search.trim().toLowerCase()));

  const currentSnapshot = useCallback((): EditorSnapshot => ({
    blocks: cloneBlocks(currentBlocksRef.current),
    design: cloneDesign(currentDesignRef.current),
  }), []);

  const commit = useCallback((next: BentoBlock[], historyEnabled = true, coalesce = false) => {
    // Persistence commits must not implicitly repack an existing creator layout.
    // Explicit add/move/resize/arrange operations prepare their geometry before commit.
    const normalized = next;
    if (historyEnabled) {
      const before = currentSnapshot();
      if (coalesce) {
        if (!transactionRef.current) transactionRef.current = { snapshot: before, timer: null };
        if (transactionRef.current.timer) window.clearTimeout(transactionRef.current.timer);
        transactionRef.current.timer = window.setTimeout(() => {
          const transaction = transactionRef.current;
          if (!transaction) return;
          transactionRef.current = null;
          setHistory(previous => [...previous.slice(-49), transaction.snapshot]);
        }, 500);
      } else {
        if (transactionRef.current?.timer) window.clearTimeout(transactionRef.current.timer);
        const pending = transactionRef.current;
        transactionRef.current = null;
        setHistory(previous => [...previous.slice(-49), pending ? pending.snapshot : before]);
      }
      setFuture([]);
    }
    currentBlocksRef.current = normalized;
    onChange(normalized);
  }, [currentSnapshot, onChange]);

  const takeTransaction = useCallback(() => {
    const transaction = transactionRef.current;
    if (!transaction) return null;
    if (transaction.timer) window.clearTimeout(transaction.timer);
    transactionRef.current = null;
    return transaction.snapshot;
  }, []);

  const recordTransaction = useCallback((snapshot: EditorSnapshot) => {
    setHistory(previous => [...previous.slice(-49), snapshot]);
  }, []);

  const flushTransaction = useCallback(() => {
    const snapshot = takeTransaction();
    if (snapshot) recordTransaction(snapshot);
  }, [takeTransaction, recordTransaction]);

  const updateDesign = useCallback((patch: Partial<BentoPageDesign>) => {
    const before = currentSnapshot();
    if (!transactionRef.current) transactionRef.current = { snapshot: before, timer: null };
    if (transactionRef.current.timer) window.clearTimeout(transactionRef.current.timer);
    transactionRef.current.timer = window.setTimeout(() => {
      const transaction = transactionRef.current;
      if (!transaction) return;
      transactionRef.current = null;
      setHistory(previous => [...previous.slice(-49), transaction.snapshot]);
    }, 500);
    setFuture([]);
    const nextDesign = { ...currentDesignRef.current, ...patch };
    currentDesignRef.current = nextDesign;
    onPageDesignChange?.(nextDesign);
  }, [currentSnapshot, onPageDesignChange]);

  const updateBlock = useCallback((id: string, patch: Partial<BentoBlock>) => {
    const current = currentBlocksRef.current.find(block => block.id === id);
    if (!current) return;
    if (current.locked) {
      const onlyControl = Object.keys(patch).every(key => key === 'enabled' || key === 'locked');
      if (!onlyControl) return;
    }
    if (current.lockStyle && patch.config) return;
    if (current.lockSize && patch.geometry) {
      const before = getBentoGeometry(current, viewport);
      const after = patch.geometry?.[viewport] as BentoGeometry | undefined;
      if (after && (after.columnSpan !== before.columnSpan || after.rowSpan !== before.rowSpan)) return;
    }
    if (current.lockPosition && patch.geometry) {
      const before = getBentoGeometry(current, viewport);
      const after = patch.geometry?.[viewport] as BentoGeometry | undefined;
      if (after && (after.column !== before.column || after.row !== before.row)) return;
    }
    const coalesce = Boolean(patch.config || patch.startAt !== undefined || patch.endAt !== undefined);
    commit(currentBlocksRef.current.map(block => block.id === id ? { ...block, ...patch } : block), true, coalesce);
  }, [commit, viewport]);

  function undo() {
    const transactionSnapshot = takeTransaction();
    const currentState = { blocks: cloneBlocks(currentBlocksRef.current), design: cloneDesign(currentDesignRef.current) };

    if (transactionSnapshot) {
      setFuture(current => [currentState, ...current].slice(0, 50));
      currentBlocksRef.current = cloneBlocks(transactionSnapshot.blocks);
      currentDesignRef.current = cloneDesign(transactionSnapshot.design);
      onChange(currentBlocksRef.current);
      onPageDesignChange?.(currentDesignRef.current);
      return;
    }

    const previous = history[history.length - 1];
    if (!previous) return;

    setHistory(history.slice(0, -1));
    setFuture(current => [currentState, ...current].slice(0, 50));
    currentBlocksRef.current = cloneBlocks(previous.blocks);
    currentDesignRef.current = cloneDesign(previous.design);
    onChange(currentBlocksRef.current);
    onPageDesignChange?.(currentDesignRef.current);
  }

  function redo() {
    const transactionSnapshot = takeTransaction();
    if (transactionSnapshot) recordTransaction(transactionSnapshot);
    const next = future[0];
    if (!next) return;

    const currentState = { blocks: cloneBlocks(currentBlocksRef.current), design: cloneDesign(currentDesignRef.current) };
    setHistory(previous => [...previous.slice(-49), currentState]);
    setFuture(current => current.slice(1));
    currentBlocksRef.current = cloneBlocks(next.blocks);
    currentDesignRef.current = cloneDesign(next.design);
    onChange(currentBlocksRef.current);
    onPageDesignChange?.(currentDesignRef.current);
  }

  useEffect(() => {
    if (selectedId && !blocks.some(block => block.id === selectedId)) setSelectedId(blocks.find(block => block.enabled)?.id || blocks[0]?.id || null);
    setSelectedIds(current => current.filter(id => blocks.some(block => block.id === id)));
  }, [blocks, selectedId]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (mode === 'preview') return;
      const mod = event.metaKey || event.ctrlKey;
      const editing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if (mod && event.key.toLowerCase() === 'd' && selectedId && !editing) { event.preventDefault(); duplicateBlock(selectedId); return; }
      if (event.key === 'Delete' && selectedId && !editing) { event.preventDefault(); removeBlock(selectedId); return; }
      if (event.key === 'Escape') { setSelectedId(null); setSelectedIds([]); return; }
      if (selectedId && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key) && !editing) { event.preventDefault(); nudge(selectedId, event.key, event.shiftKey ? 2 : 1); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  function getDropGeometry(dropPoint: { clientX: number; clientY: number }, block: BentoBlock): BentoGeometry | null {
    const stage = stageRef.current;
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    const columns = BENTO_VIEWPORT_COLUMNS[viewport];
    const paddingLeft = Number.parseFloat(style.paddingLeft || '22') || 22;
    const paddingTop = Number.parseFloat(style.paddingTop || '22') || 22;
    const gap = effectiveGridGap;
    const scale = Math.max(0.25, zoom / 100);
    const usableWidth = Math.max(1, rect.width / scale - paddingLeft - (Number.parseFloat(style.paddingRight || '22') || 22));
    const cellWidth = (usableWidth - gap * (columns - 1)) / Math.max(columns, 1);
    const localX = (dropPoint.clientX - rect.left) / scale - paddingLeft;
    const localY = (dropPoint.clientY - rect.top) / scale - paddingTop;
    const geometry = getBentoGeometry(block, viewport);
    return {
      ...geometry,
      column: Math.max(1, Math.min(columns - geometry.columnSpan + 1, Math.floor((localX + gap / 2) / Math.max(1, cellWidth + gap)) + 1)),
      row: Math.max(1, Math.floor((localY + gap / 2) / Math.max(1, rowHeight + gap)) + 1),
    };
  }

  function seedNewBlockGeometry(block: BentoBlock, preferred?: BentoGeometry | null) {
    let seeded: BentoBlock = {
      ...block,
      geometry: {
        desktop: { column: 1, row: 1, ...getBentoSpan(block.size) },
        tablet: scaleGeometryToViewport({ column: 1, row: 1, ...getBentoSpan(block.size) }, 'tablet'),
        mobile: scaleGeometryToViewport({ column: 1, row: 1, ...getBentoSpan(block.size) }, 'mobile'),
      },
    };
    if (preferred) seeded = withBentoGeometry(seeded, preferred, viewport);
    return seeded;
  }

  function updateAddDropPreview(type: BentoBlockType, event: React.DragEvent<HTMLDivElement>) {
    if (!BENTO_TYPES.some(item => item.type === type) || currentBlocksRef.current.length >= 120) {
      setAddDropPreview(null);
      return;
    }
    const probe = makeBlock(type, currentBlocksRef.current.length);
    const desired = getDropGeometry({ clientX: event.clientX, clientY: event.clientY }, probe);
    if (!desired) {
      setAddDropPreview(null);
      return;
    }
    setAddDropPreview({ type, geometry: findBentoAvailableGeometry(currentBlocksRef.current, desired, viewport) });
  }

  function addBlock(type: BentoBlockType, dropPoint?: { clientX: number; clientY: number }) {
    const current = currentBlocksRef.current;
    if (current.length >= 120) {
      setIsAddDragOver(false);
      setAddDropPreview(null);
      return;
    }
    const raw = makeBlock(type, current.length);
    const preferred = dropPoint ? getDropGeometry(dropPoint, raw) : null;
    let nextBlock = seedNewBlockGeometry(raw, preferred);
    for (const currentViewport of ['desktop', 'tablet', 'mobile'] as BentoViewport[]) {
      const desired = getBentoGeometry(nextBlock, currentViewport);
      const placement = findBentoAvailableGeometry(current, desired, currentViewport);
      nextBlock = withBentoGeometry(nextBlock, placement, currentViewport);
    }
    setSelectedId(nextBlock.id);
    commit([...current, nextBlock]);
  }

  function removeBlock(id: string) {
    const source = currentBlocksRef.current;
    const target = source.find(block => block.id === id);
    if (!target) return;
    // System nodes are hidden by default on deletion so legacy data remains recoverable.
    if (target.systemKey) { updateBlock(id, { enabled: false }); return; }
    const next = source.filter(block => block.id !== id);
    commit(next);
    setSelectedId(next.find(block => block.enabled)?.id || null);
  }

  function duplicateBlock(id: string) {
    if (currentBlocksRef.current.length >= 120) return;
    const source = currentBlocksRef.current.find(block => block.id === id);
    if (!source) return;
    // System nodes are singleton representations of live creator data. Turning a
    // duplicate into a custom clone silently creates a second visual owner, so
    // duplication is intentionally limited to custom widgets.
    if (source.systemKey) return;
    const copy: BentoBlock = {
      ...source,
      id: makeId(),
      position: source.position ? { ...source.position } : null,
      systemKey: undefined,
      config: source.config ? JSON.parse(JSON.stringify(source.config)) : {},
      geometry: source.geometry ? JSON.parse(JSON.stringify(source.geometry)) : undefined,
      locked: false,
      lockPosition: false,
      lockSize: false,
      lockStyle: false,
    };
    for (const currentViewport of ['desktop','tablet','mobile'] as BentoViewport[]) {
      const base = getBentoGeometry(source, currentViewport);
      const offset = { ...base, column: base.column + 1, row: base.row + 1 };
      const placement = findBentoAvailableGeometry(currentBlocksRef.current, offset, currentViewport);
      copy.geometry = { ...(copy.geometry || {}), [currentViewport]: placement };
    }
    copy.position = { ...getBentoGeometry(copy, 'desktop') };
    const next = [...currentBlocksRef.current, copy];
    setSelectedId(copy.id);
    commit(next);
  }

  function nudge(id: string, key: string, amount: number) {
    const source = currentBlocksRef.current;
    const block = source.find(item => item.id === id);
    if (!block || block.locked || block.lockPosition) return;
    const geometry = getBentoGeometry(block, viewport);
    const delta = { ...geometry };
    if (key === 'ArrowLeft') delta.column -= amount;
    if (key === 'ArrowRight') delta.column += amount;
    if (key === 'ArrowUp') delta.row -= amount;
    if (key === 'ArrowDown') delta.row += amount;
    if (pushMode) {
      const deltaColumn = key === 'ArrowLeft' ? -amount : key === 'ArrowRight' ? amount : 0;
      const deltaRow = key === 'ArrowUp' ? -amount : key === 'ArrowDown' ? amount : 0;
      const movable = source.filter(item => item.enabled && !item.locked && !item.lockPosition);
      if (!movable.length || movable.some(item => {
        const current = getBentoGeometry(item, viewport);
        return current.column + deltaColumn < 1 || current.row + deltaRow < 1 || current.column + deltaColumn + current.columnSpan - 1 > BENTO_VIEWPORT_COLUMNS[viewport];
      })) return;
      commit(source.map(item => {
        if (!movable.some(movableItem => movableItem.id === item.id)) return item;
        const current = getBentoGeometry(item, viewport);
        return withBentoGeometry(item, { ...current, column: current.column + deltaColumn, row: current.row + deltaRow }, viewport);
      }));
      return;
    }
    const overlaps = (first: BentoGeometry, second: BentoGeometry) => first.column < second.column + second.columnSpan && first.column + first.columnSpan > second.column && first.row < second.row + second.rowSpan && first.row + first.rowSpan > second.row;
    const group = selectedIds.includes(id) ? source.filter(item => selectedIds.includes(item.id) && item.enabled && !item.locked && !item.lockPosition) : [];
    if (group.length > 1) {
      const deltaRow = key === 'ArrowUp' ? -amount : key === 'ArrowDown' ? amount : 0;
      const deltaColumn = key === 'ArrowLeft' ? -amount : key === 'ArrowRight' ? amount : 0;
      const destinations = group.map(item => { const current = getBentoGeometry(item, viewport); return { block: item, geometry: { ...current, row: current.row + deltaRow, column: current.column + deltaColumn } }; });
      const valid = destinations.every(item => item.geometry.row >= 1 && item.geometry.column >= 1 && item.geometry.column + item.geometry.columnSpan - 1 <= BENTO_VIEWPORT_COLUMNS[viewport]);
      const groupIds = new Set(group.map(item => item.id));
      const others = source.filter(item => item.enabled && !groupIds.has(item.id));
      const blockers = valid ? others.filter(item => destinations.some(destination => overlaps(destination.geometry, getBentoGeometry(item, viewport)))) : [];
      const sameSize = (first: BentoGeometry, second: BentoGeometry) => first.columnSpan === second.columnSpan && first.rowSpan === second.rowSpan;
      const unusedBlockers = [...blockers];
      const pairs = destinations.map(destination => {
        const matchIndex = unusedBlockers.findIndex(item => sameSize(destination.geometry, getBentoGeometry(item, viewport)));
        if (matchIndex < 0) return null;
        return { destination, blocker: unusedBlockers.splice(matchIndex, 1)[0] };
      });
      if (valid && (!blockers.length || (pairs.every(Boolean) && unusedBlockers.length === 0))) {
        const next = source.map(item => {
          const moved = destinations.find(destination => destination.block.id === item.id);
          if (moved) return withBentoGeometry(item, moved.geometry, viewport);
          const pair = pairs.find(value => value?.blocker.id === item.id);
          if (pair) return withBentoGeometry(item, getBentoGeometry(pair.destination.block, viewport), viewport);
          return item;
        });
        commit(next);
        return;
      }
    }
    const destinationIsValid = delta.column >= 1 && delta.row >= 1 && delta.column + delta.columnSpan - 1 <= BENTO_VIEWPORT_COLUMNS[viewport];
    const pushed = ['ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(key) && destinationIsValid ? replaceBentoBlockWithPush(source, id, delta, viewport) : null;
    if (pushed) { commit(pushed); return; }
    const replacement = destinationIsValid && source.find(item => {
      if (!item.enabled || item.id === id || item.locked || item.lockPosition) return false;
      const candidate = getBentoGeometry(item, viewport);
      return candidate.columnSpan === geometry.columnSpan && candidate.rowSpan === geometry.rowSpan && overlaps(delta, candidate);
    });
    if (replacement) {
      const replacementGeometry = getBentoGeometry(replacement, viewport);
      const next = source.map(item => {
        if (item.id === id) return withBentoGeometry(item, { ...geometry, column: replacementGeometry.column, row: replacementGeometry.row }, viewport);
        if (item.id === replacement.id) return withBentoGeometry(item, { ...replacementGeometry, column: geometry.column, row: geometry.row }, viewport);
        return item;
      });
      commit(next);
      return;
    }
    const placement = findBentoAvailableGeometry(source, delta, viewport, id);
    commit(source.map(item => item.id === id ? withBentoGeometry(item, placement, viewport) : item));
  }

  function reorderLayer(sourceId: string, targetId: string, coalesce = false) {
    if (sourceId === targetId) return;
    const source = currentBlocksRef.current;
    const sourceBlock = source.find(block => block.id === sourceId);
    if (!sourceBlock || sourceBlock.locked) return;
    const from = source.findIndex(block => block.id === sourceId);
    const to = source.findIndex(block => block.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...source];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit(next, true, coalesce);
  }

  function beginLayerTouchDrag(event: ReactPointerEvent<HTMLButtonElement>, sourceId: string) {
    if (mode === 'preview' || event.pointerType === 'mouse') return;
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
    layerTouchDragRef.current = { pointerId: event.pointerId, sourceId, lastTargetId: null };
    setSelectedId(sourceId);
  }

  function moveLayerTouchDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = layerTouchDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-layer-id]') as HTMLElement | null;
    const targetId = target?.dataset.layerId || null;
    if (!targetId || targetId === drag.sourceId || targetId === drag.lastTargetId) return;
    drag.lastTargetId = targetId;
    reorderLayer(drag.sourceId, targetId, true);
  }

  function finishLayerTouchDrag(event?: ReactPointerEvent<HTMLElement>) {
    const drag = layerTouchDragRef.current;
    if (!drag) return;
    if (event && drag.pointerId === event.pointerId) {
      event.preventDefault();
      try { (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId); } catch {}
    }
    layerTouchDragRef.current = null;
    flushTransaction();
  }

  function moveLayer(id: string, direction: -1 | 1) {
    const source = currentBlocksRef.current;
    const block = source.find(item => item.id === id);
    if (!block || block.locked) return;
    const index = source.findIndex(block => block.id === id);
    if (index < 0) return;
    const target = Math.max(0, Math.min(source.length - 1, index + direction));
    if (index === target) return;
    const next = [...source]; [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  }

  function smartArrange(kind: 'pack' | 'balance' | 'rhythm' | 'fill' | 'reset') {
    if (kind === 'reset') {
      flushTransaction();
      const nextBlocks = cloneBlocks(baselineRef.current.blocks);
      const nextDesign = cloneDesign(baselineRef.current.design);
      setHistory(previous => [...previous.slice(-49), currentSnapshot()]);
      setFuture([]);
      currentBlocksRef.current = nextBlocks;
      currentDesignRef.current = nextDesign;
      onChange(nextBlocks);
      onPageDesignChange?.(nextDesign);
      return;
    }
    let next = [...blocks];
    if (kind === 'balance') {
      next = next.map((block, index) => {
        if (block.locked || block.lockPosition) return block;
        const base = getBentoGeometry(block, viewport);
        const target = { ...base, column: index % 2 === 0 ? 1 : 7, row: 1 + Math.floor(index / 2) * 4, columnSpan: Math.min(BENTO_VIEWPORT_COLUMNS[viewport], index % 2 === 0 ? 6 : 5) };
        if (block.lockSize) { target.columnSpan = base.columnSpan; target.rowSpan = base.rowSpan; }
        return withBentoGeometry(block, target, viewport);
      });
    } else if (kind === 'rhythm') {
      next = next.map((block, index) => {
        if (block.locked || block.lockPosition) return block;
        const base = getBentoGeometry(block, viewport);
        const target = { ...base, column: index % 3 === 0 ? 1 : index % 3 === 1 ? 5 : 9, row: 1 + Math.floor(index / 3) * 4, columnSpan: index % 3 === 0 ? 4 : index % 3 === 1 ? 4 : 3, rowSpan: index % 2 === 0 ? 3 : 2 };
        if (block.lockSize) { target.columnSpan = base.columnSpan; target.rowSpan = base.rowSpan; }
        return withBentoGeometry(block, target, viewport);
      });
    } else if (kind === 'fill') {
      next = packBentoBlocks(next, viewport);
    }
    commit(kind === 'pack' ? packBentoBlocks(next, viewport) : arrangeBentoBlocks(next, viewport));
  }

  function applyTemplate(key: string) {
    const template = TEMPLATES[key];
    if (!template) return;
    const editable = blocks.filter(block => !block.systemKey);
    const source = editable.length ? editable : template.sizes.map((_, index) => makeBlock(index % 2 ? 'rich_text' : 'image', index));
    const next = blocks.map(block => {
      const editableIndex = editable.findIndex(item => item.id === block.id);
      if (editableIndex < 0) return block;
      if (block.locked || block.lockPosition) return block;
      const size = template.sizes[editableIndex % template.sizes.length];
      const current = getBentoGeometry(block, viewport);
      return withBentoGeometry(block, { ...current, columnSpan: block.lockSize ? current.columnSpan : Math.min(BENTO_VIEWPORT_COLUMNS[viewport], size[0]), rowSpan: block.lockSize ? current.rowSpan : size[1] }, viewport);
    });
    commit(arrangeBentoBlocks(next, viewport));
    setSelectedId(source[0]?.id || blocks[0]?.id || null);
  }

  function pointerToGrid(stage: HTMLElement, dx: number, dy: number) {
    const style = getComputedStyle(stage);
    const columns = BENTO_VIEWPORT_COLUMNS[viewport];
    const left = parseFloat(style.paddingLeft || '20');
    const right = parseFloat(style.paddingRight || '20');
    const gap = effectiveGridGap;
    const cellW = (stage.clientWidth - left - right - gap * (columns - 1)) / columns;
    const cellH = getBentoRowHeight(viewport);
    const scale = Math.max(0.25, zoom / 100);
    dx /= scale;
    dy /= scale;
    return { dc: Math.round(dx / Math.max(8, cellW + gap)), dr: Math.round(dy / Math.max(8, cellH + gap)) };
  }

  function resizeGeometry(start: BentoGeometry, dc: number, dr: number, direction: ResizeDirection): BentoGeometry {
    let next = { ...start };
    if (direction.includes('e')) next.columnSpan += dc;
    if (direction.includes('s')) next.rowSpan += dr;
    if (direction.includes('w')) { next.column += dc; next.columnSpan -= dc; }
    if (direction.includes('n')) { next.row += dr; next.rowSpan -= dr; }
    next.columnSpan = Math.max(1, Math.min(BENTO_VIEWPORT_COLUMNS[viewport], next.columnSpan));
    next.rowSpan = Math.max(1, Math.min(64, next.rowSpan));
    next.column = Math.max(1, Math.min(BENTO_VIEWPORT_COLUMNS[viewport] - next.columnSpan + 1, next.column));
    next.row = Math.max(1, next.row);
    return next;
  }

  function dragGeometry(start: BentoGeometry, dc: number, dr: number): BentoGeometry {
    return { ...start, column: Math.max(1, Math.min(BENTO_VIEWPORT_COLUMNS[viewport] - start.columnSpan + 1, start.column + dc)), row: Math.max(1, start.row + dr) };
  }

  function moveGroupGeometry(source: BentoBlock[], group: Array<{ id: string; geometry: BentoGeometry }>, dc: number, dr: number) {
    const overlaps = (first: BentoGeometry, second: BentoGeometry) => first.column < second.column + second.columnSpan && first.column + first.columnSpan > second.column && first.row < second.row + second.rowSpan && first.row + first.rowSpan > second.row;
    const groupIds = new Set(group.map(item => item.id));
    const destinations = group.map(item => ({ ...item, next: { ...item.geometry, column: item.geometry.column + dc, row: item.geometry.row + dr } }));
    if (destinations.some(item => item.next.column < 1 || item.next.row < 1 || item.next.column + item.next.columnSpan - 1 > BENTO_VIEWPORT_COLUMNS[viewport])) return null;
    if (destinations.some((item, index) => destinations.some((other, otherIndex) => index !== otherIndex && overlaps(item.next, other.next)))) return null;
    const blockers = source.filter(item => item.enabled && !groupIds.has(item.id) && destinations.some(destination => overlaps(destination.next, getBentoGeometry(item, viewport))));
    if (blockers.length) {
      const unused = [...blockers];
      const pairs = destinations.map(destination => {
        const index = unused.findIndex(item => { const geometry = getBentoGeometry(item, viewport); return geometry.columnSpan === destination.next.columnSpan && geometry.rowSpan === destination.next.rowSpan && overlaps(destination.next, geometry); });
        return index < 0 ? null : { destination, blocker: unused.splice(index, 1)[0] };
      });
      if (pairs.some(pair => !pair) || unused.length) return null;
      return source.map(item => {
        const moved = destinations.find(destination => destination.id === item.id);
        if (moved) return withBentoGeometry(item, moved.next, viewport);
        const pair = pairs.find(value => value?.blocker.id === item.id);
        return pair ? withBentoGeometry(item, group.find(groupItem => groupItem.id === pair.destination.id)!.geometry, viewport) : item;
      });
    }
    return source.map(item => { const moved = destinations.find(destination => destination.id === item.id); return moved ? withBentoGeometry(item, moved.next, viewport) : item; });
  }

  function beginDrag(event: ReactPointerEvent<HTMLDivElement>, id: string) {
    if (mode === 'preview' || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const block = blocks.find(item => item.id === id);
    const stage = stageRef.current;
    if (!block || block.locked || block.lockPosition || !stage) return;
    event.preventDefault();
    event.stopPropagation();
    try { stage.setPointerCapture(event.pointerId); } catch {}
    setSelectedId(id);
    setSelectedIds([id]);
    setResizeState(null);
    setPreviewBlocks(null);
    setInteractionFeedback(null);
    dragMovedRef.current = false;
    resizeMovedRef.current = false;
    const group = multiSelectMode && selectedIds.includes(id) ? blocks.filter(item => selectedIds.includes(item.id) && item.enabled && !item.locked && !item.lockPosition).map(item => ({ id: item.id, geometry: getBentoGeometry(item, viewport) })) : undefined;
    setDragState({ id, startX: event.clientX, startY: event.clientY, geometry: getBentoGeometry(block, viewport), group });
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>, id: string, force = false) {
    if (mode === 'preview') return;
    const block = blocks.find(item => item.id === id);
    if (!block || block.locked || block.lockPosition || !stageRef.current) return;

    if (event.shiftKey) {
      selectBlock(id, true);
      return;
    }
    if (multiSelectMode && !selectedIds.includes(id)) {
      selectBlock(id, true);
      return;
    }

    // Mouse users retain the existing direct-drag behavior. Touch/pen users must
    // use the explicit move handle so vertical swipes remain native scrolling.
    if (event.pointerType !== 'mouse' && !force) {
      setSelectedId(id);
      return;
    }
    beginDrag(event, id);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>, id: string, direction: ResizeDirection) {
    if (mode === 'preview' || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const block = blocks.find(item => item.id === id);
    if (!block || block.locked || block.lockSize || !stageRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    stageRef.current.setPointerCapture(event.pointerId);
    setSelectedId(id);
    setDragState(null);
    setPreviewBlocks(null);
    setInteractionFeedback(null);
    resizeMovedRef.current = false;
    dragMovedRef.current = false;
    setResizeState({ id, startX: event.clientX, startY: event.clientY, geometry: getBentoGeometry(block, viewport), direction });
  }

  function updateInteraction(event: ReactPointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage || (!dragState && !resizeState)) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const pointerX = event.clientX;
    const pointerY = event.clientY;
    rafRef.current = requestAnimationFrame(() => {
      const sourceBlocks = currentBlocksRef.current;
      if (resizeState) {
        const { dc, dr } = pointerToGrid(stage, pointerX - resizeState.startX, pointerY - resizeState.startY);
        if (dc !== 0 || dr !== 0) resizeMovedRef.current = true;
        const geometry = resizeGeometry(resizeState.geometry, dc, dr, resizeState.direction);
        const placement = findBentoAvailableGeometry(sourceBlocks, geometry, viewport, resizeState.id);
        const candidate = sourceBlocks.map(block => block.id === resizeState.id ? withBentoGeometry(block, placement, viewport) : block);
        setInteractionFeedback(isBentoGeometryEqual(geometry, placement) ? null : { type: 'resize', snapped: true });
        setPreviewBlocks(candidate);
      } else if (dragState) {
        const { dc, dr } = pointerToGrid(stage, pointerX - dragState.startX, pointerY - dragState.startY);
        if (dc !== 0 || dr !== 0) dragMovedRef.current = true;
        if (dragState.group && dragState.group.length > 1) {
          const grouped = moveGroupGeometry(sourceBlocks, dragState.group, dc, dr);
          setInteractionFeedback(grouped ? null : { type: 'drag', snapped: true });
          setPreviewBlocks(grouped || sourceBlocks);
          return;
        }
        const geometry = dragGeometry(dragState.geometry, dc, dr);
        const pushed = replaceBentoBlockWithPush(sourceBlocks, dragState.id, geometry, viewport);
        const placement = pushed ? geometry : findBentoAvailableGeometry(sourceBlocks, geometry, viewport, dragState.id);
        const candidate = pushed || sourceBlocks.map(block => block.id === dragState.id ? withBentoGeometry(block, placement, viewport) : block);
        setInteractionFeedback(pushed || isBentoGeometryEqual(geometry, placement) ? null : { type: 'drag', snapped: true });
        setPreviewBlocks(candidate);
      }
    });
  }

  function finishInteraction(event?: ReactPointerEvent<HTMLDivElement>) {
    if (interactionFinishingRef.current) return;
    if (!dragState && !resizeState) return;
    interactionFinishingRef.current = true;
    try {
      const stage = stageRef.current;
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      const sourceBlocks = currentBlocksRef.current;
      const finalDelta = stage && event
        ? pointerToGrid(stage, (event.clientX - (resizeState?.startX ?? dragState?.startX ?? event.clientX)), (event.clientY - (resizeState?.startY ?? dragState?.startY ?? event.clientY)))
        : { dc: 0, dr: 0 };
      const didMove = resizeMovedRef.current || dragMovedRef.current || finalDelta.dc !== 0 || finalDelta.dr !== 0;
      let next = previewBlocks || sourceBlocks;
      // A click on a block is selection, not a layout transaction. Never rewrite/reflow
      // the document merely because the pointer was pressed and released in place.
      if (!didMove) {
        if (event) { try { stage?.releasePointerCapture(event.pointerId); } catch {} }
        setPreviewBlocks(null); setInteractionFeedback(null); setDragState(null); setResizeState(null);
        dragMovedRef.current = false; resizeMovedRef.current = false;
        return;
      }
      // Compute the final pointer position synchronously so releasing between animation frames
      // never drops the last movement/resize delta.
      if (stage && event) {
        if (resizeState) {
          const { dc, dr } = finalDelta;
          const geometry = resizeGeometry(resizeState.geometry, dc, dr, resizeState.direction);
          const placement = findBentoAvailableGeometry(sourceBlocks, geometry, viewport, resizeState.id);
          next = sourceBlocks.map(block => block.id === resizeState.id ? withBentoGeometry(block, placement, viewport) : block);
        } else if (dragState) {
          const { dc, dr } = finalDelta;
          const geometry = dragGeometry(dragState.geometry, dc, dr);
          next = dragState.group && dragState.group.length > 1
            ? moveGroupGeometry(sourceBlocks, dragState.group, finalDelta.dc, finalDelta.dr) || sourceBlocks
            : replaceBentoBlockWithPush(sourceBlocks, dragState.id, geometry, viewport) || sourceBlocks.map(block => block.id === dragState.id ? withBentoGeometry(block, findBentoAvailableGeometry(sourceBlocks, geometry, viewport, dragState.id), viewport) : block);
        }
        try { stage.releasePointerCapture(event.pointerId); } catch {}
      }
      commit(next);
      setPreviewBlocks(null); setInteractionFeedback(null); setDragState(null); setResizeState(null);
      dragMovedRef.current = false; resizeMovedRef.current = false;
    } finally {
      window.setTimeout(() => { interactionFinishingRef.current = false; }, 0);
    }
  }
  const previewWidth = design.pageWidth === 'wide' ? 980 : design.pageWidth === 'compact' ? 700 : 860;
  const gridCss = {
    minHeight: gridHeight,
    ['--bento-stage-cols' as string]: BENTO_VIEWPORT_COLUMNS[viewport],
    ['--bento-stage-gap' as string]: `${effectiveGridGap}px`,
    ['--bento-grid-gap' as string]: `${effectiveGridGap}px`,
    ['--bento-stage-radius' as string]: `${design.cardRadius}px`,
    ['--bento-zoom' as string]: `${zoom / 100}`,
    ['--bento-preview-width' as string]: `${previewWidth}px`,
  } as CSSProperties;

  const fontClass = design.font === 'editorial' ? 'bento-font-editorial' : design.font === 'mono' ? 'bento-font-mono' : design.font === 'clean' ? 'bento-font-clean' : 'bento-font-modern';
  const motionClass = design.motion === 'calm' ? 'bento-motion-calm' : design.motion === 'cinematic' ? 'bento-motion-cinematic' : 'bento-motion-expressive';
  const textureClass = design.texture === 'dots' ? 'bento-texture-dots' : design.texture === 'noise' ? 'bento-texture-noise' : design.texture === 'grain' ? 'bento-texture-grain' : 'bento-texture-none';
  const densityClass = `bento-density-${design.contentDensity || 'comfortable'}`;
  const handleEditorPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === 'touch') return;
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    target.style.setProperty('--bento-pointer-x', `${event.clientX - rect.left}px`);
    target.style.setProperty('--bento-pointer-y', `${event.clientY - rect.top}px`);
    target.style.setProperty('--bento-cursor-client-x', `${event.clientX}px`);
    target.style.setProperty('--bento-cursor-client-y', `${event.clientY}px`);
    target.dataset.bentoCursorActive = 'true';
  };
  const handleEditorPointerLeave = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.dataset.bentoCursorActive = 'false';
  };
  const finishMarquee = () => {
    if (!marquee || !stageRef.current) return;
    const left = Math.min(marquee.startX, marquee.currentX);
    const right = Math.max(marquee.startX, marquee.currentX);
    const top = Math.min(marquee.startY, marquee.currentY);
    const bottom = Math.max(marquee.startY, marquee.currentY);
    const selected = Array.from(stageRef.current.querySelectorAll<HTMLElement>('[data-bento-id]')).filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top;
    }).map(element => element.dataset.bentoId).filter((id): id is string => Boolean(id));
    setSelectedIds(selected);
    setSelectedId(selected[0] || null);
    setMarquee(null);
  };
  const handleMarqueePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!multiSelectMode || event.pointerType !== 'mouse' || !(event.target instanceof Element) || !event.target.classList.contains('bento-editor-stage')) return;
    event.preventDefault();
    event.stopPropagation();
    setMarquee({ startX: event.clientX, startY: event.clientY, currentX: event.clientX, currentY: event.clientY });
    try { stageRef.current?.setPointerCapture(event.pointerId); } catch {}
  };
  const handleMarqueePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!marquee) return;
    setMarquee(current => current ? { ...current, currentX: event.clientX, currentY: event.clientY } : null);
  };
  const handleMarqueePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!marquee) return;
    event.preventDefault();
    event.stopPropagation();
    finishMarquee();
    try { stageRef.current?.releasePointerCapture(event.pointerId); } catch {}
  };
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !multiSelectMode) return;
    const onDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.target !== stage) return;
      event.preventDefault();
      event.stopPropagation();
      setMarquee({ startX: event.clientX, startY: event.clientY, currentX: event.clientX, currentY: event.clientY });
      try { stage.setPointerCapture(event.pointerId); } catch {}
    };
    const onMove = (event: PointerEvent) => {
      if (!marquee) return;
      setMarquee(current => current ? { ...current, currentX: event.clientX, currentY: event.clientY } : null);
    };
    const onUp = (event: PointerEvent) => {
      if (!marquee) return;
      event.preventDefault();
      event.stopPropagation();
      finishMarquee();
      try { stage.releasePointerCapture(event.pointerId); } catch {}
    };
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    return () => { stage.removeEventListener('pointerdown', onDown); stage.removeEventListener('pointermove', onMove); stage.removeEventListener('pointerup', onUp); stage.removeEventListener('pointercancel', onUp); };
  }, [multiSelectMode, marquee]);
  return <section className={`bento-editor-v2 ${fontClass} ${motionClass} ${textureClass} ${densityClass} bento-button-style-${design.buttonStyle || 'solid'} bento-global-shadow-${design.cardShadow || 'soft'}`} data-bento-cursor-fx={design.cursorFx || 'none'} data-bento-spotlight={design.spotlight === false ? 'off' : 'on'} data-bento-cursor-active="false" onPointerMove={handleEditorPointerMove} onPointerLeave={handleEditorPointerLeave} style={{ ['--hub-accent' as string]: design.accent, ['--bento-noise-opacity' as string]: design.noise === false ? 0 : .07, ['--bento-cursor-opacity' as string]: design.spotlight === false || design.cursorFx === 'none' ? 0 : .88, ['--bento-animation-intensity' as string]: `${Number(design.animationIntensity ?? 70) / 100}`, ['--bento-global-card-shadow' as string]: getBentoCardShadow(design.cardShadow) }}>
    <div className="bento-editor-topbar">
      <div className="bento-editor-brand"><div className="bento-editor-kicker"><Sparkles size={13}/> TABLELY BENTO <span>VISUAL</span></div><h2>Design the exact page your audience sees.</h2><p>Every legacy feature and every new Bento widget lives on the same responsive canvas. Drag, resize, style and publish from one source of truth.</p></div>
      <div className="bento-editor-top-actions"><button type="button" className="bento-top-action" onClick={undo} disabled={!history.length}><Undo2 size={15}/> Undo</button><button type="button" className="bento-top-action" onClick={redo} disabled={!future.length}><Redo2 size={15}/> Redo</button><button type="button" className={`bento-preview-toggle ${mode === 'preview' ? 'active' : ''}`} onClick={() => setMode(mode === 'preview' ? 'edit' : 'preview')}><Eye size={15}/>{mode === 'preview' ? 'Back to edit' : 'Preview'}</button></div>
    </div>

    <div className="bento-command-bar"><button type="button" className={pushMode ? 'active' : ''} onClick={() => setPushMode(value => !value)} title="Push all widgets together"><Move size={14}/> Push</button>
      <div className="bento-command-group"><span className="bento-command-title">DEVICE</span>{([['desktop',Monitor],['tablet',Tablet],['mobile',Smartphone]] as const).map(([device, Icon]) => <button type="button" key={device} className={viewport === device ? 'active' : ''} onClick={() => setViewport(device as BentoViewport)}><Icon size={14}/>{device}</button>)}</div>
      <div className="bento-command-group"><span className="bento-command-title">ZOOM</span><button type="button" onClick={() => setZoom(Math.max(50, zoom - 10))}>−</button><span className="bento-zoom-readout">{zoom}%</span><button type="button" onClick={() => setZoom(Math.min(125, zoom + 10))}>+</button><button type="button" onClick={() => setZoom(100)}>Fit</button></div>
      <div className="bento-command-group"><button type="button" className={showGuides ? 'active' : ''} onClick={() => setShowGuides(value => !value)}><Grid2X2 size={14}/> Guides</button><button type="button" className={multiSelectMode ? 'active' : ''} onClick={() => setMultiSelectMode(value => !value)} title="Select multiple widgets"><Check size={14}/> Multi-select</button><button type="button" className={showArrange ? 'active' : ''} onClick={() => setShowArrange(value => !value)}><LayoutGrid size={14}/> Arrange <ChevronDown size={12}/></button><button type="button" className={pageInspectorOpen ? 'active' : ''} onClick={() => { setSelectedId(null); setSelectedIds([]); setPageInspectorOpen(true); }}><Palette size={14}/> Page</button></div>
    </div>

    {showArrange && <div className="bento-command-drawer"><div><b>Smart arrange</b><small>Change composition without losing content.</small></div><div className="bento-drawer-actions"><button type="button" onClick={() => smartArrange('pack')}>Pack tightly</button><button type="button" onClick={() => smartArrange('balance')}>Balance</button><button type="button" onClick={() => smartArrange('fill')}>Fill gaps</button><button type="button" onClick={() => smartArrange('rhythm')}>Create rhythm</button><button type="button" onClick={() => smartArrange('reset')}>Restore baseline</button></div><div className="bento-template-select"><select className="bento-input" value={templateKey} onChange={e => setTemplateKey(e.target.value)}>{Object.entries(TEMPLATES).map(([key, value]) => <option key={key} value={key}>{value.label} — {value.note}</option>)}</select><button type="button" className="bento-top-action" onClick={() => applyTemplate(templateKey)}><WandSparkles size={14}/> Apply template</button></div></div>}


    <div className="bento-add-rail"><div className="bento-add-label"><Plus size={14}/> ADD WIDGET</div><div className="bento-add-tools"><Search size={14}/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search widgets"/></div><div className="bento-add-scroll">{filteredTypes.map(({ type, label, hint, category }) => { const Icon = TYPE_ICONS[type]; return <button type="button" draggable className="bento-add-tile" key={type}
        onDragStart={event => { suppressAddClickRef.current = true; event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-tablely-bento-type', type); }}
        onDragEnd={() => { window.setTimeout(() => { suppressAddClickRef.current = false; }, 0); }}
        onClick={() => { if (suppressAddClickRef.current) { suppressAddClickRef.current = false; return; } addBlock(type); }}>
        <span className={`bento-add-icon bento-type-${type}`}><Icon size={17}/></span><span><b>{label}</b><small>{category} · {hint}</small></span></button>; })}</div></div>
    {!isValid && <div className="error-box bento-error">This legacy layout contains overlapping geometry. It will be normalized by the spatial engine when saved.</div>}
    <div className={`bento-workspace ${mode === 'preview' ? 'is-preview-mode' : ''}`}>
      <div className="bento-stage-column">
        <div className={`bento-stage-frame bento-preview-${viewport} ${mode === 'preview' ? 'is-public-stage' : ''}`}>
          <div className="bento-stage-toolbar"><div className="bento-stage-dots"><i/><i/><i/></div><span><Move size={13}/> {getDeviceLabel(viewport)} canvas · {BENTO_VIEWPORT_COLUMNS[viewport]} columns</span><div className="bento-stage-legend">{mode === 'edit' ? <><GripVertical size={13}/> Drag <Maximize2 size={13}/> Resize</> : <><Check size={13}/> Real public renderer</>}</div></div>
          {mode === 'preview' ? <BentoPublicPreviewFrame blocks={activeBlocks} design={design} viewport={viewport} storeId={storeId} shareUrl={shareUrl} zoom={zoom} /> : <div className="bento-canvas-viewport" style={{ width: `min(100%, ${previewWidth}px)`, marginLeft: design.pageAlignment === 'right' ? 'auto' : '0', marginRight: design.pageAlignment === 'left' ? 'auto' : '0', ...(design.pageAlignment === 'center' ? { marginLeft: 'auto', marginRight: 'auto' } : {}), transform: `scale(${zoom / 100})`, transformOrigin: 'top center', marginBottom: `${-(gridHeight * (1 - zoom / 100))}px` }}>
            <div ref={stageRef} className={`bento-editor-stage ${showGuides ? 'show-guides' : ''} ${isAddDragOver ? 'is-add-drop-target' : ''}`} data-bento-viewport={viewport} style={{ ...gridCss, background: getBentoPageBackground(design), ['--bento-row-height' as string]: `${rowHeight}px` }} onDragEnter={event => { const type = event.dataTransfer.getData('application/x-tablely-bento-type') as BentoBlockType; if (!event.dataTransfer.types.includes('application/x-tablely-bento-type')) return; event.preventDefault(); addDragDepthRef.current += 1; setIsAddDragOver(true); updateAddDropPreview(type, event); }} onDragOver={event => { const type = event.dataTransfer.getData('application/x-tablely-bento-type') as BentoBlockType; if (event.dataTransfer.types.includes('application/x-tablely-bento-type')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; updateAddDropPreview(type, event); } }} onDragLeave={event => { if (event.dataTransfer.types.includes('application/x-tablely-bento-type')) { addDragDepthRef.current = Math.max(0, addDragDepthRef.current - 1); if (!addDragDepthRef.current) { setIsAddDragOver(false); setAddDropPreview(null); } } }} onDrop={event => { const type = event.dataTransfer.getData('application/x-tablely-bento-type') as BentoBlockType; addDragDepthRef.current = 0; setIsAddDragOver(false); setAddDropPreview(null); if (!type || !BENTO_TYPES.some(item => item.type === type)) return; event.preventDefault(); addBlock(type, { clientX: event.clientX, clientY: event.clientY }); }} onDragStart={event => { event.preventDefault(); }} onContextMenu={event => { event.preventDefault(); }} onPointerMove={event => { updateInteraction(event); const rect = stageRef.current?.getBoundingClientRect(); if (rect) { event.currentTarget.style.setProperty('--cursor-x', `${event.clientX - rect.left}px`); event.currentTarget.style.setProperty('--cursor-y', `${event.clientY - rect.top}px`); } }} onPointerDown={event => { const target = event.target instanceof Element ? event.target.closest('[data-bento-id]') as HTMLElement | null : null; const id = target?.dataset.bentoId; if (!id) { setSelectedId(null); return; } const resizeHandle = event.target instanceof Element ? event.target.closest('[data-resize-direction]') as HTMLElement | null : null; const dragHandle = event.target instanceof Element ? event.target.closest('[data-drag-handle]') as HTMLElement | null : null; if (resizeHandle) startResize(event, id, resizeHandle.dataset.resizeDirection as ResizeDirection); else if (dragHandle) startDrag(event, id, true); else startDrag(event, id); }} onPointerUp={finishInteraction} onPointerCancel={finishInteraction} onLostPointerCapture={finishInteraction}>
              <div className="bento-stage-grid-glow" aria-hidden="true"/>
              {layout.map((item, animationIndex) => { const block = activeBlockById.get(item.id); if (!block) return null; const selected = selectedIds.includes(block.id); const activeInteraction = dragState?.id === block.id || resizeState?.id === block.id; return <div key={block.id} className={`bento-editor-layer ${selected ? 'selected' : ''} ${activeInteraction ? 'interacting' : ''} ${dragState?.id === block.id ? 'dragging' : ''} ${resizeState?.id === block.id ? 'resizing' : ''}`} data-bento-id={block.id} style={{ gridColumn: `${item.column} / span ${item.columnSpan}`, gridRow: `${item.row} / span ${item.rowSpan}` }} onClick={event => { event.preventDefault(); event.stopPropagation(); setPageInspectorOpen(false); selectBlock(block.id, event.shiftKey); }}>
                <BentoBlockView block={block} storeId={storeId} interactive={false} editor viewport={viewport} globalCardRadius={design.cardRadius} globalCursorFx={design.cursorFx} animationIndex={animationIndex} layoutMode="flow" />{selected && <button type="button" className="bento-selected-delete" aria-label={`Delete ${labelForBlock(block)}`} title="Delete widget" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); removeBlock(block.id); }}><Trash2 size={13}/></button>}
                {selected && <div className="bento-editor-overlay" aria-label={`${labelForBlock(block)} editor controls`}><span className="bento-select-pill">{labelForBlock(block)}</span><span className="bento-size-readout">{item.columnSpan} × {item.rowSpan}</span>{!block.locked && !block.lockPosition && <span className="bento-drag-handle" data-drag-handle role="button" tabIndex={-1} title="Drag to move this block" aria-label="Drag to move this block"><GripVertical size={14}/></span>}{!block.locked && !block.lockSize && (['nw','ne','sw','se'] as ResizeDirection[]).map(direction => <i key={direction} data-resize-direction={direction} className={`bento-corner-handle ${direction}`} />)}<div className="bento-move-dock"><button type="button" aria-label="Move layer left" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); nudge(block.id,'ArrowLeft',1); }}><ArrowLeft size={12}/></button><button type="button" aria-label="Move layer up" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); nudge(block.id,'ArrowUp',1); }}><ArrowUp size={12}/></button><button type="button" aria-label="Move layer down" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); nudge(block.id,'ArrowDown',1); }}><ArrowDown size={12}/></button><button type="button" aria-label="Move layer right" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); nudge(block.id,'ArrowRight',1); }}><ArrowRight size={12}/></button></div></div>}
              </div>; })}
              {addDropPreview && <div className="bento-add-drop-preview" style={{ gridColumn: `${addDropPreview.geometry.column} / span ${addDropPreview.geometry.columnSpan}`, gridRow: `${addDropPreview.geometry.row} / span ${addDropPreview.geometry.rowSpan}` }} aria-hidden="true"><Plus size={16}/><span>{BENTO_TYPES.find(item => item.type === addDropPreview.type)?.label || 'Widget'}</span></div>}
              {!layout.length && <div className="bento-empty-canvas"><div className="bento-empty-orbit"><Sparkles size={23}/></div><strong>Your canvas is empty</strong><span>Add a widget to begin, or drag one here.</span></div>}
            </div>
          </div>}
        </div>
        <div className="bento-stage-caption"><span>{mode === 'edit' ? 'Drag widgets from the add rail onto the canvas. Use the move handle on touch devices so vertical swipes remain scroll gestures.' : 'Preview uses the actual public renderer inside an isolated responsive viewport.'}</span><span>{interactionFeedback?.snapped ? `Snapped ${interactionFeedback.type === 'resize' ? 'resize' : 'move'} to avoid overlap` : `${layout.length} widget${layout.length === 1 ? '' : 's'} · ${isValid ? 'No overlaps' : 'Repair needed'}`}</span></div>
      </div>
      {selectedBlock && mode === 'edit' ? <BlockInspector block={selectedBlock} viewport={viewport} currentBlocks={currentBlocksRef.current} onUpdate={patch => updateBlock(selectedBlock.id, patch)} onDuplicate={() => duplicateBlock(selectedBlock.id)} onDelete={() => removeBlock(selectedBlock.id)} onClose={() => setSelectedId(null)} onUploadMedia={onUploadMedia} profileMediaEditor={profileMediaEditor} linksEditor={linksEditor} globalCardRadius={design.cardRadius}/> : pageInspectorOpen && mode === 'edit' ? <PageInspector design={design} onUpdate={updateDesign} onClose={() => setPageInspectorOpen(false)}/> : <aside className="bento-inspector bento-inspector-empty"><div className="bento-empty-orbit"><Sparkles size={23}/></div><h3>{mode === 'preview' ? 'Public preview' : 'Select a widget'}</h3><p>{mode === 'preview' ? 'This is the published renderer with editing chrome removed.' : 'Select a widget for node controls, or use Page for global design settings.'}</p></aside>}
    </div>

    <div className="bento-layer-strip"><div className="bento-layer-head"><div><span>LAYERS</span><small>Every visible page section is now a node in the same spatial document.</small></div><span>{blocks.length}/120</span></div><div className="bento-layer-list" onPointerMove={moveLayerTouchDrag} onPointerUp={finishLayerTouchDrag} onPointerCancel={finishLayerTouchDrag} onContextMenu={event => event.preventDefault()}>{blocks.map((block, index) => { const Icon = TYPE_ICONS[block.type]; return <div key={block.id} data-layer-id={block.id} draggable className={`bento-layer-item ${selectedId === block.id ? 'active' : ''} ${block.enabled ? '' : 'muted'}`} onDragStart={event => { event.dataTransfer.setData('application/x-tablely-bento-layer', block.id); }} onDragOver={event => { if (event.dataTransfer.types.includes('application/x-tablely-bento-layer')) event.preventDefault(); }} onDrop={event => { const sourceId = event.dataTransfer.getData('application/x-tablely-bento-layer'); if (sourceId) reorderLayer(sourceId, block.id); }} onClick={() => { setPageInspectorOpen(false); setSelectedId(block.id); }}><button type="button" className="bento-layer-grip" title="Drag to reorder" aria-label="Drag to reorder layer" onPointerDown={event => beginLayerTouchDrag(event, block.id)}><GripVertical size={14}/></button><span className={`bento-layer-icon bento-type-${block.type}`}><Icon size={14}/></span><span className="bento-layer-copy"><b>{labelForBlock(block)}</b><small>{block.systemKey ? 'system' : block.type} · {getBentoGeometry(block, viewport).columnSpan}×{getBentoGeometry(block, viewport).rowSpan}</small></span><span className="bento-layer-actions"><button type="button" onClick={e => { e.stopPropagation(); moveLayer(block.id,-1); }} title="Move up" aria-label="Move layer up"><ArrowUp size={12}/></button><button type="button" onClick={e => { e.stopPropagation(); moveLayer(block.id,1); }} title="Move down" aria-label="Move layer down"><ArrowDown size={12}/></button><button type="button" onClick={e => { e.stopPropagation(); updateBlock(block.id,{locked:!block.locked}); }} title={block.locked ? 'Unlock' : 'Lock'} aria-label={block.locked ? 'Unlock layer' : 'Lock layer'}>{block.locked ? <Lock size={12}/> : <Unlock size={12}/>}</button><button type="button" onClick={e => { e.stopPropagation(); updateBlock(block.id,{enabled:!block.enabled}); }} title={block.enabled ? 'Hide' : 'Show'} aria-label={block.enabled ? 'Hide layer' : 'Show layer'}>{block.enabled ? <EyeOff size={12}/> : <Eye size={12}/>}</button></span></div>; })}</div></div>
    {marquee && <div className="bento-marquee-selection" style={{ left: Math.min(marquee.startX, marquee.currentX), top: Math.min(marquee.startY, marquee.currentY), width: Math.abs(marquee.currentX - marquee.startX), height: Math.abs(marquee.currentY - marquee.startY) }} aria-hidden="true"/>}
    <div className="bento-editor-footer"><span><Settings2 size={13}/> Ctrl/Cmd+Z undo · Ctrl/Cmd+D duplicate · Arrow keys move · Multi-select supports click and drag selection</span><span><SaveBadge/> Saved through the existing Link Hub save flow.</span></div>
  </section>;
}

function SaveBadge() { return <span className="bento-save-badge"><span/> Ready to save</span>; }
