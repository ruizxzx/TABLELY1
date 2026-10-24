'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, FileSearch, RefreshCw, Search } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { formatMoney } from '@/lib/customer';

type Row = {
  transaction_id: string | null; order_id: string; order_number: number | null; customer_name: string | null;
  expected_total: number; actual_amount: number | null; currency: string; provider: string; provider_order_id: string | null;
  provider_payment_id: string | null; method: string | null; transaction_status: string; order_payment_status: string;
  order_status: string; transaction_date: string; paid_at: string | null; issue: string | null; duplicate_reference: boolean;
};
type Dashboard = { rows: Row[]; total_rows: number; page: number; pageSize: number; summary: Record<string, number> };
const money = (amount: number | null | undefined) => formatMoney(Number(amount ?? 0));

export default function PaymentReconciliationPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [branchId] = useState(() => typeof window === 'undefined' ? '' : window.localStorage.getItem('tablely_active_branch') ?? '');

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (branchId) params.set('branchId', branchId);
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
    if (search) params.set('q', search);
    if (method) params.set('method', method);
    if (status) params.set('status', status);
    try {
      const response = await fetch(`/api/reconciliation?${params}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Unable to load reconciliation.');
      setError('');
      setData(body as Dashboard);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load reconciliation.'); }
    finally { setLoading(false); }
  }, [branchId, from, method, page, search, status, to]);

  useEffect(() => { if (!branchId) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [branchId, load]);

  const exportUrl = useMemo(() => {
    const params = new URLSearchParams({ export: 'csv' });
    if (branchId) params.set('branchId', branchId);
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
    if (search) params.set('q', search);
    if (method) params.set('method', method);
    if (status) params.set('status', status);
    return `/api/reconciliation?${params}`;
  }, [branchId, from, method, search, status, to]);

  async function addNote(row: Row) {
    const note = window.prompt(`Add an audit note for order #${row.order_number ?? row.order_id.slice(0, 8)}. This will be stored in the reconciliation history.`);
    if (!note?.trim()) return;
    const response = await fetch('/api/reconciliation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: row.order_id, transactionId: row.transaction_id, note, action: 'NOTE' }) });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? 'Could not save note.');
    else setError('Audit note saved.');
  }

  async function verifyGateway(row: Row) {
    setError('');
    try {
      const response = await fetch('/api/reconciliation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'verify_gateway', orderId: row.order_id, transactionId: row.transaction_id }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Gateway verification failed.');
      setError(body.captured ? 'Razorpay confirmed the captured payment and TABLELY reconciled it.' : `Gateway payment status: ${body.gatewayStatus}. No settlement was made.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Gateway verification failed.'); }
  }

  const summary = data?.summary ?? {};
  const pages = Math.max(1, Math.ceil((data?.total_rows ?? 0) / (data?.pageSize ?? 50)));
  return <StudioShell>
    <SectionHeader eyebrow="MONEY · BUILD 29" title="Payment reconciliation" description="Trace order payments against the existing transaction ledger and review inconsistencies." action={<div className="button-row"><Link href="/payments" className="button button-light"><ArrowLeft size={15}/> Payments</Link><button className="button button-light" onClick={() => { setLoading(true); void load(); }}><RefreshCw size={15}/> Refresh</button><a className="button button-primary" href={exportUrl}><Download size={15}/> Export CSV</a></div>} />
    {error ? <div className={error === 'Audit note saved.' ? 'notice notice-success' : 'notice notice-error'} role="status">{error}</div> : null}
    <div className="metric-grid">
      <Metric label="Gross collected" value={money(summary.gross_collected)} detail="Paid order totals" />
      <Metric label="Refunded" value={money(summary.refunds)} detail="Orders marked refunded" />
      <Metric label="Outstanding" value={money(summary.outstanding)} detail={`${summary.pending_orders ?? 0} pending orders`} />
      <Metric label="Online" value={money(summary.online_collected)} detail="Verified PAY_NOW orders" />
      <Metric label="Cash" value={money(summary.cash_collected)} detail="Recorded counter payments" />
      <Metric label="Counter UPI" value={money(summary.counter_upi_collected)} detail={`${summary.failed_orders ?? 0} failed orders`} />
    </div>
    <section className="surface-card" style={{ marginTop: 18 }}>
      <form className="reconciliation-filters" onSubmit={event => { event.preventDefault(); setPage(1); setSearch(query.trim()); }}>
        <label className="reconciliation-search"><span>Search</span><div><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Order, customer or payment reference" /></div></label>
        <label><span>From</span><input type="date" value={from} onChange={event => { setFrom(event.target.value); setPage(1); }} /></label>
        <label><span>To</span><input type="date" value={to} onChange={event => { setTo(event.target.value); setPage(1); }} /></label>
        <label><span>Method</span><select value={method} onChange={event => { setMethod(event.target.value); setPage(1); }}><option value="">All methods</option>{['PAY_NOW','CASH','UPI','CARD','SPLIT'].map(option => <option key={option}>{option}</option>)}</select></label>
        <label><span>Status</span><select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{['CAPTURED','PAID','PENDING','FAILED','CANCELLED','UNRECORDED'].map(option => <option key={option}>{option}</option>)}</select></label>
        <button className="button button-primary" type="submit"><Search size={14}/> Search</button>
      </form>
      <div className="data-table payment-reconciliation-table">
        <div className="data-row data-head"><span>Transaction / Order</span><span>Customer</span><span>Method / Gateway</span><span>Expected / collected</span><span>State</span><span>When</span><span/></div>
        {loading ? <div className="empty-wide">Loading transactions…</div> : data?.rows.map(row => <div className="data-row" key={row.transaction_id ?? `order-${row.order_id}`}>
          <div><strong>{row.transaction_id ? `TX ${row.transaction_id.slice(0, 8)}` : 'No ledger transaction'}</strong><span>Order #{row.order_number ?? row.order_id.slice(0, 8)}</span>{row.provider_payment_id ? <span>Ref {row.provider_payment_id}</span> : null}</div>
          <span>{row.customer_name || 'Customer'}</span>
          <div><strong>{row.method || '—'}</strong><span>{row.provider}</span></div>
          <div><strong>{money(row.expected_total)}</strong><span>{row.actual_amount == null ? 'No payment row' : `Recorded ${money(row.actual_amount)}`}</span></div>
          <div><span className={`payment-state ${String(row.transaction_status || row.order_payment_status).toLowerCase()}`}>{row.transaction_status || row.order_payment_status}</span>{row.issue ? <strong className="reconciliation-issue">{row.issue.replaceAll('_', ' ')}</strong> : <span>Order {row.order_payment_status}</span>}</div>
          <span>{new Date(row.transaction_date).toLocaleString('en-IN')}</span>
          <div className="button-row"><button className="button button-light compact" onClick={() => void addNote(row)} aria-label="Add investigation note"><FileSearch size={14}/> Note</button>{row.provider === 'RAZORPAY' && row.provider_payment_id ? <button className="button button-light compact" onClick={() => void verifyGateway(row)}>Verify</button> : null}</div>
        </div>)}
        {!loading && !data?.rows.length ? <div className="empty-wide">No matching payment records.</div> : null}
      </div>
      <div className="reconciliation-pagination"><span>{data?.total_rows ?? 0} matching records · page {page} of {pages}</span><div className="button-row"><button className="button button-light compact" disabled={page <= 1 || loading} onClick={() => setPage(current => current - 1)}>Previous</button><button className="button button-light compact" disabled={page >= pages || loading} onClick={() => setPage(current => current + 1)}>Next</button></div></div>
    </section>
  </StudioShell>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="metric-card"><div className="metric-head"><span>{label}</span></div><strong>{value}</strong><small>{detail}</small></div>;
}
