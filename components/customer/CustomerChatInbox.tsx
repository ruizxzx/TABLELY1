'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, MessageCircle, Send, X } from 'lucide-react';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { showBrowserOrderNotification } from '@/lib/realtime-notifications';
import styles from './CustomerChatInbox.module.css';

type Conversation = {
  id: string;
  table_id: string;
  table_session_id: string | null;
  table_number: number | null;
  status: string;
  last_message_at: string;
  expires_at: string;
  unread_customer_count: number;
  latest_message?: string | null;
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

export function CustomerChatInbox() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ id: string; conversationId: string; title: string; message: string } | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const inboxRequestRef = useRef(0);
  const conversationRequestRef = useRef(0);
  const seenLatestRef = useRef(new Map<string, string>());
  const toastTimerRef = useRef<number | null>(null);
  const connectionRef = useRef(connection);

  const unreadCount = useMemo(
    () => conversations.reduce((total, conversation) => total + conversation.unread_customer_count, 0),
    [conversations],
  );

  const publishInbox = useCallback((rows: Conversation[]) => {
    window.dispatchEvent(new CustomEvent('tablely-customer-chat-inbox-changed', { detail: { conversations: rows } }));
  }, []);

  const loadInbox = useCallback(async (notify = false): Promise<boolean> => {
    if (!branchId) return false;
    const requestId = ++inboxRequestRef.current;
    const response = await fetch(`/api/customer-messages?branchId=${encodeURIComponent(branchId)}`, { cache: 'no-store' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error ?? 'Customer conversations could not be loaded.');
    if (requestId !== inboxRequestRef.current) return false;
    const rows = (result.conversations ?? []) as Conversation[];
    if (notify) {
      for (const conversation of rows) {
        const previous = seenLatestRef.current.get(conversation.id);
        if (previous && conversation.last_message_at > previous && conversation.unread_customer_count > 0) {
          const id = `${conversation.id}:${conversation.last_message_at}`;
          setToast({
            id,
            conversationId: conversation.id,
            title: `Table ${conversation.table_number ?? '—'} sent a message`,
            message: conversation.latest_message || 'Open the chat to read and reply.',
          });
          showBrowserOrderNotification({
            title: `New customer message · Table ${conversation.table_number ?? '—'}`,
            message: conversation.latest_message || 'Open the restaurant dashboard to reply.',
          });
          if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
          toastTimerRef.current = window.setTimeout(() => setToast(null), 6000);
        }
        seenLatestRef.current.set(conversation.id, conversation.last_message_at);
      }
    } else {
      for (const conversation of rows) seenLatestRef.current.set(conversation.id, conversation.last_message_at);
    }
    const selectedId = selectedIdRef.current;
    if (selectedId && !rows.some((conversation) => conversation.id === selectedId)) {
      selectedIdRef.current = null;
      setSelected(null);
      setMessages([]);
      setDraft('');
    }
    conversationsRef.current = rows;
    setConversations(rows);
    publishInbox(rows);
    return true;
  }, [branchId, publishInbox]);

  const loadConversation = useCallback(async (conversationId: string) => {
    if (!branchId) return;
    const requestId = ++conversationRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/customer-messages/${conversationId}?branchId=${encodeURIComponent(branchId)}`, { cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (requestId !== conversationRequestRef.current) return;
      if (response.status === 404 || response.status === 410) {
        selectedIdRef.current = null;
        setSelected(null);
        setMessages([]);
        void loadInbox();
        return;
      }
      if (!response.ok) throw new Error(result.error ?? 'Conversation could not be loaded.');
      const conversation = result.conversation as Conversation;
      selectedIdRef.current = conversationId;
      setSelected(conversation);
      setMessages((result.messages ?? []) as Message[]);
      const readResponse = await fetch(`/api/customer-messages/${conversationId}/read?branchId=${encodeURIComponent(branchId)}`, { method: 'POST' });
      const readResult = await readResponse.json().catch(() => ({}));
      if (requestId !== conversationRequestRef.current) return;
      if (readResponse.status === 404 || readResponse.status === 410) {
        selectedIdRef.current = null;
        setSelected(null);
        setMessages([]);
        void loadInbox();
        return;
      }
      if (!readResponse.ok) throw new Error(readResult.error ?? 'Conversation read state could not be saved.');
      const next = conversationsRef.current.map((item) => item.id === conversationId
        ? { ...item, unread_customer_count: 0 }
        : item);
      conversationsRef.current = next;
      setConversations(next);
      publishInbox(next);
    } catch (caught) {
      if (requestId === conversationRequestRef.current) {
        setError(caught instanceof Error ? caught.message : 'Conversation could not be loaded.');
      }
    } finally {
      if (requestId === conversationRequestRef.current) setLoading(false);
    }
  }, [branchId, loadInbox, publishInbox]);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void getCurrentRestaurantContext(supabase).then((context) => {
      if (!active) return;
      if (!context.data) throw context.error ?? new Error('Restaurant workspace could not be resolved.');
      setBranchId(context.data.branch.id);
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : 'Restaurant workspace could not be resolved.');
    });
    return () => { active = false; };
  }, [supabase]);

  useEffect(() => {
    if (!branchId) return;
    let active = true;
    let channel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null;
    const refresh = async (notify = false) => {
      try {
        const applied = await loadInbox(notify);
        if (active && applied) setError('');
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Customer conversations could not be loaded.');
      }
    };
    void refresh();
    if (supabase) {
      channel = supabase.channel(`tablely:customer-inbox:${branchId}`, { config: { private: true } })
        .on('broadcast', { event: 'CONVERSATION_UPDATED' }, (event) => {
          const payload = event.payload as { conversation_id?: string; sender_type?: string };
          void refresh(payload.sender_type === 'CUSTOMER');
          if (payload.conversation_id && payload.conversation_id === selectedIdRef.current) {
            void loadConversation(payload.conversation_id);
          }
        })
        .on('broadcast', { event: 'READ_STATE_CHANGED' }, () => void refresh())
        .subscribe((status) => {
          if (!active) return;
          if (status === 'SUBSCRIBED') {
            connectionRef.current = 'live';
            setConnection('live');
            void refresh();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            connectionRef.current = 'reconnecting';
            setConnection('reconnecting');
          } else {
            connectionRef.current = 'connecting';
            setConnection('connecting');
          }
        });
    } else {
      connectionRef.current = 'offline';
      setConnection('offline');
    }
    const timer = window.setInterval(() => {
      if (connectionRef.current !== 'live') void refresh();
    }, 20000);
    const onResume = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh();
    };
    window.addEventListener('online', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', onResume);
      document.removeEventListener('visibilitychange', onResume);
      if (channel && supabase) void supabase.removeChannel(channel);
    };
  }, [branchId, loadConversation, loadInbox, supabase]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
      setOpen(true);
      if (conversationId) {
        setMobileThreadOpen(true);
        void loadConversation(conversationId);
      }
    };
    window.addEventListener('tablely-open-customer-chat', onOpen);
    return () => window.removeEventListener('tablely-open-customer-chat', onOpen);
  }, [loadConversation]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !draft.trim() || sending) return;
    const body = draft.trim();
    const clientMessageId = crypto.randomUUID();
    setSending(true);
    setError('');
    try {
      const response = await fetch(`/api/customer-messages/${selected.id}?branchId=${encodeURIComponent(branchId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientMessageId, body }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Reply could not be sent.');
      setMessages((current) => mergeMessages(current, [result.message as Message]));
      setDraft('');
      await loadInbox();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Reply could not be sent.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.root}>
      {toast ? (
        <div className={styles.toast} role="status" aria-live="polite" key={toast.id}>
          <MessageCircle size={17} />
          <span><strong>{toast.title}</strong><small>{toast.message}</small></span>
          <button type="button" className="icon-button" aria-label={`Open chat for ${toast.title}`} onClick={() => { setOpen(true); setMobileThreadOpen(true); void loadConversation(toast.conversationId); }}><MessageCircle size={14} /></button>
          <button className="icon-button" aria-label="Dismiss message notification" onClick={(event) => { event.stopPropagation(); setToast(null); }}><X size={14} /></button>
        </div>
      ) : null}
      <button
        type="button"
        className={styles.trigger}
        aria-label={`Customer messages${unreadCount ? `, ${unreadCount} unread` : ''}`}
        title="Customer messages"
        onClick={() => {
          if (open) {
            setOpen(false);
            setMobileThreadOpen(false);
          } else {
            setOpen(true);
            void loadInbox();
          }
        }}
      >
        <MessageCircle size={18} />
        {unreadCount > 0 ? <span className={styles.count}>{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
      </button>
      {open ? (
        createPortal(
        <>
        <div className={styles.backdrop} aria-hidden="true" onClick={() => { setOpen(false); setMobileThreadOpen(false); }} />
        <section className={styles.panel} aria-label="Customer live chat">
          <header className={styles.header}>
            <div><strong>Customer messages</strong><small>{unreadCount ? `${unreadCount} new · ` : ''}{connection === 'live' ? 'Live' : connection}</small></div>
            <div className={styles.headerActions}>
              <button type="button" className="icon-button" aria-label="Refresh conversations" title="Refresh conversations" onClick={() => void loadInbox()}><MessageCircle size={15} /></button>
              <button type="button" className="icon-button" aria-label="Close customer messages" onClick={() => { setOpen(false); setMobileThreadOpen(false); }}><X size={16} /></button>
            </div>
          </header>
          {error ? <div className={styles.error} role="alert">{error}</div> : null}
          <div className={styles.body} data-mobile-view={mobileThreadOpen ? 'thread' : 'list'}>
            <aside className={styles.list} aria-label="Active customer chats">
              {conversations.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  className={`${styles.conversation} ${selected?.id === conversation.id ? styles.selected : ''}`}
                  onClick={() => { setMobileThreadOpen(true); void loadConversation(conversation.id); }}
                >
                  <span className={styles.conversationTop}><strong>Table {conversation.table_number ?? '—'}</strong>{conversation.unread_customer_count ? <b>{conversation.unread_customer_count}</b> : null}</span>
                  <small>{conversation.table_session_id ? `Session ${conversation.table_session_id.slice(0, 8).toUpperCase()}` : 'Awaiting table session'}</small>
                  <span className={styles.preview}>{conversation.latest_message || 'Open conversation'}</span>
                  <time>{new Date(conversation.last_message_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
                </button>
              ))}
              {!conversations.length ? <p className={styles.empty}>No active guest conversations.</p> : null}
            </aside>
            <div className={styles.thread}>
              {selected ? (
                <>
                  <div className={styles.threadHeader}>
                    <button type="button" className={styles.backToConversations} onClick={() => setMobileThreadOpen(false)} aria-label="Back to conversations"><ArrowLeft size={17}/><span>Chats</span></button>
                    <div><strong>Table {selected.table_number ?? '—'}</strong><small>{selected.table_session_id ? `Session ${selected.table_session_id.slice(0, 8).toUpperCase()}` : 'Not linked to a table session yet'}</small></div>
                  </div>
                  <div className={styles.messages}>
                    {loading ? <p className={styles.empty}>Loading messages…</p> : messages.map((message) => (
                      <article key={message.id} className={`${styles.message} ${message.sender_type === 'STAFF' ? styles.staffMessage : ''}`}>
                        <span>{message.sender_type === 'STAFF' ? 'Restaurant team' : 'Guest'}</span>
                        <p>{message.body}</p>
                        <time>{new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
                      </article>
                    ))}
                    {!loading && !messages.length ? <p className={styles.empty}>No messages yet.</p> : null}
                  </div>
                  <form className={styles.reply} onSubmit={(event) => void sendReply(event)}>
                    <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={2} maxLength={4000} placeholder="Reply to the guest…" required />
                    <button type="submit" className="button button-primary compact" disabled={sending || !draft.trim()} aria-label={sending ? 'Sending reply' : 'Send reply'}>
                      <Send size={15} />{sending ? 'Sending…' : 'Send'}
                    </button>
                  </form>
                </>
              ) : <div className={styles.empty}>Select a conversation to read and reply.</div>}
            </div>
          </div>
          <a className={styles.fullInbox} href="/customer-messages">Open full inbox</a>
        </section>
        </>,
        document.body,
        )
      ) : null}
    </div>
  );
}
