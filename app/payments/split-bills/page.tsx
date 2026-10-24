'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, RefreshCw, Scissors } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { formatMoney } from '@/lib/customer';
import { allocationsMatchTotal, equalSplitPaise, parseRupeesToPaise } from '@/lib/split-billing.mjs';

type Participant = { id: string; participant_key: string; display_name: string; allocated_amount_paise: number; paid_amount_paise: number; status: string };
type Order = { id: string; order_number: number | null; total: number; payment_status: string; created_at: string; customer_name: string | null; split: null | { id: string; split_method: string; status: string; participants: Participant[] } };
type DraftParticipant = { key: string; name: string; amount: string };
const toPaise = (value: string) => parseRupeesToPaise(value) ?? 0;
const fromPaise = (value: number) => (value / 100).toFixed(2);

export default function SplitBillsPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [branchId] = useState(() => typeof window === 'undefined' ? '' : window.localStorage.getItem('tablely_active_branch') ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [method, setMethod] = useState<'EQUAL' | 'CUSTOM'>('EQUAL');
  const [draft, setDraft] = useState<DraftParticipant[]>([
    { key: '1', name: 'Customer 1', amount: '' }, { key: '2', name: 'Customer 2', amount: '' },
  ]);
  const [collectMethod, setCollectMethod] = useState<Record<string, string>>({});
  const [collectAmounts, setCollectAmounts] = useState<Record<string, string>>({});
  const collectionKeys = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const params = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
      const response = await fetch(`/api/split-bills${params}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not load split bills.');
      setError('');
      setOrders(body.orders as Order[]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load split bills.'); }
    finally { setLoading(false); }
  }, [branchId]);
  useEffect(() => { if (!branchId) return; const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [branchId, load]);

  const selected = useMemo(() => orders.find(order => order.id === editing) ?? null, [editing, orders]);
  function begin(order: Order) {
    setEditing(order.id); setMethod(order.split?.split_method === 'CUSTOM' ? 'CUSTOM' : 'EQUAL');
    if (order.split?.participants.length) setDraft(order.split.participants.map(person => ({ key: person.participant_key, name: person.display_name, amount: fromPaise(person.allocated_amount_paise) })));
    else setDraft([{ key: '1', name: 'Customer 1', amount: '' }, { key: '2', name: 'Customer 2', amount: '' }]);
  }
  function changeCount(count: number) {
    const clamped = Math.max(2, Math.min(20, count));
    setDraft(current => Array.from({ length: clamped }, (_, index) => current[index] ?? { key: String(index + 1), name: `Customer ${index + 1}`, amount: '' }));
  }
  function equalize(total: number) {
    const amounts = equalSplitPaise(parseRupeesToPaise(String(total)) ?? 0, draft.length);
    setDraft(current => current.map((person, index) => ({ ...person, amount: fromPaise(amounts[index]) })));
  }
  async function saveSplit() {
    if (!selected) return;
    const participants = draft.map(person => ({ key: person.key, name: person.name.trim(), amount_paise: toPaise(person.amount) }));
    if (participants.some(person => !person.name || !Number.isSafeInteger(person.amount_paise) || person.amount_paise < 1)) { setError('Enter a name and positive amount for each participant.'); return; }
    if (!allocationsMatchTotal(participants.map(person => person.amount_paise), parseRupeesToPaise(String(selected.total)) ?? -1)) { setError('Participant amounts must add up to the order total exactly.'); return; }
    setBusy(selected.id); setError('');
    try {
      const response = await fetch('/api/split-bills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'configure', orderId: selected.id, method: method, participants }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not save this split.');
      setEditing(null); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this split.'); }
    finally { setBusy(''); }
  }
  async function collect(person: Participant) {
    const remaining = person.allocated_amount_paise - person.paid_amount_paise;
    if (remaining <= 0) return;
    const amountPaise = parseRupeesToPaise(collectAmounts[person.id] || fromPaise(remaining));
    if (!amountPaise || amountPaise > remaining) { setError('Collection amount must be positive and no more than this participant’s outstanding share.'); return; }
    const method = collectMethod[person.id] || 'CASH';
    const idempotencyKey = collectionKeys.current[person.id] ?? crypto.randomUUID();
    collectionKeys.current[person.id] = idempotencyKey;
    setBusy(person.id); setError('');
    try {
      const response = await fetch('/api/split-bills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'collect', participantId: person.id, amountPaise, method, idempotencyKey }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Could not record this payment.');
      delete collectionKeys.current[person.id];
      setCollectAmounts(current => ({ ...current, [person.id]: '' }));
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record this payment.'); }
    finally { setBusy(''); }
  }

  return <StudioShell>
    <SectionHeader eyebrow="MONEY · BUILD 29" title="Split bills" description="Divide an unpaid order into paise-accurate participant shares and record counter collections." action={<div className="button-row"><Link href="/payments" className="button button-light"><ArrowLeft size={15}/> Payments</Link><button className="button button-light" onClick={() => { setLoading(true); void load(); }}><RefreshCw size={15}/> Refresh</button></div>} />
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    <div className="notice notice-info">Split collections stay on the original order and write each received payment to TABLELY’s existing payment transaction ledger. Online split checkout is not enabled in this release.</div>
    <section className="split-bill-list">
      {loading ? <div className="surface-card">Loading unpaid bills…</div> : null}
      {!loading && !orders.length ? <div className="surface-card empty-wide"><h2>No unpaid bills</h2><p>Unpaid orders for this branch will appear here.</p></div> : null}
      {orders.map(order => <article className="surface-card split-bill-card" key={order.id}>
        <header><div><span className="eyebrow">ORDER #{order.order_number ?? order.id.slice(0, 8)}</span><h2>{order.customer_name || 'Restaurant guest'}</h2><p>{new Date(order.created_at).toLocaleString('en-IN')} · {order.payment_status}</p></div><strong>{formatMoney(order.total)}</strong></header>
        {order.split ? <>
          <div className="split-bill-summary"><Scissors size={15}/><span>{order.split.split_method.toLowerCase()} split · Outstanding {formatMoney(order.split.participants.reduce((sum, person) => sum + person.allocated_amount_paise - person.paid_amount_paise, 0) / 100)}</span><button className="button button-light compact" onClick={() => begin(order)} disabled={order.split.participants.some(person => person.paid_amount_paise > 0)}>Edit split</button></div>
          <div className="split-participants">{order.split.participants.map(person => {
            const remaining = person.allocated_amount_paise - person.paid_amount_paise;
            return <div className="split-participant" key={person.id}><div><strong>{person.display_name}</strong><span>Share {formatMoney(person.allocated_amount_paise / 100)} · Paid {formatMoney(person.paid_amount_paise / 100)} · Due {formatMoney(remaining / 100)}</span></div>{remaining ? <div className="button-row"><input className="split-collect-amount" aria-label={`Collection amount for ${person.display_name}`} inputMode="decimal" value={collectAmounts[person.id] ?? fromPaise(remaining)} onChange={event => setCollectAmounts(current => ({ ...current, [person.id]: event.target.value }))}/><select aria-label={`Payment method for ${person.display_name}`} value={collectMethod[person.id] || 'CASH'} onChange={event => setCollectMethod(current => ({ ...current, [person.id]: event.target.value }))}><option value="CASH">Cash</option><option value="UPI">Counter UPI</option><option value="CARD">Card</option></select><button className="button button-primary compact" disabled={Boolean(busy)} onClick={() => void collect(person)}>{busy === person.id ? 'Saving…' : 'Collect'}</button></div> : <span className="payment-state paid">Paid</span>}</div>;
          })}</div>
        </> : <div className="split-bill-summary"><span>Not split</span><button className="button button-primary compact" onClick={() => begin(order)}><Plus size={14}/> Split this bill</button></div>}
      </article>)}
    </section>
    {selected ? <div className="split-editor-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setEditing(null); }}><section className="surface-card split-editor" role="dialog" aria-modal="true" aria-labelledby="split-editor-title">
      <header><div><div className="eyebrow">ORDER #{selected.order_number ?? selected.id.slice(0, 8)}</div><h2 id="split-editor-title">Set participant shares</h2><p>Shares must equal {formatMoney(selected.total)}. Values are stored as integer paise.</p></div><button className="button button-light compact" onClick={() => setEditing(null)}>Close</button></header>
      <div className="split-editor-controls"><label>Split type<select value={method} onChange={event => setMethod(event.target.value as 'EQUAL' | 'CUSTOM')}><option value="EQUAL">Equal split</option><option value="CUSTOM">Custom amounts</option></select></label><label>Participants<select value={draft.length} onChange={event => changeCount(Number(event.target.value))}>{Array.from({ length: 19 }, (_, index) => index + 2).map(number => <option key={number} value={number}>{number}</option>)}</select></label><button className="button button-light" onClick={() => equalize(selected.total)}>Divide equally</button></div>
      <div className="split-draft-list">{draft.map((person, index) => <div className="split-draft-row" key={person.key}><label>Customer name<input value={person.name} maxLength={80} onChange={event => setDraft(current => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/></label><label>Share amount<input inputMode="decimal" value={person.amount} onChange={event => setDraft(current => current.map((item, i) => i === index ? { ...item, amount: event.target.value } : item))}/></label></div>)}</div>
      <footer><span>Allocated {formatMoney(draft.reduce((sum, person) => sum + (Number.isFinite(toPaise(person.amount)) ? toPaise(person.amount) : 0), 0) / 100)} / {formatMoney(selected.total)}</span><button className="button button-primary" disabled={Boolean(busy)} onClick={() => void saveSplit()}>{busy ? 'Saving…' : 'Save split'}</button></footer>
    </section></div> : null}
  </StudioShell>;
}
