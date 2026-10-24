'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock3, RefreshCw, X } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { formatElapsed } from '@/lib/restaurant-ops';
import { toLiveStatus, type LiveStatus } from '@/lib/realtime';
import styles from './SessionManagementPanel.module.css';

type SessionOrder = {
  id: string;
  order_number: number | null;
  status: string;
  payment_status: string;
  payment_method: string | null;
  total: number;
  created_at: string;
  paid_at: string | null;
  customer_name: string | null;
  customer_phone: string | null;
};

type SessionPayment = {
  order_id: string;
  order_number: number | null;
  amount: number;
  currency: string;
  status: string;
  method: string | null;
  provider: string;
  created_at: string;
};

type SessionManagement = {
  session_id: string;
  table_id: string;
  table_number: number;
  session_status: string;
  opened_at: string;
  closed_at: string | null;
  closed_by: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  order_count: number;
  total: number;
  collected: number;
  outstanding: number;
  can_close: boolean;
  reasons: string[];
  orders: SessionOrder[];
  payments: SessionPayment[];
};

type OpenSession = { id: string; table_id: string; opened_at: string };

function amount(value: number) {
  return `₹${Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && error.code === 'PGRST202') {
      return 'Session management is not installed in this Supabase project. Apply migration 20261024100000_build317_orders_session_management.sql, then reload Orders.';
    }
    if ('message' in error && typeof error.message === 'string' && error.message.trim()) {
      if (error.message.includes('Could not find the function public.get_table_session_management')) {
        return 'Session management is not installed in this Supabase project. Apply migration 20261024100000_build317_orders_session_management.sql, then reload Orders.';
      }
      return error.message;
    }
  }
  return fallback;
}

function orderLabel(order: Pick<SessionOrder, 'id' | 'order_number'>) {
  return `#${order.order_number ?? order.id.slice(0, 6)}`;
}

