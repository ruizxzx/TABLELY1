'use client';
import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Palette, RotateCcw, Save, Trash2, UploadCloud } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { removeBrandLogo, uploadBrandLogo, validateLogoImage } from '@/lib/brand-assets';

const DEFAULTS = { logo: '', logoPath: '', primary: '#111111', secondary: '#f5f5f5', accent: '#ee7c30', theme: 'minimal', header: '' };

export default function BrandingPage() {
  const supabase = getSupabaseBrowserClient();
  const [v, setV] = useState(DEFAULTS);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    if (!supabase) return;
    const c = await getCurrentRestaurantContext(supabase);
    if (!c.data) { setError(c.error?.message ?? 'Workspace not found.'); setLoading(false); return; }
    setOrgId(c.data.organization.id);
    const { data, error: e } = await supabase.from('organizations')
      .select('brand_logo_url,brand_logo_path,brand_primary_color,brand_secondary_color,brand_accent_color,customer_theme,brand_menu_header')
      .eq('id', c.data.organization.id).single();
    if (e) setError(e.message);
    else if (data) setV({
      logo: data.brand_logo_url ?? '',
      logoPath: data.brand_logo_path ?? '',
      primary: data.brand_primary_color ?? '#111111',
      secondary: data.brand_secondary_color ?? '#f5f5f5',
      accent: data.brand_accent_color ?? '#ee7c30',
      theme: data.customer_theme ?? 'minimal',
      header: data.brand_menu_header ?? '',
    });
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function handleFile(file: File | null | undefined) {
    if (!file || !supabase || !orgId) return;
    const validationError = validateLogoImage(file);
    if (validationError) { setError(validationError); return; }
    setError(null);
    setUploading(true);
    try {
      const previousPath = v.logoPath;
      const { path, publicUrl } = await uploadBrandLogo(supabase, orgId, file);
      setV((prev) => ({ ...prev, logo: publicUrl, logoPath: path }));
      // Best-effort cleanup of the previous uploaded file; a bare external
      // URL never has a logoPath, so this only fires for prior uploads.
      if (previousPath) await removeBrandLogo(supabase, previousPath).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Logo upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function handleRemoveLogo() {
    if (!supabase) return;
    if (v.logoPath) { setUploading(true); await removeBrandLogo(supabase, v.logoPath).catch(() => {}); setUploading(false); }
    setV((prev) => ({ ...prev, logo: '', logoPath: '' }));
  }

  async function save() {
    if (!supabase) return;
    const c = await getCurrentRestaurantContext(supabase);
    if (!c.data) return;
    setBusy(true); setOk(false); setError(null);
    const { error: e } = await supabase.rpc('update_build12_branding', {
      p_org_id: c.data.organization.id,
      p_logo_url: v.logo.trim() || null,
      p_logo_path: v.logoPath.trim() || null,
      p_primary_color: v.primary,
      p_secondary_color: v.secondary,
      p_accent_color: v.accent,
      p_customer_theme: v.theme,
      p_menu_header: v.header.trim() || null,
    });
    if (e) setError(e.message); else setOk(true);
    setBusy(false);
  }

  if (loading) return <StudioShell><div className="setup-loading">Loading branding…</div></StudioShell>;

  return (
    <StudioShell>
      <SectionHeader eyebrow="BRAND" title="Branding studio" description="Control the identity customers see on your menu and ordering flow." />
      {error ? <div className="notice notice-error">{error}</div> : null}
      {ok ? <div className="notice notice-success">Branding saved.</div> : null}
      <div className="branding-grid">
        <section className="surface-card settings-card branding-form">
          <div className="card-heading">
            <div><h2>Brand assets</h2><p>Restaurant logo, color system and customer-facing theme.</p></div>
            <Palette size={18} />
          </div>

          <label>Logo</label>
          <div
            className={`logo-dropzone${dragging ? ' logo-dropzone-active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); void handleFile(e.dataTransfer.files?.[0]); }}
          >
            {v.logo ? (
              <div className="logo-dropzone-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.logo} alt="Restaurant logo" />
              </div>
            ) : (
              <div className="logo-dropzone-empty">
                <UploadCloud size={22} />
                <span>{uploading ? 'Uploading…' : 'Click or drag an image to upload'}</span>
                <small>JPG, PNG, WebP, or SVG — up to 5 MB</small>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/svg+xml"
              className="logo-dropzone-input"
              onChange={(e) => { void handleFile(e.target.files?.[0]); e.currentTarget.value = ''; }}
            />
          </div>
          <div className="button-row">
            <button type="button" className="button button-light" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              <ImageIcon size={15} /> {v.logo ? 'Replace logo' : 'Upload logo'}
            </button>
            {v.logo ? (
              <button type="button" className="button button-light" onClick={() => void handleRemoveLogo()} disabled={uploading}>
                <Trash2 size={15} /> Remove logo
              </button>
            ) : null}
          </div>

          <label>Or paste a logo URL
            <input
              value={v.logo}
              onChange={(e) => setV({ ...v, logo: e.target.value, logoPath: '' })}
              placeholder="https://…/logo.png"
            />
          </label>

          <label>Menu header
            <input value={v.header} onChange={(e) => setV({ ...v, header: e.target.value })} maxLength={140} placeholder="Authentic Bengali Kitchen" />
          </label>

          <div className="color-grid">
            <label>Primary<input type="color" value={v.primary} onChange={(e) => setV({ ...v, primary: e.target.value })} /><code>{v.primary}</code></label>
            <label>Secondary<input type="color" value={v.secondary} onChange={(e) => setV({ ...v, secondary: e.target.value })} /><code>{v.secondary}</code></label>
            <label>Accent<input type="color" value={v.accent} onChange={(e) => setV({ ...v, accent: e.target.value })} /><code>{v.accent}</code></label>
          </div>

          <label>Customer theme
            <select className="field-select" value={v.theme} onChange={(e) => setV({ ...v, theme: e.target.value })}>
              <option value="minimal">Minimal</option>
              <option value="warm">Warm</option>
              <option value="bold">Bold</option>
            </select>
          </label>

          <div className="button-row">
            <button className="button button-primary" onClick={() => void save()} disabled={busy || uploading}>
              <Save size={15} />{busy ? 'Saving…' : 'Save branding'}
            </button>
            <button className="button button-light" onClick={() => setV(DEFAULTS)}>
              <RotateCcw size={15} /> Reset draft
            </button>
          </div>
        </section>

        <section className="surface-card brand-preview" style={{ background: v.secondary }}>
          <div className="preview-brand">
            <div className="preview-logo" style={{ background: v.logo ? 'transparent' : v.primary }}>
              {v.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.logo} alt="" className="preview-logo-img" />
              ) : 'T'}
            </div>
            <div><strong style={{ color: v.primary }}>Your restaurant</strong><span>{v.header || 'Customer menu preview'}</span></div>
          </div>
          <div className="preview-menu-card">
            <div className="preview-pill" style={{ background: v.accent }}>TABLE 12</div>
            <h3>Menu</h3>
            <div className="preview-item"><div><strong>Butter Chicken</strong><span>Rich tomato gravy</span></div><b>₹349</b></div>
            <div className="preview-item"><div><strong>Paneer Tikka</strong><span>Charred cottage cheese</span></div><b>₹299</b></div>
          </div>
        </section>
      </div>
    </StudioShell>
  );
}
