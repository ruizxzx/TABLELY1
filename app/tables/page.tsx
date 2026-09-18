'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Edit3, Loader2, Plus, QrCode, Trash2, X, Power, Users, RefreshCw, CircleDollarSign } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';
import { TABLE_STATES, sessionOriginLabel, tableStateLabel, type SessionOrigin, type TableState } from '@/lib/restaurant-ops';
import { toLiveStatus, type LiveStatus } from '@/lib/realtime';

interface TableRow {
  id: string; branch_id: string; table_number: number; table_code: string; active: boolean;
  seats: number; label: string | null; operational_state: string; occupancy_count: number; seat_tracking_enabled: boolean;
}
interface SessionRow {
  id: string; branch_id: string; table_id: string; status: 'ACTIVE' | 'SETTLING' | 'CLOSED';
  occupancy_count: number; opened_at: string; closed_at: string | null;
  customer_name: string | null; customer_phone: string | null; origin: SessionOrigin | string | null; settling_at: string | null;
}
interface OrderMini { id: string; table_session_id: string | null; table_id: string; order_number: number | null; status: string; payment_status: string; total: number; created_at: string; }
interface ServiceRequest { id: string; table_id: string; table_session_id: string | null; type: string; status: string; note: string | null; created_at: string; }

function makeTableCode() { return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase(); }

