'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, Printer, QrCode, RefreshCw, Palette, FileDown } from 'lucide-react';
import Link from 'next/link';
import QRCode from 'qrcode';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';

interface TableRow { id: string; table_number: number; table_code: string; active: boolean; public_qr_id: string; label?: string | null; }
type QRMap = Record<string, string>;
type Template = 'minimal' | 'premium' | 'bilingual' | 'poster' | 'classic' | 'logo-centered' | 'table-card' | 'custom-poster';
type PrintSize = 'A4' | 'A5' | 'A6' | '4x6' | 'CUSTOM';

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char] ?? char)); }
function safeColor(value: unknown, fallback: string) { const color = typeof value === 'string' ? value : ''; return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback; }

export default function QRPage() {
  const [context, setContext] = useState<CurrentRestaurantContext | null>(null);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [codes, setCodes] = useState<QRMap>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<Template>('premium');
  const [printSize, setPrintSize] = useState<PrintSize>('A4');
  const [customWidth, setCustomWidth] = useState('4');
  const [customHeight, setCustomHeight] = useState('6');
  const [primary, setPrimary] = useState('#17231c');
  const [accent, setAccent] = useState('#ee7c30');
  const [secondary, setSecondary] = useState('#f5f5f2');
  const [headline, setHeadline] = useState('SCAN TO ORDER');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [fromOnboarding, setFromOnboarding] = useState(false);
  const supabase = getSupabaseBrowserClient();
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001')).replace(/\/+$/, '');

  async function load() {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    setRefreshing(true); setError(null);
    const result = await getCurrentRestaurantContext(supabase);
    if (result.error || !result.data) { setError(result.error?.message ?? 'Workspace not found.'); setLoading(false); setRefreshing(false); return; }
    setContext(result.data);
    const [{ data, error: queryError }, { data: brand }] = await Promise.all([
      supabase.from('tables').select('id,table_number,table_code,active,public_qr_id,label').eq('branch_id', result.data.branch.id).order('table_number'),
      supabase.from('organizations').select('brand_logo_url,brand_primary_color,brand_secondary_color,brand_accent_color').eq('id', result.data.organization.id).maybeSingle(),
    ]);
    if (queryError) { setError(queryError.message.includes('public_qr_id') ? 'Apply the Build 28 migration to enable permanent QR identifiers.' : queryError.message); setLoading(false); setRefreshing(false); return; }
    if (brand) {
      setPrimary(safeColor(brand.brand_primary_color, '#17231c'));
      setSecondary(safeColor(brand.brand_secondary_color, '#f5f5f2'));
      setAccent(safeColor(brand.brand_accent_color, '#ee7c30'));
      setLogoUrl(typeof brand.brand_logo_url === 'string' ? brand.brand_logo_url : null);
    }
    const rows = (data ?? []) as TableRow[];
    setTables(rows);
    const entries = await Promise.all(rows.filter((row) => row.active).map(async (row) => {
      const url = `${baseUrl}/q/${row.public_qr_id}`;
      return [row.table_code, await QRCode.toDataURL(url, { width: 1000, margin: 4, errorCorrectionLevel: 'H', color: { dark: '#111111', light: '#FFFFFF' } })] as const;
    }));
    setCodes(Object.fromEntries(entries));
    setLoading(false); setRefreshing(false);
  }
  useEffect(() => { setFromOnboarding(new URLSearchParams(window.location.search).get('from') === 'onboarding'); void load(); }, []);

  const printHtml = useMemo(() => {
    if (!context) return '';
    const active = tables.filter((table) => table.active && codes[table.table_code]);
    const logo = logoUrl && /^https?:\/\//i.test(logoUrl) ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="Restaurant logo"/>` : '';
    const styleByTemplate: Record<Template, { border: string; radius: string; background: string; eyebrow: string; showNoApp: boolean }> = {
      minimal: { border: '1px solid #e2e6e1', radius: '10px', background: '#fff', eyebrow: 'SCAN TO ORDER', showNoApp: true },
      premium: { border: `2px solid ${accent}`, radius: '22px', background: secondary, eyebrow: headline, showNoApp: true },
      bilingual: { border: `1px solid ${accent}`, radius: '16px', background: '#fff', eyebrow: 'SCAN TO ORDER · ऑर्डर करने के लिए स्कैन करें', showNoApp: true },
      poster: { border: `4px solid ${primary}`, radius: '4px', background: secondary, eyebrow: headline, showNoApp: false },
      classic: { border: '1px solid #ddd', radius: '4px', background: '#fff', eyebrow: 'SCAN MENU', showNoApp: true },
      'logo-centered': { border: `2px dashed ${accent}`, radius: '28px', background: '#fff', eyebrow: headline, showNoApp: true },
      'table-card': { border: `1px solid ${primary}`, radius: '12px', background: secondary, eyebrow: 'YOUR TABLE · YOUR ORDER', showNoApp: true },
      'custom-poster': { border: `6px double ${accent}`, radius: '2px', background: secondary, eyebrow: headline, showNoApp: true },
    };
    const style = styleByTemplate[template];
    const cards = active.map((table) => `<article class="qr-print-card"><div class="topline">${logo}<div class="brand">${escapeHtml(context.organization.name)}</div><div class="branch">${escapeHtml(context.branch.name)}</div></div><div class="table">${escapeHtml(table.label?.trim() || `TABLE ${String(table.table_number).padStart(2, '0')}`)}</div><img class="qr" src="${codes[table.table_code]}" alt="QR code for table ${table.table_number}"/><div class="scan">${escapeHtml(style.eyebrow)}</div>${style.showNoApp ? '<div class="no-app">No app required · कोई ऐप डाउनलोड करने की ज़रूरत नहीं</div>' : ''}<div class="footer">Powered by TABLELY</div></article>`).join('');
    const safeCustomWidth = Math.min(24, Math.max(2, Number(customWidth) || 4));
    const safeCustomHeight = Math.min(24, Math.max(2, Number(customHeight) || 6));
    const pageSize: Record<PrintSize, string> = { A4: 'A4 portrait', A5: 'A5 portrait', A6: 'A6 portrait', '4x6': '4in 6in', CUSTOM: `${safeCustomWidth}in ${safeCustomHeight}in` };
    const grid = printSize === 'A4' ? 'repeat(2,minmax(0,1fr))' : '1fr';
    const qrInches = printSize === '4x6' ? 2.6 : printSize === 'CUSTOM'
      ? Math.min(3.2, Math.max(0.85, Math.min(safeCustomWidth - 0.25, safeCustomHeight - 0.5) * 0.55))
      : Math.min(2.55, Math.max(1.35, (printSize === 'A4' ? 8.3 : printSize === 'A5' ? 5.8 : 4.1) * 0.42));
    const pageMargin = printSize === 'CUSTOM' ? '0.06in' : printSize === '4x6' ? '0.12in' : '10mm';
    const cardPadding = printSize === 'CUSTOM' ? '8px' : printSize === '4x6' ? '12px' : '18px';
    const cardBreak = printSize === 'A4' ? 'auto' : 'always';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(context.organization.name)} — Table QR Codes</title><style>@page{size:${pageSize[printSize]};margin:${pageMargin}}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;margin:0;color:${primary};background:#fff}.grid{display:grid;grid-template-columns:${grid};gap:12px;align-items:start}.qr-print-card{border:${style.border};border-radius:${style.radius};background:${style.background};padding:${cardPadding};text-align:center;break-inside:avoid;page-break-inside:avoid;min-height:${printSize === '4x6' ? '5.5in' : 'auto'};display:flex;flex-direction:column;align-items:center;justify-content:center;page-break-after:${cardBreak}}.qr-print-card:last-child{page-break-after:auto}.topline{display:flex;align-items:center;flex-direction:column;gap:4px}.logo{max-width:65px;max-height:65px;object-fit:contain;margin-bottom:5px}.brand{font-weight:800;font-size:19px;line-height:1.2}.branch{font-size:11px;color:#606b63}.table{font-weight:850;font-size:24px;margin:18px 0 12px}.qr{width:${qrInches.toFixed(2)}in;height:${qrInches.toFixed(2)}in;max-width:90%;image-rendering:pixelated}.scan{font-weight:850;letter-spacing:.08em;font-size:13px;margin-top:15px;max-width:100%}.no-app{font-size:10px;color:#606b63;margin-top:6px}.footer{font-size:8px;color:#8b938e;margin-top:18px;letter-spacing:.08em}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.grid{gap:10px}.qr-print-card{break-inside:avoid}}</style></head><body><main class="grid">${cards}</main><script>window.onload=()=>{setTimeout(()=>window.print(),250)};</script></body></html>`;
  }, [accent, baseUrl, codes, context, headline, logoUrl, primary, printSize, customWidth, customHeight, secondary, tables, template]);

  function openPrint(html = printHtml) {
    if (!html) return;
    const popup = window.open('', '_blank');
    if (!popup) { setError('Pop-up blocked. Allow pop-ups to print or save QR codes as PDF.'); return; }
    popup.document.open(); popup.document.write(html); popup.document.close();
  }

  function download(table: TableRow) {
    const href = codes[table.table_code];
    if (!href) return;
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `tablely-${context?.organization.slug ?? 'restaurant'}-table-${table.table_number}-qr.png`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  }

  async function downloadAll() {
    const active = tables.filter((table) => table.active && codes[table.table_code]);
    for (const table of active) { download(table); await new Promise((resolve) => window.setTimeout(resolve, 350)); }
  }

  if (loading) return <StudioShell><div className="setup-loading">Generating permanent QR codes…</div></StudioShell>;
  return <StudioShell>
    <SectionHeader eyebrow="TABLE ACCESS · BUILD 28" title="QR Codes" description="Generate permanent table QR codes and branded print cards for your restaurant." action={<div className="button-row">{fromOnboarding ? <Link className="button button-light" href="/onboarding">Back to setup</Link> : null}<button className="button button-light" onClick={() => void load()} disabled={refreshing}><RefreshCw size={15} /> Refresh</button><button className="button button-light" onClick={() => void downloadAll()} disabled={!tables.some((table) => table.active)}><Download size={15} /> Download PNGs</button><button className="button button-primary" onClick={() => openPrint()} disabled={!tables.some((table) => table.active)}><FileDown size={15} /> Print / Save PDF</button></div>} />
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <section className="surface-card qr-template-controls">
      <div className="qr-template-heading"><div><span className="eyebrow">PRINT DESIGN</span><h2>Customize QR cards</h2><p>Choose a template and print size. PNG downloads use high error correction for reliable scanning.</p></div><Palette size={22}/></div>
      <div className="qr-template-grid">
        <label>Template<select value={template} onChange={(event) => setTemplate(event.target.value as Template)}><option value="minimal">Minimal</option><option value="premium">Premium branded</option><option value="bilingual">English + Hindi</option><option value="poster">Bold poster</option><option value="classic">Classic</option><option value="logo-centered">Logo-centred card</option><option value="table-card">Table card</option><option value="custom-poster">Custom branded poster</option></select></label>
        <label>Print size<select value={printSize} onChange={(event) => setPrintSize(event.target.value as PrintSize)}><option value="A4">A4</option><option value="A5">A5</option><option value="A6">A6</option><option value="4x6">4 × 6 inches</option><option value="CUSTOM">Custom inches</option></select></label>
        <label>Card heading<input value={headline} maxLength={60} onChange={(event) => setHeadline(event.target.value)} /></label>{printSize === 'CUSTOM' ? <><label>Width (inches)<input type="number" min="2" max="24" step="0.25" value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} /></label><label>Height (inches)<input type="number" min="2" max="24" step="0.25" value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} /></label></> : null}
      </div>
      <div className="qr-colors"><label>Primary<input type="color" value={primary} onChange={(event) => setPrimary(event.target.value)}/></label><label>Background<input type="color" value={secondary} onChange={(event) => setSecondary(event.target.value)}/></label><label>Accent<input type="color" value={accent} onChange={(event) => setAccent(event.target.value)}/></label></div>
      <p className="muted-small">PDF export opens your browser print dialog. Select “Save as PDF” to download a PDF. Existing legacy QR links remain supported.</p>
    </section>
    <div className="qr-grid">
      {tables.map((table) => <article className={`surface-card qr-card-item ${table.active ? '' : 'table-inactive'}`} key={table.id}>
        <div className="qr-box">{table.active && codes[table.table_code] ? <img src={codes[table.table_code]} alt={`Permanent QR for table ${table.table_number}`} /> : <QrCode size={108} strokeWidth={1.1} />}</div>
        <strong>{table.label?.trim() || `TABLE ${String(table.table_number).padStart(2, '0')}`}</strong>
        <span>{baseUrl}/q/{table.public_qr_id}</span>
        <div className="button-row"><button className="button button-light button-full" disabled={!table.active} onClick={() => download(table)}><Download size={15} /> PNG</button><button className="button button-primary button-full" disabled={!table.active} onClick={() => openPrint(makeSinglePrint(table))}><Printer size={15} /> Print / PDF</button></div>
      </article>)}
      {tables.length === 0 ? <div className="empty-wide"><h2>No tables available</h2><p>Create tables first, then return here to generate permanent QR codes.</p></div> : null}
    </div>
  </StudioShell>;

  function makeSinglePrint(table: TableRow) {
    if (!context || !codes[table.table_code]) return '';
    const title = table.label?.trim() || `TABLE ${String(table.table_number).padStart(2, '0')}`;
    const logo = logoUrl && /^https?:\/\//i.test(logoUrl) ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="Restaurant logo"/>` : '';
    const w = Math.min(24, Math.max(2, Number(customWidth) || 4)); const h = Math.min(24, Math.max(2, Number(customHeight) || 6)); const singleSize: Record<PrintSize, string> = { A4: 'A4 portrait', A5: 'A5 portrait', A6: 'A6 portrait', '4x6': '4in 6in', CUSTOM: `${w}in ${h}in` }; const pageHeight = printSize === 'A4' ? 11.7 : printSize === 'A5' ? 8.3 : printSize === 'A6' ? 5.8 : printSize === '4x6' ? 6 : h; const qrInches = Math.min(2.55, Math.max(0.85, Math.min(printSize === 'A4' ? 8.3 : printSize === 'A5' ? 5.8 : printSize === 'A6' ? 4.1 : printSize === '4x6' ? 4 : w, pageHeight) * 0.42));
    const pageMargin = printSize === 'CUSTOM' ? '.06in' : '.12in';
    const cardPadding = printSize === 'CUSTOM' ? '8px' : '18px';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} QR</title><style>@page{size:${singleSize[printSize]};margin:${pageMargin}}*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;color:${primary};display:grid;place-items:center;min-height:calc(${pageHeight}in - .24in)}.card{text-align:center;width:100%;padding:${cardPadding};border:2px solid ${accent};border-radius:20px;background:${secondary};display:flex;align-items:center;flex-direction:column}.logo{max-height:55px;max-width:90px;object-fit:contain}.brand{font-size:18px;font-weight:800;margin-top:6px}.branch{font-size:11px;color:#667;margin-top:3px}.table{font-size:26px;font-weight:850;margin:15px 0}.qr{width:${qrInches.toFixed(2)}in;height:${qrInches.toFixed(2)}in;max-width:90%;image-rendering:pixelated}.scan{font-weight:800;letter-spacing:.07em;margin-top:14px}.footer{font-size:9px;color:#667;margin-top:12px}</style></head><body><article class="card">${logo}<div class="brand">${escapeHtml(context.organization.name)}</div><div class="branch">${escapeHtml(context.branch.name)}</div><div class="table">${escapeHtml(title)}</div><img class="qr" src="${codes[table.table_code]}" alt="QR code"/><div class="scan">${escapeHtml(headline)}</div><div class="footer">No app required · Powered by TABLELY</div></article><script>window.onload=()=>setTimeout(()=>window.print(),250)</script></body></html>`;
  }
}
