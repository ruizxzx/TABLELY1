'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { MessageCircle, RefreshCw, Send } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import styles from '../support/SupportInbox.module.css';

type Conversation = {
  id: string;
  table_id: string;
  table_number: number | null;
  status: string;
  created_at: string;
  last_message_at: string;
  expires_at: string;
};
type Message = {
  id: string;
  client_message_id: string;
  sender_type: 'CUSTOMER' | 'STAFF';
  sender_user_id: string | null;
  body: string;
  created_at: string;
};

function mergeMessages(current: Message[], incoming: Message[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export default function CustomerMessagesPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [branchId, setBranchId] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const selectedIdRef = useRef<string | null>(null);

  async function loadInbox(requestedBranchId = branchId) {
    if (!requestedBranchId) return;
    const response = await fetch(`/api/customer-messages?branchId=${encodeURIComponent(requestedBranchId)}`, { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'Customer messages could not be loaded.');
    const rows = (result.conversations ?? []) as Conversation[];
    setConversations(rows);
    if (selectedIdRef.current) {
      const current = rows.find((conversation) => conversation.id === selectedIdRef.current);
      if (current) setSelected(current);
    }
  }

  async function loadConversation(conversationId: string) {
    if (!branchId) return;
    const response = await fetch(`/api/customer-messages/${conversationId}?branchId=${encodeURIComponent(branchId)}`, { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'Conversation could not be loaded.');
    selectedIdRef.current = conversationId;
    setSelected(result.conversation as Conversation);
    setMessages((result.messages ?? []) as Message[]);
  }

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    let active = true;
    void getCurrentRestaurantContext(supabase).then((result) => {
      if (!active) return;
      if (!result.data) throw result.error ?? new Error('Restaurant workspace could not be resolved.');
      setBranchId(result.data.branch.id);
      void loadInbox(result.data.branch.id).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Inbox could not be loaded.'))
        .finally(() => { if (active) setLoading(false); });
    }).catch((reason: unknown) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : 'Restaurant workspace could not be resolved.');
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !branchId) return;
    let active = true;
    const channel = supabase.channel(`tablely:customer-inbox:${branchId}`, { config: { private: true } })
      .on('broadcast', { event: 'CONVERSATION_UPDATED' }, (event) => {
        const conversationId = (event.payload as { conversation_id?: string }).conversation_id;
        void loadInbox().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Inbox refresh failed.'));
        if (conversationId && conversationId === selectedIdRef.current) {
          void loadConversation(conversationId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Conversation refresh failed.'));
        }
      })
      .subscribe((status) => {
        if (!active) return;
        if (status === 'SUBSCRIBED') {
          setConnection('connected');
          void loadInbox().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Inbox refresh failed.'));
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnection('reconnecting');
        } else {
          setConnection('connecting');
        }
      });
    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [branchId]);

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !draft.trim() || sending) return;
    setSending(true);
    setError('');
    const clientMessageId = crypto.randomUUID();
    const body = draft.trim();
    setDraft('');
    try {
      const response = await fetch(`/api/customer-messages/${selected.id}?branchId=${encodeURIComponent(branchId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientMessageId, body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Reply could not be sent.');
      setMessages((current) => mergeMessages(current, [result.message as Message]));
      await loadInbox();
    } catch (reason) {
      setDraft(body);
      setError(reason instanceof Error ? reason.message : 'Reply could not be sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="CUSTOMER SERVICE"
        title="Customer messages"
        description="Private conversations from guests browsing your restaurant menu."
        action={<button className="button button-light" onClick={() => void loadInbox().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Refresh failed.'))}><RefreshCw size={15} /> Refresh</button>}
      />
      <div className="live-status"><span className={`status-dot ${connection === 'connected' ? 'online' : 'offline'}`} />{connection === 'connected' ? 'Live' : connection}</div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      <div className={styles.layout}>
        <section className={`surface-card ${styles.ticketList}`} aria-label="Customer conversations">
          <div className="card-heading"><div><h2>Conversations</h2><p>{conversations.length} recent</p></div></div>
          {loading ? <p>Loading conversations…</p> : conversations.length ? conversations.map((conversation) => (
            <button
              className={`${styles.ticketItem} ${selected?.id === conversation.id ? styles.active : ''}`}
              key={conversation.id}
              onClick={() => void loadConversation(conversation.id).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Conversation could not be loaded.'))}
            >
              <span><strong>Table {conversation.table_number ?? '—'}</strong><small>{conversation.status} · {new Date(conversation.last_message_at).toLocaleString()}</small></span>
              <MessageCircle size={16} />
            </button>
          )) : <div className="empty-wide"><h3>No customer messages</h3><p>New guest conversations will appear here.</p></div>}
        </section>
        <section className={`surface-card ${styles.conversation}`}>
          {selected ? (
            <>
              <div className="card-heading"><div><span className="eyebrow">TABLE {selected.table_number ?? '—'}</span><h2>Guest conversation</h2><p>{selected.status} · Available until {new Date(selected.expires_at).toLocaleString()}</p></div></div>
              <div className={styles.messages}>
                {messages.map((message) => (
                  <article className={`${styles.message} ${message.sender_type === 'STAFF' ? styles.fromPlatform : ''}`} key={message.id}>
                    <strong>{message.sender_type === 'STAFF' ? 'Restaurant team' : 'Guest'}</strong>
                    <p>{message.body}</p>
                    <time>{new Date(message.created_at).toLocaleString()}</time>
                  </article>
                ))}
                {!messages.length ? <p className="muted-small">No messages yet. The guest will see your reply immediately.</p> : null}
              </div>
              <form className={styles.reply} onSubmit={(event) => void sendReply(event)}>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} rows={3} placeholder="Reply to this guest…" required />
                <button className="button button-primary" type="submit" disabled={sending || !draft.trim()}><Send size={15} />{sending ? 'Sending…' : 'Send reply'}</button>
              </form>
            </>
          ) : <div className="empty-wide"><h3>Select a conversation</h3><p>Guest messages stay separate from TABLELY support tickets.</p></div>}
        </section>
      </div>
    </StudioShell>
  );
}