export default function TablesPage() {
  const [context, setContext] = useState<CurrentRestaurantContext | null>(null);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [orders, setOrders] = useState<OrderMini[]>([]);
  const [requests, setRequests] = useState<ServiceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<TableRow | null>(null);
  const [sessionTable, setSessionTable] = useState<TableRow | null>(null);
  const [draft, setDraft] = useState({ number: '', label: '', seats: '4', seatTracking: false });
  const [sessionDraft, setSessionDraft] = useState('1');
  const [filter, setFilter] = useState<'ALL' | TableState>('ALL');
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const seq = useRef(0);
  const liveRef = useRef<LiveStatus>('connecting');
  const supabase = getSupabaseBrowserClient();
  const canEdit = context?.staff.role === 'OWNER' || context?.staff.role === 'MANAGER';

  async function load(silent = false) {
    const n = ++seq.current;
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    if (!silent) setRefreshing(true);
    try {
      const c = await getCurrentRestaurantContext(supabase);
      if (n !== seq.current) return;
      if (c.error || !c.data) throw c.error ?? new Error('Workspace not found.');
      setContext(c.data);
      const branch = c.data.branch.id;
      const [{ data: td, error: te }, { data: sd, error: se }, { data: od, error: oe }, { data: rd, error: re }] = await Promise.all([
        supabase.from('tables').select('id,branch_id,table_number,table_code,active,seats,label,operational_state,occupancy_count,seat_tracking_enabled').eq('branch_id', branch).order('table_number'),
        supabase.from('table_sessions').select('id,branch_id,table_id,status,occupancy_count,opened_at,closed_at,customer_name,customer_phone,origin,settling_at').eq('branch_id', branch).in('status', ['ACTIVE','SETTLING']).order('opened_at', { ascending: true }),
        supabase.from('orders').select('id,table_session_id,table_id,order_number,status,payment_status,total,created_at').eq('branch_id', branch).order('created_at', { ascending: false }).limit(250),
        supabase.from('service_requests').select('id,table_id,table_session_id,type,status,note,created_at').eq('branch_id', branch).in('status', ['OPEN','ACKNOWLEDGED']).order('created_at', { ascending: true }),
      ]);
      if (te) throw te; if (se) throw se; if (oe) throw oe; if (re) throw re;
      if (n !== seq.current) return;
      setTables((td ?? []).map(x => ({ ...x, occupancy_count: Number(x.occupancy_count ?? 0), seats: Number(x.seats ?? 0) })) as TableRow[]);
      setSessions((sd ?? []) as SessionRow[]);
      setOrders((od ?? []).map(x => ({ ...x, total: Number(x.total) })) as OrderMini[]);
      setRequests((rd ?? []) as ServiceRequest[]);
      setError(null); setLoading(false);
    } catch (e: unknown) {
      if (n === seq.current) { setError(e instanceof Error ? e.message : 'Could not load tables.'); setLoading(false); }
    } finally { if (n === seq.current) setRefreshing(false); }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!supabase || !context?.branch.id) return;
    let active = true;
    const branch = context.branch.id;
    const channel = supabase.channel(`tablely:floor:${branch}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tables', filter: `branch_id=eq.${branch}` }, () => void load(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'table_sessions', filter: `branch_id=eq.${branch}` }, () => void load(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `branch_id=eq.${branch}` }, () => void load(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'service_requests', filter: `branch_id=eq.${branch}` }, () => void load(true))
      .subscribe(status => { if (!active) return; const live = toLiveStatus(status); liveRef.current = live; setLiveStatus(live); if (live === 'live') void load(true); });
    const timer = window.setInterval(() => { if (liveRef.current !== 'live') void load(true); }, 20000);
    return () => { active = false; window.clearInterval(timer); void supabase.removeChannel(channel); };
  }, [context?.branch.id]);

  function openAdd() {
    const next = tables.length ? Math.max(...tables.map(t => t.table_number)) + 1 : 1;
    setDraft({ number: String(next), label: '', seats: '4', seatTracking: false });
    setModal({ id: '', branch_id: context?.branch.id ?? '', table_number: 0, table_code: '', active: true, seats: 4, label: null, operational_state: 'AVAILABLE', occupancy_count: 0, seat_tracking_enabled: false });
  }
  function openEdit(table: TableRow) {
    setDraft({ number: String(table.table_number), label: table.label ?? '', seats: String(table.seats), seatTracking: table.seat_tracking_enabled });
    setModal(table);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || !supabase || !context || !modal) return;
    const number = Number(draft.number); const seats = Number(draft.seats);
    if (!Number.isInteger(number) || number < 1 || number > 999 || !Number.isInteger(seats) || seats < 1 || seats > 100) { setError('Table number and capacity must be valid integers.'); return; }
    setBusy(true); setError(null);
    const payload = { table_number: number, seats, label: draft.label.trim() || null, seat_tracking_enabled: draft.seatTracking };
    const result = modal.id
      ? await supabase.from('tables').update(payload).eq('id', modal.id).eq('branch_id', context.branch.id).select('id,branch_id,table_number,table_code,active,seats,label,operational_state,occupancy_count,seat_tracking_enabled').single()
      : await supabase.from('tables').insert({ ...payload, branch_id: context.branch.id, table_code: makeTableCode() }).select('id,branch_id,table_number,table_code,active,seats,label,operational_state,occupancy_count,seat_tracking_enabled').single();
    if (result.error) setError(result.error.message); else { setModal(null); void load(true); }
    setBusy(false);
  }
  async function toggle(table: TableRow) {
    if (!canEdit || !supabase || !context) return;
    const { error: e } = await supabase.from('tables').update({ active: !table.active }).eq('id', table.id).eq('branch_id', context.branch.id);
    if (e) setError(e.message); else void load(true);
  }
  async function remove(table: TableRow) {
    if (!canEdit || !supabase || !context) return;
    if (!window.confirm(`Delete Table ${table.table_number}? Existing orders may prevent deletion.`)) return;
    const { error: e } = await supabase.from('tables').delete().eq('id', table.id).eq('branch_id', context.branch.id);
    if (e) setError(e.message); else void load(true);
  }
  function openSession(table: TableRow) {
    setSessionTable(table); setSessionDraft(String(Math.max(1, Math.min(1, table.seats))));
  }
  async function seatTable() {
    if (!sessionTable) return;
    setBusy(true); setError(null);
    try {
      if (!supabase) throw new Error('Database client unavailable.');
      const { error: e } = await supabase.rpc('open_table_session', { p_table_id: sessionTable.id, p_occupancy_count: Number(sessionDraft) || 0 });
      if (e) throw e;
      setSessionTable(null);
      void load(true);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not open session.'); }
    finally { setBusy(false); }
  }
  async function updateOccupancy(session: SessionRow, value: number) {
    setBusy(true); setError(null);
    try { const { error: e } = await supabase!.rpc('update_table_session_occupancy', { p_session_id: session.id, p_occupancy_count: value }); if (e) throw e; void load(true); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not update occupancy.'); }
    finally { setBusy(false); }
  }
  async function resolveRequest(id: string) {
    if (!supabase) return;
    setBusy(true); setError(null);
    try {
      const { error: e } = await supabase.rpc('resolve_service_request', { p_request_id: id, p_status: 'RESOLVED' });
      if (e) throw e;
      void load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not resolve service request.');
    } finally { setBusy(false); }
  }
  async function closeSession(session: SessionRow) {
    if (!window.confirm('Close only this session? Settled SERVED orders will be finalized as COMPLETED; unresolved orders, payments, or service requests will block closing.')) return;
    setBusy(true); setError(null);
    try { const { error: e } = await supabase!.rpc('close_table_session', { p_session_id: session.id }); if (e) throw e; void load(true); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not close session.'); }
    finally { setBusy(false); }
  }

  const filtered = useMemo(() => filter === 'ALL' ? tables : tables.filter(t => (t.operational_state === 'CLEARING' ? 'PAYMENT_PENDING' : t.operational_state) === filter), [filter, tables]);
  // Build 19 — a table can legitimately hold several open sessions at once
  // (customer A settling at the counter while customer B already ordered).
  const sessionsByTable = useMemo(() => {
    const map: Record<string, SessionRow[]> = {};
    for (const s of sessions) (map[s.table_id] ??= []).push(s);
    return map;
  }, [sessions]);
  const ordersBySession = useMemo(() => {
    const map: Record<string, OrderMini[]> = {};
    for (const o of orders) if (o.table_session_id) (map[o.table_session_id] ??= []).push(o);
    return map;
  }, [orders]);
  const liveLabel = liveStatus === 'live' ? 'Live' : liveStatus === 'offline' ? 'Offline' : 'Reconnecting';
  const counts = useMemo(() => Object.fromEntries(TABLE_STATES.map(s => [s, tables.filter(t => (t.operational_state === 'CLEARING' ? 'PAYMENT_PENDING' : t.operational_state) === s).length])), [tables]);
  const publicBase = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001');

  if (loading) return <StudioShell><div className="setup-loading">Loading live floor…</div></StudioShell>;
  return <StudioShell>
    <SectionHeader eyebrow="FLOOR / OPERATIONS 2.0" title="Tables" description="Server-derived table occupancy, active sessions, concurrent orders, billing state, and live floor operations." action={<div className="button-row"><button className="button button-light" onClick={() => void load()} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spin' : ''}/> Refresh</button>{canEdit ? <button className="button button-primary" onClick={openAdd}><Plus size={16}/> Add table</button> : <span className="role-note">View only · {context?.staff.role}</span>}</div>} />
    <div className="live-status"><span className={`status-dot ${liveStatus === 'live' ? 'online' : 'offline'}`}/>{liveLabel}<span className="muted-small">· table state is server-derived</span></div>
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <div className="status-tabs table-state-tabs"><button className={filter === 'ALL' ? 'active' : ''} onClick={() => setFilter('ALL')}>All · {tables.length}</button>{TABLE_STATES.map(state => <button key={state} className={filter === state ? 'active' : ''} onClick={() => setFilter(state)}>{tableStateLabel(state)} · {counts[state] ?? 0}</button>)}</div>
    <div className="table-page-grid">
      {filtered.map(table => {
        const tableSessions = sessionsByTable[table.id] ?? [];
        const tableOrders = tableSessions.flatMap(s => ordersBySession[s.id] ?? []);
        const activeOrders = tableOrders.filter(o => !['COMPLETED','CANCELLED','REJECTED'].includes(o.status));
        const declaredOccupancy = tableSessions.reduce((sum, s) => sum + Number(s.occupancy_count ?? 0), 0);
        const canSeat = !tableSessions.some(s => s.status === 'ACTIVE');
        const tableRequests = requests.filter(r => r.table_id === table.id);
        return <article className={`surface-card large-table-card ops-table-card ${table.active ? '' : 'table-inactive'}`} key={table.id}>
          <div className="ops-table-top"><div><div className="large-table-number">{String(table.table_number).padStart(2,'0')}</div>{table.label ? <div className="table-label-display">{table.label}</div> : null}<div className="table-code-label">{table.table_code}</div></div><span className={`ops-state ops-state-${(table.operational_state === 'CLEARING' ? 'PAYMENT_PENDING' : table.operational_state).toLowerCase()}`}><CircleDollarSign size={12}/>{tableStateLabel(table.operational_state === 'CLEARING' ? 'PAYMENT_PENDING' : table.operational_state)}</span></div>
          <div className="ops-table-metrics"><span><Users size={13}/> {declaredOccupancy}/{table.seats}</span><span>{activeOrders.length} active order{activeOrders.length === 1 ? '' : 's'}</span><span>{tableSessions.length} open session{tableSessions.length === 1 ? '' : 's'}</span></div>
          {tableSessions.length ? tableSessions.map((session, index) => {
            const sessionOrders = ordersBySession[session.id] ?? [];
            const sessionActive = sessionOrders.filter(o => !['COMPLETED','CANCELLED','REJECTED'].includes(o.status));
            const sessionRequests = tableRequests.filter(r => r.table_session_id === session.id);
            return <div className="ops-table-session" key={session.id}>
              <div className="ops-table-session-head">
                <strong>{String.fromCharCode(65 + index)} · Session {session.id.slice(0,8).toUpperCase()}</strong>
                <small>{session.status === 'SETTLING' ? 'Settling · payment pending' : 'Active'} · {new Date(session.opened_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</small>
              </div>
              <div className="ops-session-guest muted-small">{session.customer_name ? `${session.customer_name}${session.customer_phone ? ` · ${session.customer_phone}` : ''}` : 'Guest not identified yet'} · {session.occupancy_count}/{table.seats} seated · {sessionOriginLabel(session.origin)}</div>
              {sessionActive.slice(0,3).map(o => <div className="ops-order-mini" key={o.id}><span>#{o.order_number ?? o.id.slice(0,6)}</span><span>{o.status}</span><b>₹{Number(o.total).toLocaleString('en-IN')}</b></div>)}
              {sessionActive.length > 3 ? <small className="muted-small">+{sessionActive.length - 3} more active order(s)</small> : null}
              {sessionRequests.length ? <small className="muted-small">{sessionRequests.length} open service request(s)</small> : null}
              <div className="ops-session-total"><span>Session total</span><strong>₹{sessionOrders.reduce((sum,o) => sum + Number(o.total),0).toLocaleString('en-IN')}</strong></div>
              {canEdit ? <div className="button-row">
                <button className="button button-light compact" onClick={() => { const next = window.prompt(`Occupancy (0-${table.seats})`, String(session.occupancy_count)); if (next !== null) void updateOccupancy(session, Math.max(0, Math.min(table.seats, Number(next) || 0))); }} disabled={busy}>Occupancy</button>
                <button className="button button-light compact" onClick={() => void closeSession(session)} disabled={busy}>Close session</button>
              </div> : null}
            </div>;
          }) : <div className="ops-table-empty">No open session · table is empty</div>}
          {tableRequests.length ? <div className="ops-table-requests"><div className="ops-table-requests-head"><strong>Service requests</strong><span>{tableRequests.length}</span></div>{tableRequests.slice(0,3).map(request => <div className="ops-table-request" key={request.id}><div><strong>{request.type.replaceAll('_',' ')}</strong><small>{request.note || 'No note'} · {new Date(request.created_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</small></div><button className="button button-light compact" onClick={() => void resolveRequest(request.id)} disabled={busy}>Resolve</button></div>)}</div> : null}
          <div className="button-row"><Link href={`/qr?table=${encodeURIComponent(table.table_code)}`} className="button button-light compact"><QrCode size={14}/> QR</Link>{canEdit && canSeat ? <button className="button button-primary compact" onClick={() => openSession(table)} disabled={!table.active}><Users size={14}/> Seat</button> : null}{canEdit ? <button className="button button-light compact" onClick={() => openEdit(table)}><Edit3 size={14}/> Edit</button> : null}{canEdit ? <button className="button button-light compact" onClick={() => void toggle(table)}><Power size={14}/> {table.active ? 'Disable' : 'Enable'}</button> : null}{canEdit ? <button className="button button-light compact danger-button" onClick={() => void remove(table)}><Trash2 size={14}/></button> : null}</div>
          <small className="table-public-url">{publicBase}/r/{context?.organization.slug}/table/{table.table_code}</small>
        </article>;
      })}
      {filtered.length === 0 ? <div className="empty-wide"><h2>No tables in this view</h2><p>Change the state filter or add a table.</p></div> : null}
    </div>

    {modal ? <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setModal(null); }}><div className="modal-card compact-modal"><div className="modal-head"><div><span className="eyebrow">TABLE</span><h2>{modal.id ? 'Edit table' : 'Add table'}</h2></div><button className="icon-button" onClick={() => setModal(null)}><X size={17}/></button></div><form className="modal-form" onSubmit={save}><label>Table number<input type="number" min="1" max="999" value={draft.number} onChange={e => setDraft({...draft,number:e.target.value})} required/></label><label>Table name / label<input value={draft.label} onChange={e => setDraft({...draft,label:e.target.value})} maxLength={60} placeholder="Window, Family, VIP…"/></label><label>Capacity<input type="number" min="1" max="100" value={draft.seats} onChange={e => setDraft({...draft,seats:e.target.value})} required/></label><label className="check-row"><input type="checkbox" checked={draft.seatTracking} onChange={e => setDraft({...draft,seatTracking:e.target.checked})}/> Enable seat-level occupancy tracking</label>{modal.id ? <div className="static-code"><span>Stable table code</span><strong>{modal.table_code}</strong></div> : null}<div className="modal-actions"><button type="button" className="button button-light" onClick={() => setModal(null)}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? <><Loader2 size={15} className="spin"/> Saving…</> : 'Save table'}</button></div></form></div></div> : null}
    {sessionTable ? <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSessionTable(null); }}><div className="modal-card compact-modal"><div className="modal-head"><div><span className="eyebrow">TABLE {sessionTable.table_number}</span><h2>Seat guests</h2></div><button className="icon-button" onClick={() => setSessionTable(null)}><X size={17}/></button></div><div className="modal-form"><p className="muted-small">This opens a staff session on the table. Customer QR scans still open their own sessions, and every session is settled and closed independently.</p><label>Guests / occupancy<input type="number" min="0" max={sessionTable.seats} value={sessionDraft} onChange={e => setSessionDraft(e.target.value)}/></label><div className="static-code"><span>Capacity</span><strong>{sessionTable.seats} guests</strong></div><div className="modal-actions"><button className="button button-light" onClick={() => setSessionTable(null)}>Cancel</button><button className="button button-primary" onClick={() => void seatTable()} disabled={busy}>{busy ? <><Loader2 size={15} className="spin"/> Opening…</> : 'Open session'}</button></div></div></div></div> : null}
  </StudioShell>;
}
