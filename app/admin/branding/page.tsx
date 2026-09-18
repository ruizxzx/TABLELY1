'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ImagePlus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { BRAND_ASSET_BUCKET, validateLogoImage } from '@/lib/brand-assets';
import { notifyPlatformBrandChange } from '@/components/Brand';

type BrandSettings = { logo_url: string | null; logo_path: string | null; site_title: string | null };

export default function AdminBrandingPage() {
  const supabase = getSupabaseBrowserClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [brand, setBrand] = useState<BrandSettings>({ logo_url: null, logo_path: null, site_title: 'Tablely — Restaurant Ordering OS' });
  const [preview, setPreview] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [siteTitle, setSiteTitle] = useState('Tablely — Restaurant Ordering OS');

  useEffect(() => {
    if (!supabase) return;
    void supabase.rpc('admin_get_platform_brand').then(({ data, error }) => {
      if (error) setMessage(error.message);
      else if (data) { const next = data as BrandSettings; setBrand(next); setSiteTitle(next.site_title ?? 'Tablely — Restaurant Ordering OS'); }
      setLoading(false);
    });
  }, [supabase]);

  async function chooseFile(file: File) {
    if (!supabase) return;
    const validationError = validateLogoImage(file);
    if (validationError) { setMessage(validationError); return; }
    setBusy(true); setMessage(null);
    const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : file.type === 'image/svg+xml' ? 'svg' : 'jpg';
    const path = `platform/logo-${crypto.randomUUID()}.${extension}`;
    const { error } = await supabase.storage.from(BRAND_ASSET_BUCKET).upload(path, file, { cacheControl: '31536000', contentType: file.type, upsert: false });
    if (error) { setMessage(error.message); setBusy(false); return; }
    const { data } = supabase.storage.from(BRAND_ASSET_BUCKET).getPublicUrl(path);
    setPreview(data.publicUrl); setPendingPath(path); setBusy(false);
  }

  async function save() {
    if (!supabase) return;
    setBusy(true); setMessage(null);
    const { data, error } = await supabase.rpc('admin_update_platform_brand', { p_logo_url: preview ?? brand.logo_url, p_logo_path: pendingPath ?? brand.logo_path, p_site_title: siteTitle });
    if (error) setMessage(error.message);
    else if (data) { const next = data as BrandSettings; setBrand(next); setSiteTitle(next.site_title ?? 'Tablely — Restaurant Ordering OS'); setPreview(null); setPendingPath(null); notifyPlatformBrandChange(); setMessage('Global Tablely branding updated everywhere.'); }
    setBusy(false);
  }

  async function remove() {
    if (!supabase) return;
    setBusy(true); setMessage(null);
    const { error } = await supabase.rpc('admin_update_platform_brand', { p_logo_url: null, p_logo_path: null });
    if (error) setMessage(error.message);
    else { setBrand({ logo_url: null, logo_path: null, site_title: siteTitle }); setPreview(null); setPendingPath(null); notifyPlatformBrandChange(); setMessage('Global logo removed.'); }
    setBusy(false);
  }

  if (loading) return <main className="admin-page"><div className="setup-loading">Loading brand controls…</div></main>;
  const displayedLogo = preview ?? brand.logo_url;
  return (
    <main className="admin-page">
      <header className="admin-top">
        <div>
          <Link href="/admin" className="back-link"><ArrowLeft size={15}/> Admin dashboard</Link>
          <span className="eyebrow">GLOBAL BRAND</span>
          <h1>Tablely branding</h1>
          <p>Control the global Tablely logo and browser/site title used across the platform.</p>
        </div>
      </header>
      {message ? <div className="notice notice-info">{message}</div> : null}
      <section className="surface-card admin-branding-card">
        <div className="global-logo-preview">{displayedLogo ? <img src={displayedLogo} alt="Current Tablely logo" /> : <span className="brand-mark">T</span>}</div>
        <div>
          <h2>Global logo asset</h2>
          <p>Upload an SVG, JPG, PNG, or WebP file up to 5 MB. This logo is used by the public Tablely brand surfaces and browser favicon.</p>
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void chooseFile(file); event.target.value = ''; }} />
          <div className="button-row">
            <button className="button button-primary" disabled={busy} onClick={() => inputRef.current?.click()}><ImagePlus size={15}/> Choose logo</button>
            <button className="button button-light" disabled={busy} onClick={()=>void save()}><Save size={15}/> Save branding</button>
            <button className="button button-danger" disabled={busy || !brand.logo_url} onClick={()=>void remove()}><Trash2 size={15}/> Remove logo</button>
          </div>
          <label style={{ marginTop: 16 }}>
            Browser / site title
            <input value={siteTitle} maxLength={140} onChange={event => setSiteTitle(event.target.value)} placeholder="Tablely — Restaurant Ordering OS" />
            <small>Controls the title shown in the browser tab. Changes also update the live favicon to the same global logo.</small>
          </label>
        </div>
      </section>
    </main>
  );
}
