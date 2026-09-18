'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ImagePlus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { BRAND_ASSET_BUCKET, validateLogoImage } from '@/lib/brand-assets';

type BrandSettings = { logo_url: string | null; logo_path: string | null };

export default function AdminBrandingPage() {
  const supabase = getSupabaseBrowserClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [brand, setBrand] = useState<BrandSettings>({ logo_url: null, logo_path: null });
  const [preview, setPreview] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    void supabase.rpc('admin_get_platform_brand').then(({ data, error }) => {
      if (error) setMessage(error.message);
      else if (data) setBrand(data as BrandSettings);
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
    const { data, error } = await supabase.rpc('admin_update_platform_brand', { p_logo_url: preview, p_logo_path: pendingPath ?? brand.logo_path });
    if (error) setMessage(error.message);
    else if (data) { setBrand(data as BrandSettings); setPreview(null); setPendingPath(null); window.dispatchEvent(new Event('tablely-brand-change')); setMessage('Global Tablely logo updated everywhere.'); }
    setBusy(false);
  }

  async function remove() {
    if (!supabase) return;
    setBusy(true); setMessage(null);
    const { error } = await supabase.rpc('admin_update_platform_brand', { p_logo_url: null, p_logo_path: null });
    if (error) setMessage(error.message);
    else { setBrand({ logo_url: null, logo_path: null }); setPreview(null); setPendingPath(null); window.dispatchEvent(new Event('tablely-brand-change')); setMessage('Global logo removed.'); }
    setBusy(false);
  }

  if (loading) return <main className="admin-page"><div className="setup-loading">Loading brand controls…</div></main>;
  const displayedLogo = preview ?? brand.logo_url;
  return <main className="admin-page"><header className="admin-top"><div><Link href="/admin" className="back-link"><ArrowLeft size={15}/> Admin dashboard</Link><span className="eyebrow">GLOBAL BRAND</span><h1>Tablely logo</h1><p>Change the logo used by the landing page, restaurant workspace, authentication screens and customer-facing Tablely surfaces.</p></div></header>{message ? <div className="notice notice-info">{message}</div> : null}<section className="surface-card admin-branding-card"><div className="global-logo-preview">{displayedLogo ? <img src={displayedLogo} alt="Current Tablely logo" /> : <span className="brand-mark">T</span>}</div><div><h2>Global logo asset</h2><p>Upload an SVG, JPG, PNG, or WebP file up to 5 MB. Transparent SVG or PNG files work best.</p><input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void chooseFile(file); event.target.value = ''; }} /><div className="button-row"><button className="button button-primary" disabled={busy} onClick={() => inputRef.current?.click()}><ImagePlus size={15}/> Choose logo</button><button className="button button-light" disabled={busy || !displayedLogo} onClick={()=>void save()}><Save size={15}/> Save logo</button><button className="button button-danger" disabled={busy || !brand.logo_url} onClick={()=>void remove()}><Trash2 size={15}/> Remove</button></div></div></section></main>;
}
