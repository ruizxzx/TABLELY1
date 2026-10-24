'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Send } from 'lucide-react';
import styles from '../../support/SupportInbox.module.css';

type Ticket = {
  id: string;
  ticket_number: string;
  organization_id: string;
  branch_id: string | null;
  category: string;
  subject: string;
  description: string;
  priority: string;
  status: string;
  assigned_to: string | null;
  last_message_at: string;
  created_at: string;
  organization: { id: string; name: string; slug: string; created_at: string } | null;
  branch?: { id: string; name: string } | null;
};

type Message = { id: string; author_type: string; body: string; created_at: string };
type InternalNote = { id: string; body: string; created_at: string };

const statuses = ['ALL', 'NEW', 'OPEN', 'WAITING_FOR_RESTAURANT', 'ESCALATED', 'RESOLVED', 'CLOSED'];
const priorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export default function PlatformSupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<InternalNote[]>([]);
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [composerType, setComposerType] = useState<'message' | 'note'>('message');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function loadTickets() {
    setError('');
    const response = await fetch(`/api/admin/support/tickets?status=${statusFilter}`, { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'Support inbox could not be loaded.');
    setTickets((result.tickets ?? []) as Ticket[]);
    if (selected && !(result.tickets ?? []).some((ticket: Ticket) => ticket.id === selected.id)) setSelected(null);
  }

  async function loadDetail(ticket: Ticket) {
    setError('');
    const response = await fetch(`/api/admin/support/tickets/${ticket.id}`, { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'Support conversation could not be loaded.');
    setSelected(result.ticket as Ticket);
    setMessages((result.messages ?? []) as Message[]);
    setNotes((result.internalNotes ?? []) as InternalNote[]);
  }

  useEffect(() => {
    void loadTickets().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Support inbox could not be loaded.'))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !body.trim()) return;
    setError('');
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/support/tickets/${selected.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: composerType, body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Could not save the support update.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the support update.');
      return;
    } finally {
      setBusy(false);
    }
    setBody('');
    try {
      await Promise.all([loadDetail(selected), loadTickets()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The update was saved, but the latest support data could not be loaded.');
    }
  }

  async function updateTicket(patch: Record<string, string>) {
    if (!selected) return;
    setError('');
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/support/tickets/${selected.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Ticket could not be updated.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ticket could not be updated.');
      return;
    } finally {
      setBusy(false);
    }
    try {
      await Promise.all([loadDetail(selected), loadTickets()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The ticket was updated, but the latest support data could not be loaded.');
    }
  }

  return (
    <main className="admin-page">
      <header className="admin-top">
        <div><span className="eyebrow">TABLELY PLATFORM ADMIN</span><h1>Support centre</h1><p>Restaurant support requests and private conversations.</p></div>
        <div className="button-row"><Link className="button button-light" href="/admin"><ArrowLeft size={15} /> Admin dashboard</Link><button className="button button-light" onClick={() => void loadTickets().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Refresh failed.'))}><RefreshCw size={15} /> Refresh</button></div>
      </header>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      <div className={styles.adminToolbar}><label>Status<select className="field-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>{statuses.map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select></label></div>
      <div className={styles.layout}>
        <section className={`surface-card ${styles.ticketList}`} aria-label="Support inbox">
          <div className="card-heading"><div><h2>Ticket inbox</h2><p>{tickets.length} recent requests</p></div></div>
          {loading ? <p>Loading tickets…</p> : tickets.length ? tickets.map((ticket) => (
            <button className={`${styles.ticketItem} ${selected?.id === ticket.id ? styles.active : ''}`} key={ticket.id} onClick={() => void loadDetail(ticket).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not load conversation.'))}>
              <span><strong>{ticket.subject}</strong><small>{ticket.ticket_number} · {ticket.organization?.name ?? 'Restaurant'} · {ticket.status.replaceAll('_', ' ')}</small></span>
              <time>{ticket.priority}</time>
            </button>
          )) : <div className="empty-wide"><h3>No tickets found</h3><p>New restaurant requests will appear here.</p></div>}
        </section>
        <section className={`surface-card ${styles.conversation}`}>
          {selected ? (
            <>
              <div className="card-heading"><div><span className="eyebrow">{selected.ticket_number} · {selected.organization?.name ?? selected.organization_id}</span><h2>{selected.subject}</h2><p>{selected.category.replaceAll('_', ' ')} · {selected.branch?.name ?? 'Restaurant-wide'}</p></div></div>
              <div className={styles.adminControls}>
                <label>Priority<select className="field-select" value={selected.priority} disabled={busy} onChange={(event) => void updateTicket({ priority: event.target.value })}>{priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}</select></label>
                <label>Status<select className="field-select" value={selected.status} disabled={busy} onChange={(event) => void updateTicket({ status: event.target.value })}>{statuses.filter((status) => status !== 'ALL').map((status) => <option key={status} value={status}>{status.replaceAll('_', ' ')}</option>)}</select></label>
                <p>{selected.organization?.slug ?? selected.organization_id} · Created {new Date(selected.created_at).toLocaleString()}</p>
              </div>
              <div className={styles.messages}>
                {messages.map((message) => <article className={`${styles.message} ${message.author_type === 'PLATFORM' ? styles.fromPlatform : ''}`} key={message.id}>
                  <strong>{message.author_type === 'PLATFORM' ? 'TABLELY Support' : 'Restaurant'}</strong><p>{message.body}</p><time>{new Date(message.created_at).toLocaleString()}</time>
                </article>)}
                {notes.map((note) => <article className={`${styles.message} ${styles.internalNote}`} key={note.id}><strong>Private internal note</strong><p>{note.body}</p><time>{new Date(note.created_at).toLocaleString()}</time></article>)}
              </div>
              <form className={styles.reply} onSubmit={submit}>
                <label htmlFor="support-admin-reply">Add update</label>
                <select className="field-select" value={composerType} onChange={(event) => setComposerType(event.target.value as 'message' | 'note')}><option value="message">Reply to restaurant</option><option value="note">Private internal note</option></select>
                <textarea id="support-admin-reply" value={body} onChange={(event) => setBody(event.target.value)} maxLength={10000} rows={3} required />
                <button className="button button-primary" disabled={busy || !body.trim()}><Send size={15} /> {composerType === 'note' ? 'Save private note' : 'Send reply'}</button>
              </form>
            </>
          ) : <div className="empty-wide"><h3>Select a support ticket</h3><p>Choose a ticket to review the restaurant conversation.</p></div>}
        </section>
      </div>
    </main>
  );
}
