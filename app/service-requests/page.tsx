'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BellRing, Check, Clock3, RefreshCw } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { removeById, upsertById, uniqueById } from '@/lib/live-ops';
import { toLiveStatus, type LiveStatus } from '@/lib/realtime';

type RequestRow = { id: string; branch_id: string; table_id: string; type: string; status: string; note: string | null; created_at: string; };
const labels: Record<string, string> = { WAITER: 'Waiter', WATER: 'Water', BILL: 'Bill', ASSISTANCE: 'Assistance' };

export default function ServiceRequestsPage() {
  const supabase = getSupabaseBrowserClient();
  const [rows, setRows] = useState<RequestRow[]>([]); const [tables, setTables] = useState<Record<string, number>>({}); const [loading, setLoading] = useState(true); const [refreshing, setRefreshing] = useState(false); const [error, setError] = useState<string | null>(null); const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const seqRef = useRef(0); const liveStatusRef = useRef<LiveStatus>('connecting');
  async function load(silent = false) {
    const seq = ++seqRef.current;
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    if (!silent) setRefreshing(true);
    try {
      const context = await getCurrentRestaurantContext(supabase); if (seq !== seqRef.current) return; if (!context.data) throw context.error ?? new Error('Workspace not found.');
      const branch = context.data.branch.id;
      const [{ data: requests, error: requestError }, { data: tableData, error: tableError }] = await Promise.all([
        supabase.from('service_requests').select('id,branch_id,table_id,type,status,note,created_at').eq('branch_id', branch).in('status', ['OPEN', 'ACKNOWLEDGED']).order('created_at', { ascending: true }),
        supabase.from('tables').select('id,table_number').eq('branch_id', branch),
      ]);
      if (seq !== seqRef.current) return; if (requestError) throw requestError; if (tableError) throw tableError;
      setRows(uniqueById((requests ?? []) as RequestRow[])); setTables(Object.fromEntries((tableData ?? []).map((table) => [table.id, table.table_number]))); setError(null); setLoading(false);
    } catch (err: unknown) { if (seq !== seqRef.current) return; setError(err instanceof Error ? err.message : 'Could not load requests.'); setLoading(false); }
    finally { if (seq === seqRef.current) setRefreshing(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!supabase) return; let channel: ReturnType<typeof supabase.channel> | null = null; let active = true;
    const timer = window.setInterval(() => { if (liveStatusRef.current !== 'live') void load(true); }, 20000);
    (async () => { const context = await getCurrentRestaurantContext(supabase); if (!context.data || !active) return; const branch = context.data.branch.id;
      channel = supabase.channel(`tablely:service:${branch}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'service_requests', filter: `branch_id=eq.${branch}` }, (payload) => setRows((current) => upsertById(current, payload.new as RequestRow)))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'service_requests', filter: `branch_id=eq.${branch}` }, (payload) => { const next = payload.new as RequestRow; setRows((current) => ['OPEN', 'ACKNOWLEDGED'].includes(next.status) ? upsertById(current, next) : removeById(current, next.id)); })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'service_requests', filter: `branch_id=eq.${branch}` }, (payload) => setRows((current) => removeById(current, (payload.old as RequestRow).id)))
        .subscribe((status) => { if (!active) return; const next = toLiveStatus(status); liveStatusRef.current = next; setLiveStatus(next); if (next === 'live') void load(true); });
    })();
    return () => { active = false; window.clearInterval(timer); if (channel) void supabase.removeChannel(channel); };
  }, []);
  async function resolve(id: string, status: string) { if (!supabase) return; const { data, error: rpcError } = await supabase.rpc('resolve_service_request', { p_request_id: id, p_status: status }); if (rpcError) { setError(rpcError.message); void load(true); return; } const value = Array.isArray(data) ? data[0] : data; if (status === 'RESOLVED' || status === 'CANCELLED') setRows((current) => removeById(current, id)); else if (value) setRows((current) => upsertById(current, value as RequestRow)); }
  const open = useMemo(() => rows.filter((row) => row.status === 'OPEN').length, [rows]);
  const label = liveStatus === 'live' ? 'Live' : liveStatus === 'offline' ? 'Offline' : 'Reconnecting';
  if (loading) return <StudioShell><div className="setup-loading">Loading service requests…</div></StudioShell>;
  return <StudioShell><SectionHeader eyebrow="SERVICE" title="Service requests" description="Live requests from tables." action={<button className="button button-light" onClick={() => void load()} disabled={refreshing}>{refreshing ? <RefreshCw className="spin" size={15} /> : <RefreshCw size={15} />} Refresh</button>} /><div className="live-status"><span className={`status-dot ${liveStatus === 'live' ? 'online' : 'offline'}`} />{label}<span className="muted-small">· {open} open</span></div>{error ? <div className="notice notice-error" role="alert">{error}</div> : null}<section className="service-grid">{rows.map((row) => <article className="surface-card service-card" key={row.id}><div className="service-icon"><BellRing size={18} /></div><div className="service-main"><strong>Table {tables[row.table_id] ?? '—'} · {labels[row.type] ?? row.type}</strong><span><Clock3 size={12} /> {new Date(row.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>{row.note ? <p>{row.note}</p> : null}</div><div className="button-row">{row.status === 'OPEN' ? <button className="button button-light compact" onClick={() => void resolve(row.id, 'ACKNOWLEDGED')}>Acknowledge</button> : null}<button className="button button-primary compact" onClick={() => void resolve(row.id, 'RESOLVED')}><Check size={14} /> Resolve</button></div></article>)}{rows.length === 0 ? <div className="empty-wide"><h2>No open requests</h2><p>New table service requests will appear here.</p></div> : null}</section></StudioShell>;
}
