'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, Printer, QrCode, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';

interface TableRow { id: string; table_number: number; table_code: string; active: boolean; }
type QRMap = Record<string, string>;

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char] ?? char)); }

export default function QRPage() {
  const [context, setContext] = useState<CurrentRestaurantContext | null>(null);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [codes, setCodes] = useState<QRMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const supabase = getSupabaseBrowserClient();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001');

  async function load() {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    const result = await getCurrentRestaurantContext(supabase);
    if (result.error || !result.data) { setError(result.error?.message ?? 'Workspace not found.'); setLoading(false); return; }
    setContext(result.data);
    const { data, error: queryError } = await supabase.from('tables').select('id, table_number, table_code, active').eq('branch_id', result.data.branch.id).order('table_number');
    if (queryError) { setError(queryError.message); setLoading(false); return; }
    const rows = (data ?? []) as TableRow[];
    setTables(rows);
    const entries = await Promise.all(rows.filter((row) => row.active).map(async (row) => {
      const url = `${baseUrl}/r/${result.data!.organization.slug}/table/${row.table_code}`;
      return [row.table_code, await QRCode.toDataURL(url, { width: 420, margin: 2, errorCorrectionLevel: 'M' })] as const;
    }));
    setCodes(Object.fromEntries(entries));
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  const printHtml = useMemo(() => {
    if (!context) return '';
    const cards = tables.filter((t) => t.active && codes[t.table_code]).map((table) => `<article class="qr-print-card"><div class="brand">Tablely</div><div class="restaurant">${escapeHtml(context.organization.name)}</div><div class="table">TABLE ${String(table.table_number).padStart(2, '0')}</div><img src="${codes[table.table_code]}" alt="QR Code"/><div class="scan">SCAN TO ORDER</div><div class="no-app">No app required</div></article>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Tablely QR Codes</title><style>@page{margin:12mm}body{font-family:Arial,sans-serif;margin:0;color:#17231c}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.qr-print-card{border:1px solid #ddd6ca;border-radius:14px;padding:22px;text-align:center;page-break-inside:avoid}.brand{font-size:15px;font-weight:700}.restaurant{font-size:12px;color:#777;margin-top:8px}.table{font-size:25px;font-weight:800;margin:14px 0}.qr-print-card img{width:190px;height:190px}.scan{margin-top:10px;font-weight:800;letter-spacing:.12em}.no-app{margin-top:5px;color:#777;font-size:11px}@media print{.grid{grid-template-columns:repeat(2,1fr)}}</style></head><body><div class="grid">${cards}</div><script>window.onload=()=>window.print();</script></body></html>`;
  }, [codes, context, tables]);

  function openPrint(html = printHtml) {
    if (!html) return;
    const popup = window.open('', '_blank');
    if (!popup) { setError('Pop-up blocked. Allow pop-ups to print QR codes.'); return; }
    popup.document.write(html);
    popup.document.close();
  }

  function singlePrint(table: TableRow) {
    if (!context || !codes[table.table_code]) return;
    const html = `<!doctype html><html><head><meta charset=\"utf-8\"><title>Table ${table.table_number} QR</title><style>body{font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh;color:#17231c}.card{text-align:center;border:1px solid #ddd6ca;border-radius:14px;padding:30px;width:300px}.brand{font-weight:800}.restaurant{margin-top:8px;color:#777;font-size:12px}.table{font-size:28px;font-weight:800;margin:14px 0}.card img{width:220px}.scan{margin-top:12px;font-weight:800;letter-spacing:.12em}.noapp{margin-top:5px;color:#777;font-size:11px}</style></head><body><article class=\"card\"><div class=\"brand\">Tablely</div><div class=\"restaurant\">${escapeHtml(context.organization.name)}</div><div class=\"table\">TABLE ${String(table.table_number).padStart(2, '0')}</div><img src=\"${codes[table.table_code]}\"/><div class=\"scan\">SCAN TO ORDER</div><div class=\"noapp\">No app required</div></article><script>window.onload=()=>window.print();</script></body></html>`;
    openPrint(html);
  }

  function download(table: TableRow) {
    const href = codes[table.table_code];
    if (!href) return;
    const a = document.createElement('a');
    a.href = href;
    a.download = `tablely-table-${table.table_number}-qr.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadAll() {
    const active = tables.filter((table) => table.active && codes[table.table_code]);
    for (const table of active) {
      download(table);
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }

  if (loading) return <StudioShell><div className="setup-loading">Generating QR codes…</div></StudioShell>;
  return <StudioShell>
    <SectionHeader eyebrow="TABLE ACCESS" title="QR Codes" description="Every active table has a stable customer entry point. Print these on stands or stickers." action={<div className="button-row"><button className="button button-light" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button><button className="button button-light" onClick={() => void downloadAll()} disabled={!tables.some((t) => t.active)}><Download size={15} /> Download all</button><button className="button button-primary" onClick={() => openPrint()} disabled={!tables.some((t) => t.active)}><Printer size={15} /> Print all</button></div>} />
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <div className="qr-grid">
      {tables.map((table) => <article className={`surface-card qr-card-item ${table.active ? '' : 'table-inactive'}`} key={table.id}><div className="qr-box">{table.active && codes[table.table_code] ? <img src={codes[table.table_code]} alt={`QR for table ${table.table_number}`} /> : <QrCode size={108} strokeWidth={1.1} />}</div><strong>TABLE {String(table.table_number).padStart(2, '0')}</strong><span>{baseUrl}/r/{context?.organization.slug}/table/{table.table_code}</span><div className="button-row"><button className="button button-light button-full" disabled={!table.active} onClick={() => download(table)}><Download size={15} /> PNG</button><button className="button button-primary button-full" disabled={!table.active} onClick={() => singlePrint(table)}><Printer size={15} /> Print / PDF</button></div></article>)}
      {tables.length === 0 ? <div className="empty-wide"><h2>No tables available</h2><p>Create tables first, then return here to generate their QR codes.</p></div> : null}
    </div>
  </StudioShell>;
}