export function SessionManagementPanel({
  branchId,
  requestedSessionId,
  onSessionHandled,
}: {
  branchId: string;
  requestedSessionId: string | null;
  onSessionHandled: () => void;
}) {
  const supabase = getSupabaseBrowserClient();
  const [sessions, setSessions] = useState<SessionManagement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('connecting');
  const [details, setDetails] = useState<SessionManagement | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [forceConfirming, setForceConfirming] = useState(false);
  const [forceReason, setForceReason] = useState('');
  const [forceAcknowledged, setForceAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const liveRef = useRef(false);

  const load = useCallback(async (silent = false) => {
    const sequence = ++requestSequence.current;
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    if (!silent) setRefreshing(true);
    try {
      const { data: openRows, error: sessionError } = await supabase
        .from('table_sessions')
        .select('id,table_id,opened_at')
        .eq('branch_id', branchId)
        .in('status', ['ACTIVE', 'SETTLING'])
        .order('opened_at', { ascending: true });
      if (sessionError) throw sessionError;

      const managementRows = await Promise.all(((openRows ?? []) as OpenSession[]).map(async session => {
        const { data, error: detailError } = await supabase.rpc('get_table_session_management', {
          p_session_id: session.id,
        });
        if (detailError) throw detailError;
        return data as SessionManagement;
      }));
      if (sequence !== requestSequence.current) return;
      setSessions(managementRows);
      setError(null);
      setLoading(false);
    } catch (caught) {
      if (sequence === requestSequence.current) {
        setError(getErrorMessage(caught, 'Could not load session management.'));
        setLoading(false);
      }
    } finally {
      if (sequence === requestSequence.current) setRefreshing(false);
    }
  }, [branchId, supabase]);

  const loadDetails = useCallback(async (sessionId: string): Promise<SessionManagement | null> => {
    if (!supabase) return null;
    setDetailsLoading(true);
    setActionError(null);
    try {
      const { data, error: detailError } = await supabase.rpc('get_table_session_management', {
        p_session_id: sessionId,
      });
      if (detailError) throw detailError;
      const management = data as SessionManagement;
      setDetails(management);
      return management;
    } catch (caught) {
      setActionError(getErrorMessage(caught, 'Could not load session details.'));
      return null;
    } finally {
      setDetailsLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const channel = supabase.channel(`tablely:order-sessions:${branchId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'table_sessions', filter: `branch_id=eq.${branchId}` }, () => void load(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `branch_id=eq.${branchId}` }, () => void load(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'service_requests', filter: `branch_id=eq.${branchId}` }, () => void load(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payment_transactions', filter: `branch_id=eq.${branchId}` }, () => void load(true))
      .subscribe(status => {
        if (!active) return;
        const nextStatus = toLiveStatus(status);
        setLiveStatus(nextStatus);
        liveRef.current = nextStatus === 'live';
        if (liveRef.current) void load(true);
      });
    const timer = window.setInterval(() => {
      if (!liveRef.current) void load(true);
    }, 20000);
    return () => {
      active = false;
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [branchId, load, supabase]);

  useEffect(() => {
    if (!details) return;
    const timer = window.setInterval(() => void loadDetails(details.session_id), 20000);
    return () => window.clearInterval(timer);
  }, [details?.session_id, loadDetails]);

  const readySessions = useMemo(() => sessions.filter(session => session.can_close), [sessions]);
  const activeSessions = useMemo(() => sessions.filter(session => !session.can_close), [sessions]);
  const outstandingTotal = useMemo(() => sessions.reduce((total, session) => total + session.outstanding, 0), [sessions]);
  const sessionLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const byTable = new Map<string, SessionManagement[]>();
    for (const session of sessions) {
      const tableSessions = byTable.get(session.table_id) ?? [];
      tableSessions.push(session);
      byTable.set(session.table_id, tableSessions);
    }
    for (const tableSessions of byTable.values()) {
      tableSessions.forEach((session, index) => labels.set(session.session_id, String.fromCharCode(65 + index)));
    }
    return labels;
  }, [sessions]);

  const openDetails = useCallback(async (sessionId: string) => {
    setDetails(null);
    await loadDetails(sessionId);
  }, [loadDetails]);

  useEffect(() => {
    if (!requestedSessionId) return;
    void openDetails(requestedSessionId);
    onSessionHandled();
  }, [onSessionHandled, openDetails, requestedSessionId]);

  async function openConfirmation(sessionId: string) {
    const current = await loadDetails(sessionId);
    if (current) setConfirming(true);
  }

  function canForceCloseForCancelledOrders(session: SessionManagement) {
    return session.session_status !== 'CLOSED'
      && session.reasons.length === 1
      && session.reasons[0].includes('cancelled or rejected order(s) need payment/refund review.');
  }

  async function openForceConfirmation(sessionId: string) {
    const current = await loadDetails(sessionId);
    if (current && canForceCloseForCancelledOrders(current)) {
      setForceReason('');
      setForceAcknowledged(false);
      setForceConfirming(true);
    }
  }

  async function closeSession() {
    if (!supabase || !details) return;
    setBusy(true);
    setActionError(null);
    try {
      const { data, error: readinessError } = await supabase.rpc('get_table_session_management', {
        p_session_id: details.session_id,
      });
      if (readinessError) throw readinessError;
      const current = data as SessionManagement;
      setDetails(current);
      if (!current.can_close) {
        setConfirming(false);
        setActionError(current.reasons.join(' '));
        return;
      }
      const { error: closeError } = await supabase.rpc('close_table_session', {
        p_session_id: current.session_id,
      });
      if (closeError) throw closeError;
      setConfirming(false);
      setDetails(null);
      setActionError(null);
      await load(true);
    } catch (caught) {
      setActionError(getErrorMessage(caught, 'Could not close session.'));
    } finally {
      setBusy(false);
    }
  }

  async function forceCloseSession() {
    if (!supabase || !details || !forceAcknowledged || forceReason.trim().length < 10) return;
    setBusy(true);
    setActionError(null);
    try {
      const { error: closeError } = await supabase.rpc('force_close_table_session_for_cancelled_orders', {
        p_session_id: details.session_id,
        p_reason: forceReason.trim(),
      });
      if (closeError) throw closeError;
      setForceConfirming(false);
      setDetails(null);
      setActionError(null);
      await load(true);
    } catch (caught) {
      setActionError(getErrorMessage(caught, 'Could not force-close session.'));
    } finally {
      setBusy(false);
    }
  }

  function renderSession(session: SessionManagement, ready: boolean) {
    const label = sessionLabels.get(session.session_id) ?? 'A';
    const activeOrderCount = session.orders.filter(order => !['COMPLETED', 'CANCELLED', 'REJECTED', 'SERVED'].includes(order.status)).length;
    const forceEligible = canForceCloseForCancelledOrders(session);
    return (
      <article className={`${styles.card} ${ready ? styles.cardReady : ''}`} key={session.session_id}>
        <div className={styles.cardHead}>
          <div>
            <strong>Table {String(session.table_number).padStart(2, '0')} · Session {label}</strong>
            <span>Session ID: {session.session_id.slice(0, 8).toUpperCase()} · {session.order_count} order{session.order_count === 1 ? '' : 's'} · Open {formatElapsed(session.opened_at)} ago</span>
          </div>
          <span className={`${styles.state} ${ready ? styles.stateReady : ''}`}>{ready ? 'Ready to close' : 'In progress'}</span>
        </div>
        <div className={styles.metrics}>
          <span><b>Orders</b>{session.order_count}</span>
          <span><b>Active</b>{activeOrderCount}</span>
          <span><b>Collected</b>{amount(session.collected)}</span>
          <span><b>Outstanding</b>{amount(session.outstanding)}</span>
        </div>
        {!ready && session.reasons.length ? <p className={styles.blocker}>{session.reasons.join(' ')}</p> : null}
        <div className={styles.actions}>
          <button className="button button-light compact" onClick={() => void openDetails(session.session_id)}>Session details</button>
          {ready ? <button className="button button-primary compact" onClick={() => void openConfirmation(session.session_id)}>Close session</button> : null}
          {forceEligible ? <button className="button button-light compact" onClick={() => void openForceConfirmation(session.session_id)}>Review & force close</button> : null}
        </div>
      </article>
    );
  }

  return (
    <>
      <section className={styles.panel} aria-label="Session management">
        <div className={styles.panelHead}>
          <div>
            <span className="eyebrow">SESSION MANAGEMENT</span>
            <div className={styles.titleLine}>
              <h2>Live sessions <span>{sessions.length}</span></h2>
              <span className={styles.liveState} data-status={liveStatus} aria-live="polite">
                <i aria-hidden="true" />{liveStatus === 'live' ? 'Live updates' : liveStatus === 'offline' ? 'Polling updates' : 'Syncing'}
              </span>
            </div>
            <div className={styles.overview}>
              <span className={styles.overviewReady}>{readySessions.length} ready</span>
              <span>{activeSessions.length} in progress</span>
              <span>Outstanding {amount(outstandingTotal)}</span>
            </div>
          </div>
          <button className={styles.refreshButton} aria-label="Refresh sessions" title="Refresh sessions" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''}/>
          </button>
        </div>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        {!details && actionError ? <div className="notice notice-error" role="alert">{actionError}</div> : null}
        {error ? null : loading ? <div className={styles.emptyState}>Loading live sessions…</div> : sessions.length === 0 ? <div className={styles.emptyState}>No active table sessions.</div> : (
          <div className={styles.grid}>
            {readySessions.map(session => renderSession(session, true))}
            {activeSessions.map(session => renderSession(session, false))}
          </div>
        )}
      </section>

      {details || detailsLoading ? (
        <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDetails(null); }}>
          <section className={`modal-card ${styles.detailsModal}`} role="dialog" aria-modal="true" aria-labelledby="session-details-title">
            <div className="modal-head">
              <div>
                <span className="eyebrow">TABLE {details ? String(details.table_number).padStart(2, '0') : ''} · SESSION</span>
                <h2 id="session-details-title">Session details</h2>
              </div>
              <button className="icon-button" onClick={() => setDetails(null)} aria-label="Close session details"><X size={17}/></button>
            </div>
            {detailsLoading && !details ? <div className="setup-loading">Loading session details…</div> : null}
            {details ? (
              <>
                {actionError ? <div className="notice notice-error" role="alert">{actionError}</div> : null}
                <div className={styles.summary}>
                  <div><span>Session ID</span><strong>{details.session_id.toUpperCase()}</strong></div>
                  <div><span>Duration</span><strong><Clock3 size={13}/> {formatElapsed(details.opened_at)}</strong></div>
                  <div><span>Total bill</span><strong>{amount(details.total)}</strong></div>
                  <div><span>Collected</span><strong>{amount(details.collected)}</strong></div>
                  <div><span>Outstanding</span><strong>{amount(details.outstanding)}</strong></div>
                  <div><span>Orders</span><strong>{details.order_count}</strong></div>
                </div>
                <div className={styles.guest}>
                  <strong>Customer</strong>
                  <span>{details.customer_name || 'Guest'}{details.customer_phone ? ` · ${details.customer_phone}` : ''}</span>
                </div>
                <section className={styles.section}>
                  <h3>Orders</h3>
                  {details.orders.length ? details.orders.map(order => (
                    <div className={styles.detailRow} key={order.id}>
                      <div><strong>{orderLabel(order)}</strong><span>{order.status} · {order.payment_status}{order.payment_method ? ` · ${order.payment_method}` : ''}</span></div>
                      <b>{amount(order.total)}</b>
                    </div>
                  )) : <p className="muted-small">No orders are linked to this session.</p>}
                </section>
                <section className={styles.section}>
                  <h3>Payment history</h3>
                  {details.payments.length ? details.payments.map((payment, index) => (
                    <div className={styles.detailRow} key={`${payment.order_id}:${payment.created_at}:${index}`}>
                      <div><strong>{orderLabel({ id: payment.order_id, order_number: payment.order_number })} · {payment.method || payment.provider}</strong><span>{payment.status} · {new Date(payment.created_at).toLocaleString()}</span></div>
                      <b>{amount(payment.amount)}</b>
                    </div>
                  )) : <p className="muted-small">No recorded payment transactions.</p>}
                </section>
                {!details.can_close && details.reasons.length ? <div className={styles.blocker}>{details.reasons.join(' ')}</div> : null}
                <div className="modal-actions">
                  <button className="button button-light" onClick={() => setDetails(null)}>Done</button>
                  {details.can_close ? <button className="button button-primary" onClick={() => setConfirming(true)}>Close session</button> : null}
                  {canForceCloseForCancelledOrders(details) ? <button className="button button-light" onClick={() => { setForceReason(''); setForceAcknowledged(false); setForceConfirming(true); }}>Review & force close</button> : null}
                </div>
              </>
            ) : null}
          </section>
        </div>
      ) : null}

      {confirming && details ? (
        <div className={`modal-backdrop ${styles.confirmBackdrop}`} onMouseDown={event => { if (event.target === event.currentTarget) setConfirming(false); }}>
          <section className="modal-card compact-modal" role="dialog" aria-modal="true" aria-labelledby="session-close-title">
            <div className="modal-head">
              <div><span className="eyebrow">CONFIRM SESSION CLOSURE</span><h2 id="session-close-title">Close session?</h2></div>
              <button className="icon-button" onClick={() => setConfirming(false)} aria-label="Cancel session closure"><X size={17}/></button>
            </div>
            {actionError ? <div className="notice notice-error" role="alert">{actionError}</div> : null}
            <div className={styles.confirmSummary}>
              <p><span>Table</span><strong>{String(details.table_number).padStart(2, '0')}</strong></p>
              <p><span>Session</span><strong>{details.session_id.slice(0, 8).toUpperCase()}</strong></p>
              <p><span>Total orders</span><strong>{details.order_count}</strong></p>
              <p><span>Total collected</span><strong>{amount(details.collected)}</strong></p>
              <p><span>Outstanding</span><strong>{amount(details.outstanding)}</strong></p>
            </div>
            {details.can_close ? <p className={styles.confirmReady}>All closure conditions are currently satisfied. The server will validate them again before closing.</p> : <div className={styles.blocker}>{details.reasons.join(' ')}</div>}
            <div className="modal-actions">
              <button className="button button-light" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button className="button button-primary" onClick={() => void closeSession()} disabled={busy || !details.can_close}>{busy ? 'Closing…' : 'Confirm close'}</button>
            </div>
          </section>
        </div>
      ) : null}

      {forceConfirming && details ? (
        <div className={`modal-backdrop ${styles.confirmBackdrop}`} onMouseDown={event => { if (event.target === event.currentTarget && !busy) setForceConfirming(false); }}>
          <section className="modal-card compact-modal" role="dialog" aria-modal="true" aria-labelledby="session-force-close-title">
            <div className="modal-head">
              <div><span className="eyebrow">AUDITED OVERRIDE</span><h2 id="session-force-close-title">Review cancelled-order payment</h2></div>
              <button className="icon-button" onClick={() => setForceConfirming(false)} aria-label="Cancel forced session closure" disabled={busy}><X size={17}/></button>
            </div>
            {actionError ? <div className="notice notice-error" role="alert">{actionError}</div> : null}
            <div className={styles.blocker}>
              This session has cancelled or rejected orders whose payment state is not marked failed or refunded. This override does not change payment records, issue refunds, or close sessions automatically. Same-visit reorders remain linked to this session until you explicitly close it.
            </div>
            <section className={styles.section}>
              <h3>Orders requiring review</h3>
              {details.orders.filter(order =>
                ['CANCELLED', 'REJECTED'].includes(order.status)
                && !['FAILED', 'REFUNDED'].includes(order.payment_status),
              ).map(order => (
                <div className={styles.detailRow} key={order.id}>
                  <div><strong>{orderLabel(order)}</strong><span>{order.status} · payment {order.payment_status}</span></div>
                  <b>{amount(order.total)}</b>
                </div>
              ))}
            </section>
            <label className={styles.forceReason}>
              Closure reason (required, 10–500 characters)
              <textarea value={forceReason} onChange={event => setForceReason(event.target.value)} maxLength={500} rows={3} placeholder="Explain how the cancelled-order payment state was reviewed." />
            </label>
            <label className={styles.forceAcknowledge}>
              <input type="checkbox" checked={forceAcknowledged} onChange={event => setForceAcknowledged(event.target.checked)} />
              <span>I reviewed the listed payment states and authorize closing this session without changing those financial records.</span>
            </label>
            <div className="modal-actions">
              <button className="button button-light" onClick={() => setForceConfirming(false)} disabled={busy}>Cancel</button>
              <button className="button button-primary" onClick={() => void forceCloseSession()} disabled={busy || !forceAcknowledged || forceReason.trim().length < 10}>
                {busy ? 'Closing…' : 'Confirm audited close'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
