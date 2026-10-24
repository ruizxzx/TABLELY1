'use client';

import { FormEvent, useEffect, useState } from 'react';
import { MessageCircle, Plus, RefreshCw, Send } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import styles from './SupportInbox.module.css';

type Ticket = {
  id: string;
  ticket_number: string;
  category: string;
  subject: string;
  description: string;
  priority: string;
  status: string;
  last_message_at: string;
  created_at: string;
};

type Message = {
  id: string;
  author_type: 'RESTAURANT' | 'PLATFORM';
  body: string;
  created_at: string;
};

const categories = [
  ['TECHNICAL', 'Technical issues'],
  ['QR_MENU', 'QR and menu'],
  ['PAYMENTS', 'Payments'],
  ['BILLING', 'Billing'],
  ['SUBSCRIPTION', 'Subscription'],
  ['BRANCH', 'Branch management'],
  ['STAFF_PERMISSIONS', 'Staff and permissions'],
  ['WHATSAPP', 'WhatsApp'],
  ['GOOGLE_REVIEWS', 'Google Reviews'],
  ['GENERAL', 'General enquiry'],
  ['FEATURE_REQUEST', 'Feature request'],
];

const statusLabel: Record<string, string> = {
  NEW: 'New',
  OPEN: 'Open',
  WAITING_FOR_RESTAURANT: 'Waiting for you',
  ESCALATED: 'Escalated',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState(categories[0][0]);
  const [description, setDescription] = useState('');
  const [reply, setReply] = useState('');
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function loadTickets() {
    setError('');
    const response = await fetch('/api/support/tickets', { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'Support requests could not be loaded.');
    const rows = (result.tickets ?? []) as Ticket[];
    setTickets(rows);
    if (selected) {
      const current = rows.find((ticket) => ticket.id === selected.id);
      if (current) setSelected(current);
    }
  }

  async function loadConversation(ticket: Ticket) {
    setError('');
    const response = await fetch(`/api/support/tickets/${ticket.id}`, { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'Support conversation could not be loaded.');
    setSelected(result.ticket as Ticket);
    setMessages((result.messages ?? []) as Message[]);
  }

  useEffect(() => {
    void loadTickets().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Support requests could not be loaded.'))
      .finally(() => setLoading(false));
  }, []);

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSending(true);
    let createdTicket: Ticket | null = null;
    try {
      const response = await fetch('/api/support/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category, subject, description }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Support request could not be created.');
      createdTicket = result.ticket as Ticket;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Support request could not be created.');
      return;
    } finally {
      setSending(false);
    }
    setSubject('');
    setDescription('');
    setCreating(false);
    try {
      await loadTickets();
      if (createdTicket) await loadConversation(createdTicket);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your request was created, but the latest support data could not be loaded.');
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !reply.trim()) return;
    setError('');
    setSending(true);
    try {
      const response = await fetch(`/api/support/tickets/${selected.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: reply }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Message could not be sent.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Message could not be sent.');
      return;
    } finally {
      setSending(false);
    }
    setReply('');
    try {
      await Promise.all([loadConversation(selected), loadTickets()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your reply was sent, but the latest support data could not be loaded.');
    }
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="TABLELY SUPPORT"
        title="Help & Support"
        description="Contact the TABLELY team about your account, billing, or restaurant operations."
        action={
          <div className="button-row">
            <button className="button button-light" onClick={() => void loadTickets().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Refresh failed.'))}>
              <RefreshCw size={15} /> Refresh
            </button>
            <button className="button button-primary" onClick={() => setCreating((value) => !value)}>
              <Plus size={15} /> New request
            </button>
          </div>
        }
      />
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {creating ? (
        <form className={`surface-card ${styles.createForm}`} onSubmit={createTicket}>
          <div className="card-heading"><div><h2>Contact TABLELY support</h2><p>Do not include passwords, API keys, or payment credentials.</p></div></div>
          <div className={styles.createGrid}>
            <label>Category<select className="field-select" value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Subject<input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={160} required /></label>
          </div>
          <label>Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={10000} rows={5} required /></label>
          <div className="button-row"><button className="button button-primary" type="submit" disabled={sending}>{sending ? 'Submitting…' : 'Submit request'}</button><button className="button button-light" type="button" onClick={() => setCreating(false)}>Cancel</button></div>
        </form>
      ) : null}
      <div className={styles.layout}>
        <section className={`surface-card ${styles.ticketList}`} aria-label="Your support requests">
          <div className="card-heading"><div><h2>Your requests</h2><p>Private conversations between your restaurant and TABLELY.</p></div></div>
          {loading ? <p>Loading support requests…</p> : tickets.length ? tickets.map((ticket) => (
            <button className={`${styles.ticketItem} ${selected?.id === ticket.id ? styles.active : ''}`} key={ticket.id} onClick={() => void loadConversation(ticket).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not load conversation.'))}>
              <span><strong>{ticket.subject}</strong><small>{ticket.ticket_number} · {statusLabel[ticket.status] ?? ticket.status}</small></span>
              <time>{new Date(ticket.last_message_at).toLocaleDateString()}</time>
            </button>
          )) : <div className="empty-wide"><h3>No support requests yet</h3><p>Create a request and the TABLELY team will reply here.</p></div>}
        </section>
        <section className={`surface-card ${styles.conversation}`}>
          {selected ? (
            <>
              <div className="card-heading"><div><span className="eyebrow">{selected.ticket_number} · {statusLabel[selected.status] ?? selected.status}</span><h2>{selected.subject}</h2><p>{selected.category.replaceAll('_', ' ')}</p></div><MessageCircle size={19} /></div>
              <div className={styles.messages}>
                {messages.map((message) => <article className={`${styles.message} ${message.author_type === 'PLATFORM' ? styles.fromPlatform : ''}`} key={message.id}>
                  <strong>{message.author_type === 'PLATFORM' ? 'TABLELY Support' : 'Your restaurant'}</strong>
                  <p>{message.body}</p>
                  <time>{new Date(message.created_at).toLocaleString()}</time>
                </article>)}
              </div>
              <form className={styles.reply} onSubmit={sendReply}>
                <label htmlFor="support-reply">Reply</label>
                <textarea id="support-reply" value={reply} onChange={(event) => setReply(event.target.value)} maxLength={10000} rows={3} required />
                <button className="button button-primary" disabled={sending || !reply.trim()}><Send size={15} /> Send reply</button>
              </form>
            </>
          ) : <div className="empty-wide"><h3>Select a support request</h3><p>Choose a request to view its conversation.</p></div>}
        </section>
      </div>
    </StudioShell>
  );
}
