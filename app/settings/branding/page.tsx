'use client';
import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Palette, RotateCcw, Save, Trash2, UploadCloud } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { removeBrandLogo, uploadBrandLogo, validateLogoImage } from '@/lib/brand-assets';

const DEFAULTS = { logo: '', logoPath: '', primary: '#111111', secondary: '#f5f5f5', accent: '#ee7c30', theme: 'minimal', header: '' };
const BRANCH_LOGO_DEFAULTS = { logo: '', logoPath: '' };

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

  // Branch-specific logo override: shown for restaurants with more than one
  // branch. When "custom" is off, the branch simply uses the organization
  // default logo above — nothing extra to save.
  const [branchId, setBranchId] = useState<string | null>(null);
  const [branchName, setBranchName] = useState('');
  const [multiBranch, setMultiBranch] = useState(false);
  const [useCustomBranchLogo, setUseCustomBranchLogo] = useState(false);
  const [bv, setBv] = useState(BRANCH_LOGO_DEFAULTS);
  const [branchDragging, setBranchDragging] = useState(false);
  const [branchUploading, setBranchUploading] = useState(false);
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branchOk, setBranchOk] = useState(false);
  const branchFileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    if (!supabase) return;
    const c = await getCurrentRestaurantContext(supabase);
    if (!c.data) { setError(c.error?.message ?? 'Workspace not found.'); setLoading(false); return; }
    setOrgId(c.data.organization.id);
    setBranchId(c.data.branch.id);
    setBranchName(c.data.branch.name);
    setMultiBranch(c.data.branches.length > 1);
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
    const { data: branchBrand, error: be } = await supabase.rpc('get_effective_branch_brand', { p_branch_id: c.data.branch.id });
    const branchRow = Array.isArray(branchBrand) ? branchBrand[0] : branchBrand;
    if (!be && branchRow) {
      setUseCustomBranchLogo(Boolean(branchRow.branch_logo_url));
      setBv({ logo: branchRow.branch_logo_url ?? '', logoPath: branchRow.branch_logo_path ?? '' });
    }
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
    if (e) setError(e.message); else { setOk(true); window.dispatchEvent(new Event('tablely-restaurant-brand-change')); }
    setBusy(false);
  }

  async function handleBranchFile(file: File | null | undefined) {
    if (!file || !supabase || !orgId) return;
    const validationError = validateLogoImage(file);
    if (validationError) { setBranchError(validationError); return; }
    setBranchError(null);
    setBranchUploading(true);
    try {
      const previousPath = bv.logoPath;
      const { path, publicUrl } = await uploadBrandLogo(supabase, orgId, file);
      setBv({ logo: publicUrl, logoPath: path });
      if (previousPath) await removeBrandLogo(supabase, previousPath).catch(() => {});
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : 'Logo upload failed.');
    } finally {
      setBranchUploading(false);
    }
  }

  async function handleRemoveBranchLogo() {
    if (!supabase) return;
    if (bv.logoPath) { setBranchUploading(true); await removeBrandLogo(supabase, bv.logoPath).catch(() => {}); setBranchUploading(false); }
    setBv(BRANCH_LOGO_DEFAULTS);
  }

  async function saveBranchLogo() {
    if (!supabase || !branchId) return;
    setBranchBusy(true); setBranchOk(false); setBranchError(null);
    // Switching back to "organization default" clears the override outright,
    // regardless of whatever was left in the upload fields.
    const logo = useCustomBranchLogo ? bv.logo.trim() || null : null;
    const logoPath = useCustomBranchLogo ? bv.logoPath.trim() || null : null;
    const { error: e } = await supabase.rpc('update_branch_logo', {
      p_branch_id: branchId,
      p_logo_url: logo,
      p_logo_path: logoPath,
    });
    if (e) setBranchError(e.message); else { setBranchOk(true); window.dispatchEvent(new Event('tablely-restaurant-brand-change')); }
    setBranchBusy(false);
  }

  if (loading) return <StudioShell><div className="setup-loading">Loading branding…</div></StudioShell>;

  const effectiveLogo = (multiBranch && useCustomBranchLogo && bv.logo) ? bv.logo : v.logo;

  return (
    <StudioShell>
      <SectionHeader eyebrow="BRAND" title="Branding studio" description="Control the identity customers see on your menu and ordering flow." />
      {error ? <div className="notice notice-error">{error}</div> : null}
      {ok ? <div className="notice notice-success">Branding saved.</div> : null}
      <div className="branding-grid">
        <section className="surface-card settings-card branding-form">
          <div className="card-heading">
            <div><h2>Brand assets</h2><p>Restaurant logo, color system and customer-facing theme.{multiBranch ? ' This is the default logo used by every branch that has not set its own.' : ''}</p></div>
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
            <div className="preview-logo" style={{ background: effectiveLogo ? 'transparent' : v.primary }}>
              {effectiveLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={effectiveLogo} alt="" className="preview-logo-img" />
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

        {multiBranch ? (
          <section className="surface-card settings-card branding-form">
            <div className="card-heading">
              <div><h2>Logo for {branchName}</h2><p>Give this branch its own logo, or keep it in sync with the organization default above.</p></div>
              <Palette size={18} />
            </div>

            {branchError ? <div className="notice notice-error">{branchError}</div> : null}
            {branchOk ? <div className="notice notice-success">Branch logo saved.</div> : null}

            <div className="button-row" role="radiogroup" aria-label="Logo source for this branch">
              <button
                type="button"
                className={`button ${useCustomBranchLogo ? 'button-light' : 'button-primary'}`}
                onClick={() => setUseCustomBranchLogo(false)}
              >
                Use organization default
              </button>
              <button
                type="button"
                className={`button ${useCustomBranchLogo ? 'button-primary' : 'button-light'}`}
                onClick={() => setUseCustomBranchLogo(true)}
              >
                Use a different logo for this branch
              </button>
            </div>

            {useCustomBranchLogo ? (
              <>
                <label>Branch logo</label>
                <div
                  className={`logo-dropzone${branchDragging ? ' logo-dropzone-active' : ''}`}
                  onClick={() => branchFileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setBranchDragging(true); }}
                  onDragLeave={() => setBranchDragging(false)}
                  onDrop={(e) => { e.preventDefault(); setBranchDragging(false); void handleBranchFile(e.dataTransfer.files?.[0]); }}
                >
                  {bv.logo ? (
                    <div className="logo-dropzone-preview">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={bv.logo} alt={`${branchName} logo`} />
                    </div>
                  ) : (
                    <div className="logo-dropzone-empty">
                      <UploadCloud size={22} />
                      <span>{branchUploading ? 'Uploading…' : 'Click or drag an image to upload'}</span>
                      <small>JPG, PNG, WebP, or SVG — up to 5 MB</small>
                    </div>
                  )}
                  <input
                    ref={branchFileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/svg+xml"
                    className="logo-dropzone-input"
                    onChange={(e) => { void handleBranchFile(e.target.files?.[0]); e.currentTarget.value = ''; }}
                  />
                </div>
                <div className="button-row">
                  <button type="button" className="button button-light" onClick={() => branchFileInputRef.current?.click()} disabled={branchUploading}>
                    <ImageIcon size={15} /> {bv.logo ? 'Replace logo' : 'Upload logo'}
                  </button>
                  {bv.logo ? (
                    <button type="button" className="button button-light" onClick={() => void handleRemoveBranchLogo()} disabled={branchUploading}>
                      <Trash2 size={15} /> Remove logo
                    </button>
                  ) : null}
                </div>
                <label>Or paste a logo URL
                  <input
                    value={bv.logo}
                    onChange={(e) => setBv({ logo: e.target.value, logoPath: '' })}
                    placeholder="https://…/branch-logo.png"
                  />
                </label>
              </>
            ) : (
              <p className="field-hint">{branchName} will show the organization default logo above.</p>
            )}

            <div className="button-row">
              <button className="button button-primary" onClick={() => void saveBranchLogo()} disabled={branchBusy || branchUploading}>
                <Save size={15} />{branchBusy ? 'Saving…' : 'Save branch logo'}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </StudioShell>
  );
}
