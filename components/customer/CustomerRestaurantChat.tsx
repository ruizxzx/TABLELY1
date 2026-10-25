'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageCircle, Send, Sparkles, X } from 'lucide-react';
import { getOrCreateVisitToken } from '@/lib/customer';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { AssistantChat } from '@/components/ai/AssistantChat';
import styles from './CustomerRestaurantChat.module.css';

type Conversation = {
  id: string;
  status: string;
  expiresAt: string;
  channel: string;
  tableNumber: number;
};

type Message = {
  id: string;
  client_message_id: string;
  sender_type: 'CUSTOMER' | 'STAFF';
  body: string;
  created_at: string;
  failed?: boolean;
};

function mergeMessages(current: Message[], incoming: Message[]) {
  const merged = [...current];
  for (const message of incoming) {
    const index = merged.findIndex((item) =>
      item.id === message.id ||
      item.client_message_id === message.client_message_id ||
      item.id === `pending:${message.client_message_id}`,
    );
    if (index < 0) merged.push(message);
    else merged[index] = { ...merged[index], ...message, failed: false };
  }
  return merged.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function CustomerRestaurantChat({ tableCode }: { tableCode: string }) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'restaurant' | 'ai'>('restaurant');
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const listRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<string | null>(null);
  const latestRef = useRef<Message[]>([]);

  useEffect(() => { latestRef.current = messages; }, [messages]);

  async function catchUp(activeConversation: Conversation, visitToken: string) {
    if (getOrCreateVisitToken(tableCode) !== visitToken) {
      tokenRef.current = null;
      setConversation(null);
      setMessages([]);
      setOpen(false);
      return;
    }
    const latest = latestRef.current.filter((message) => !message.failed).at(-1);
    const query = new URLSearchParams();
    if (latest?.created_at && !latest.id.startsWith('pending:')) {
      query.set('after', latest.created_at);
      query.set('afterId', latest.id);
    }
    const response = await fetch(
      `/api/customer/conversations/${activeConversation.id}?${query.toString()}`,
      { cache: 'no-store', headers: { 'x-tablely-visit-token': visitToken } },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'Conversation could not be refreshed.');
    setConversation((current) => current ? { ...current, status: result.conversation.status } : current);
    setMessages((current) => mergeMessages(current, (result.messages ?? []) as Message[]));
  }

  useEffect(() => {
    if (!open || !conversation || !tokenRef.current) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setConnection('offline');
      return;
    }

    let active = true;
    const channel = supabase.channel(conversation.channel, { config: { private: true } })
      .on('broadcast', { event: 'NEW_MESSAGE' }, (event) => {
        const payload = event.payload as Message;
        if (!payload?.id || !payload.client_message_id || !payload.body) return;
        setMessages((current) => mergeMessages(current, [payload]));
      })
      .on('broadcast', { event: 'CONVERSATION_STATUS' }, (event) => {
        const payload = event.payload as { status?: string };
        if (payload.status === 'CLOSED') {
          tokenRef.current = null;
          setConversation(null);
          setMessages([]);
          setOpen(false);
          setError('This table visit has ended. Start a new visit to contact the restaurant.');
        } else if (payload.status) {
          setConversation((current) => current ? { ...current, status: payload.status! } : current);
        }
      })
      .subscribe((status) => {
        if (!active) return;
        if (status === 'SUBSCRIBED') {
          setConnection('connected');
          void catchUp(conversation, tokenRef.current!).catch((reason: unknown) => {
            if (active) setError(reason instanceof Error ? reason.message : 'Missed messages could not be recovered.');
          });
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnection('reconnecting');
        } else {
          setConnection('connecting');
        }
      });

    const onResume = () => {
      if (document.visibilityState === 'visible' && navigator.onLine && tokenRef.current) {
        void catchUp(conversation, tokenRef.current).catch((reason: unknown) => {
          if (active) setError(reason instanceof Error ? reason.message : 'Missed messages could not be recovered.');
        });
      }
    };
    const onVisitChange = () => {
      tokenRef.current = null;
      setConversation(null);
      setMessages([]);
      setOpen(false);
    };
    window.addEventListener('online', onResume);
    window.addEventListener('tablely-visit-change', onVisitChange);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      active = false;
      window.removeEventListener('online', onResume);
      window.removeEventListener('tablely-visit-change', onVisitChange);
      document.removeEventListener('visibilitychange', onResume);
      void supabase.removeChannel(channel);
    };
  }, [open, conversation?.id, conversation?.channel]);

  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, messages.length]);

  async function openConversation() {
    setOpen(true);
    setError('');
    setLoading(true);
    try {
      const visitToken = getOrCreateVisitToken(tableCode);
      if (!visitToken) throw new Error('This browser cannot securely save a visit. Enable browser storage and try again.');
      if (conversation && tokenRef.current === visitToken) {
        await catchUp(conversation, visitToken);
        setLoading(false);
        return;
      }
      if (tokenRef.current && tokenRef.current !== visitToken) {
        setConversation(null);
        setMessages([]);
      }
      tokenRef.current = visitToken;
      const response = await fetch('/api/customer/conversations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tableCode, visitToken }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Could not contact the restaurant.');
      const activeConversation = result.conversation as Conversation;
      setConversation(activeConversation);

      const historyResponse = await fetch(`/api/customer/conversations/${activeConversation.id}`, {
        cache: 'no-store',
        headers: { 'x-tablely-visit-token': visitToken },
      });
      const history = await historyResponse.json().catch(() => ({}));
      if (!historyResponse.ok) throw new Error(history.error ?? 'Conversation history could not be loaded.');
      setMessages((history.messages ?? []) as Message[]);
      setConversation((current) => current ? { ...current, status: history.conversation.status } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not contact the restaurant.');
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>, retry?: Message) {
    event?.preventDefault();
    if (!conversation || !tokenRef.current || sending) return;
    if (getOrCreateVisitToken(tableCode) !== tokenRef.current) {
      tokenRef.current = null;
      setConversation(null);
      setMessages([]);
      setOpen(false);
      setError('This visit changed. Open a new conversation to message the restaurant.');
      return;
    }
    const body = (retry?.body ?? draft).trim();
    if (!body) return;
    const clientMessageId = retry?.client_message_id ?? crypto.randomUUID();
    const optimistic: Message = {
      id: `pending:${clientMessageId}`,
      client_message_id: clientMessageId,
      sender_type: 'CUSTOMER',
      body,
      created_at: retry?.created_at ?? new Date().toISOString(),
    };
    setError('');
    setSending(true);
    setMessages((current) => mergeMessages(current, [optimistic]));
    if (!retry) setDraft('');
    try {
      const response = await fetch(`/api/customer/conversations/${conversation.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          visitToken: tokenRef.current,
          clientMessageId,
          body,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Message could not be sent.');
      setMessages((current) => mergeMessages(current, [result.message as Message]));
    } catch (reason) {
      setMessages((current) => current.map((message) =>
        message.client_message_id === clientMessageId ? { ...message, failed: true } : message,
      ));
      setError(reason instanceof Error ? reason.message : 'Message could not be sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" className={styles.launcher} aria-label="Message restaurant" onClick={() => void openConversation()}>
        <MessageCircle size={19} /><span>Message</span>
      </button>
      {open ? (
        <section className={styles.panel} aria-label="Restaurant chat and AI suggestions">
          <header className={styles.header}>
            <div><strong>{activeTab === 'restaurant' ? 'Message restaurant' : 'AI menu suggestions'}</strong><small>Table {conversation?.tableNumber ?? '—'}</small></div>
            <button type="button" aria-label="Close messages" onClick={() => setOpen(false)}><X size={18} /></button>
          </header>
          <nav className={styles.tabs} aria-label="Customer chat options">
            <button type="button" className={activeTab === 'restaurant' ? styles.activeTab : ''} aria-pressed={activeTab === 'restaurant'} onClick={() => { setActiveTab('restaurant'); if (!conversation) void openConversation(); }}><MessageCircle size={14} /> Chat with restaurant</button>
            <button type="button" className={activeTab === 'ai' ? styles.activeTab : ''} aria-pressed={activeTab === 'ai'} onClick={() => setActiveTab('ai')}><Sparkles size={14} /> Ask AI suggestions</button>
          </nav>
          {activeTab === 'ai' ? <AssistantChat audience="customer" tableCode={tableCode} /> : <>
          <div className={styles.connection} role="status">
            <span className={connection === 'connected' ? styles.connectedDot : styles.offlineDot} />
            {connection === 'connected' ? 'Live connection' : connection === 'offline' ? 'Connection unavailable' : 'Connecting…'}
          </div>
          {error ? <div className={styles.error} role="alert">{error}</div> : null}
          {loading ? <div className={styles.empty}>Opening your private conversation…</div> : (
            <>
              <div className={styles.messages} ref={listRef} aria-live="polite">
                {!messages.length ? <div className={styles.empty}>Ask the restaurant team about the menu or your order.</div> : null}
                {messages.map((message) => (
                  <article key={message.id} className={message.sender_type === 'CUSTOMER' ? styles.mine : styles.theirs}>
                    <p>{message.body}</p>
                    <small>{message.sender_type === 'CUSTOMER' ? 'You' : 'Restaurant'} · {new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{message.failed ? ' · Not sent' : message.id.startsWith('pending:') ? ' · Sending…' : ''}</small>
                    {message.failed ? <button type="button" onClick={(event) => {
                      event.preventDefault();
                      void sendMessage(undefined, message);
                    }}>Retry</button> : null}
                  </article>
                ))}
              </div>
              <form className={styles.composer} onSubmit={(event) => void sendMessage(event)}>
                <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} placeholder="Write a message…" aria-label="Your message" />
                <button type="submit" disabled={sending || !draft.trim()} aria-label="Send message"><Send size={17} /></button>
              </form>
              <p className={styles.privacy}>Only you and this restaurant can access this conversation.</p>
            </>
          )}
          </>}
        </section>
      ) : null}
    </>
  );
}
