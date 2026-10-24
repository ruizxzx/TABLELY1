'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, Check, CheckCircle2, FileSpreadsheet, FileText, Loader2, Sparkles, Upload, AlertTriangle, History, RotateCcw } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';

type Draft = { name: string; description: string | null; category: string; price: number | null; is_veg: boolean | null; confidence: number; variants: { name: string; price_delta: number }[]; modifier_groups: { name: string; description: string | null; is_required: boolean; selection_mode: 'SINGLE' | 'MULTI'; min_select: number; max_select: number; modifiers: { name: string; description: string | null; price_delta: number }[] }[]; selected: boolean; warnings: string[] };
type Job = { id: string; source_filename: string; status: string; extracted_count: number; imported_count: number; selected_count: number; skipped_duplicate_count: number; rejected_count: number; error_message: string | null; created_at: string };

export default function MenuImportPage() {
  const [context, setContext] = useState<CurrentRestaurantContext | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [items, setItems] = useState<Draft[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stage, setStage] = useState<'upload' | 'preview' | 'complete'>('upload');
  const [showHistory, setShowHistory] = useState(false);
  const [fromOnboarding, setFromOnboarding] = useState(false);

  async function loadHistory(branchId?: string) {
    const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
    const response = await fetch(`/api/menu-import/jobs${query}`, { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (response.ok) setJobs((body.jobs ?? []) as Job[]);
  }

  useEffect(() => {
    setFromOnboarding(new URLSearchParams(window.location.search).get('from') === 'onboarding');
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    void getCurrentRestaurantContext(supabase).then(async (result) => {
      if (result.error || !result.data) { setError(result.error?.message ?? 'Restaurant workspace not found.'); setLoading(false); return; }
      setContext(result.data);
      await loadHistory(result.data.branch.id);
      setLoading(false);
    });
  }, []);

  function updateItem(index: number, patch: Partial<Draft>) {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  async function parseFile() {
    if (!file || !context) { setError('Choose a menu file first.'); return; }
    setBusy(true); setError(null); setNotice(null); setItems([]); setJobId(null);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('branchId', context.branch.id);
      const response = await fetch('/api/menu-import/parse', { method: 'POST', body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not extract the menu.');
      setItems((body.items ?? []) as Draft[]);
      setJobId(String(body.jobId));
      setStage('preview');
      setNotice(`${body.count ?? 0} menu item(s) extracted. Review the details before importing.`);
      await loadHistory(context.branch.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Menu extraction failed.'); }
    finally { setBusy(false); }
  }

  async function commitImport() {
    if (!jobId || !context) return;
    const selected = items.filter((item) => item.selected);
    if (!selected.length) { setError('Select at least one menu item to import.'); return; }
    const invalid = selected.find((item) => !item.name.trim() || item.price === null || !Number.isFinite(Number(item.price)) || Number(item.price) < 0 || Number(item.price) > 9_999_999_999.99);
    if (invalid) { setError(`Review the name and price for “${invalid.name || 'unnamed item'}” before importing.`); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch('/api/menu-import/commit', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, branchId: context.branch.id, items: selected }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Could not import the selected menu items.');
      setStage('complete');
      setNotice(`${body.result?.imported ?? selected.length} item(s) imported as inactive drafts. Duplicates skipped: ${body.result?.skipped_duplicates ?? 0}. Activate reviewed items in Menu when ready.`);
      await loadHistory(context.branch.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Menu import failed.'); }
    finally { setBusy(false); }
  }

  function reset() { setFile(null); setItems([]); setJobId(null); setStage('upload'); setError(null); setNotice(null); }

  if (loading) return <StudioShell><div className="setup-loading">Loading menu importer…</div></StudioShell>;
  return <StudioShell>
    <SectionHeader eyebrow="MENU 2.0 · IMPORT" title="AI Menu Importer" description="Import a menu from a spreadsheet, searchable PDF or photograph. TABLELY never publishes extracted items automatically." action={<Link className="button button-light" href={fromOnboarding ? "/onboarding" : "/menu"}><ArrowLeft size={15}/> {fromOnboarding ? "Back to setup" : "Back to menu"}</Link>} />
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    {notice ? <div className="notice notice-info" role="status">{notice}</div> : null}

    {stage === 'upload' ? <section className="surface-card menu-import-upload">
      <div className="menu-import-intro"><div className="menu-import-icon"><Sparkles size={22}/></div><div><span className="eyebrow">IMPORT YOUR EXISTING MENU</span><h2>From file to editable menu.</h2><p>Upload a menu. TABLELY extracts item names, categories, prices and available dietary information into a reviewable draft.</p></div></div>
      <label className="menu-import-drop"><input type="file" accept=".pdf,.xlsx,.csv,.jpg,.jpeg,.png,.webp,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><Upload size={28}/><strong>{file?.name ?? 'Choose your menu file'}</strong><span>PDF · XLSX · CSV · JPG · PNG · WebP · documents up to 20 MB · images up to 8 MB</span><small>For scanned menu images, configure the optional AI provider in your server environment. CSV and XLSX extraction works locally. Legacy .xls files must be converted to .xlsx or CSV.</small></label>
      <div className="menu-import-format-grid"><div><FileSpreadsheet size={18}/><strong>Spreadsheet</strong><span>CSV and XLSX are parsed directly.</span></div><div><FileText size={18}/><strong>PDF menu</strong><span>Searchable PDF text is extracted. Scanned PDFs require image upload.</span></div><div><Sparkles size={18}/><strong>Menu photos</strong><span>Uses your configured vision model. Uncertain prices are flagged for review.</span></div></div>
      <button className="button button-primary" disabled={!file || busy} onClick={() => void parseFile()}>{busy ? <><Loader2 size={15} className="spin"/> Extracting menu…</> : <><Sparkles size={15}/> Extract and preview menu</>}</button>
      <p className="muted-small">Imported items are created as unavailable drafts. You must review and activate them in the existing Menu manager.</p>
    </section> : null}

    {stage === 'preview' ? <section className="surface-card menu-import-preview">
      <div className="menu-import-preview-head"><div><span className="eyebrow">IMPORT REVIEW</span><h2>Review extracted items</h2><p>{items.length} item(s) detected · {items.filter((item) => item.selected).length} selected for import</p></div><button className="button button-light" onClick={reset} disabled={busy}><RotateCcw size={14}/> Start over</button></div>
      <div className="menu-import-review-note"><AlertTriangle size={16}/><span>Check every price and category. Items with missing or uncertain data cannot be imported until corrected. Imported items remain unavailable until you activate them.</span></div>
      <div className="menu-import-items">{items.map((item, index) => <article className="menu-import-item" key={`${item.name}-${index}`}>
        <div className="menu-import-item-top"><label className="menu-import-select"><input type="checkbox" checked={item.selected} onChange={(event) => updateItem(index, { selected: event.target.checked })}/><span>Select item</span></label><span className={`menu-import-confidence ${item.confidence >= .8 ? 'high' : 'review'}`}>{Math.round(item.confidence * 100)}% confidence</span></div>
        <div className="menu-import-item-fields"><label>Item name<input value={item.name} maxLength={140} onChange={(event) => updateItem(index, { name: event.target.value })}/></label><label>Category<input value={item.category} maxLength={80} onChange={(event) => updateItem(index, { category: event.target.value })}/></label><label>Price (₹)<input type="number" min="0" max="9999999999.99" step="0.01" value={item.price ?? ''} onChange={(event) => updateItem(index, { price: event.target.value === '' ? null : Number(event.target.value) })}/></label><label>Diet<select value={item.is_veg === null ? 'unknown' : item.is_veg ? 'veg' : 'nonveg'} onChange={(event) => updateItem(index, { is_veg: event.target.value === 'unknown' ? null : event.target.value === 'veg' })}><option value="unknown">Not identified</option><option value="veg">Vegetarian</option><option value="nonveg">Non-vegetarian</option></select></label></div>
        <label className="menu-import-description">Description<textarea rows={2} value={item.description ?? ''} onChange={(event) => updateItem(index, { description: event.target.value })}/></label>
        {item.variants.length ? <div className="menu-import-variants"><strong>Detected variants</strong>{item.variants.map((variant, variantIndex) => <span key={`${variant.name}-${variantIndex}`}>{variant.name} · {variant.price_delta >= 0 ? '+' : ''}₹{variant.price_delta.toFixed(2)}</span>)}</div> : null}
        {item.modifier_groups?.length ? <div className="menu-import-variants"><strong>Detected add-ons / modifiers</strong>{item.modifier_groups.map((group, groupIndex) => <div key={`${group.name}-${groupIndex}`}><b>{group.name}</b><small>{group.is_required ? 'Required' : 'Optional'} · {group.selection_mode === 'SINGLE' ? 'Choose one' : `Choose up to ${group.max_select}`}</small>{group.modifiers.map((modifier, modifierIndex) => <span key={`${modifier.name}-${modifierIndex}`}>{modifier.name} · {modifier.price_delta >= 0 ? '+' : ''}₹{modifier.price_delta.toFixed(2)}</span>)}</div>)}</div> : null}
        {item.warnings.length || item.price === null ? <div className="menu-import-warning"><AlertTriangle size={14}/>{item.warnings.join(' ') || 'Review extracted values.'}</div> : null}
      </article>)}</div>
      <div className="menu-import-preview-footer"><button className="button button-light" onClick={reset} disabled={busy}>Cancel import</button><button className="button button-primary" onClick={() => void commitImport()} disabled={busy || !items.some((item) => item.selected)}>{busy ? <><Loader2 size={15} className="spin"/> Importing…</> : <><Check size={15}/> Import selected drafts</>}</button></div>
    </section> : null}

    {stage === 'complete' ? <section className="surface-card menu-import-complete"><CheckCircle2 size={42}/><h2>Menu import completed.</h2><p>{notice}</p><div className="button-row"><Link className="button button-primary" href={fromOnboarding ? "/menu?from=onboarding" : "/menu"}>Review imported items <ArrowLeft size={15}/></Link><button className="button button-light" onClick={reset}>Import another menu</button></div></section> : null}

    <section className="surface-card menu-import-history">
      <div className="menu-import-history-head"><div><span className="eyebrow">AUDIT TRAIL</span><h2>Recent imports</h2></div><button className="button button-light" onClick={() => setShowHistory((value) => !value)}><History size={15}/>{showHistory ? 'Hide' : 'Show'} history</button></div>
      {showHistory ? jobs.length ? <div className="menu-import-job-list">{jobs.map((job) => <div key={job.id}><div><strong>{job.source_filename}</strong><small>{new Date(job.created_at).toLocaleString()} · {job.extracted_count} extracted · {job.imported_count} imported · {job.skipped_duplicate_count} duplicates skipped</small></div><span className={`menu-import-job-status ${job.status.toLowerCase()}`}>{job.status}</span></div>)}</div> : <p className="muted-small">No menu imports recorded for this branch yet.</p> : <p className="muted-small">Import history is retained per branch and visible to users with menu-management access.</p>}
    </section>
  </StudioShell>;
}
