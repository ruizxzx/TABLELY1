'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Send, Sparkles } from 'lucide-react';
import styles from './AssistantChat.module.css';

type LinkSuggestion = { label: string; href: string };
type MenuSuggestion = { id: string; name: string; description?: string | null; category?: string; price?: number };
type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  links?: LinkSuggestion[];
  recommendations?: MenuSuggestion[];
};
type Props = {
  audience: 'staff' | 'customer';
  mode?: 'support' | 'analytics';
  branchId?: string;
  tableCode?: string;
};

const welcomeByMode = {
  support: 'Ask how to use TABLELY. I can point you to the right page and explain common workflows.',
  analytics: 'Ask about this branch’s analytics. I only use the permitted aggregate data for the selected date range.',
};

export function AssistantChat({ audience, mode = 'support', branchId, tableCode }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const customer = audience === 'customer';

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  async function send(event?: FormEvent<HTMLFormElement>, suggestedQuestion?: string) {
    event?.preventDefault();
    const question = (suggestedQuestion ?? draft).trim();
    if (!question || sending) return;
    setError('');
    setDraft('');
    setSending(true);
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(nextMessages);
    try {
      const endpoint = customer ? '/api/customer/ai-suggestions' : '/api/restaurant-ai';
      const payload = customer
        ? { tableCode, question, history: messages.slice(-4).map(({ role, content }) => ({ role, content: content.slice(0, 200) })) }
        : { branchId, mode, question, days: 30, history: messages.slice(-4).map(({ role, content }) => ({ role, content: content.slice(0, 240) })) };
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'The assistant could not reply.');
      setRemaining(typeof result.remainingRequests === 'number' ? result.remainingRequests : null);
      setMessages((current) => [...current, {
        role: 'assistant',
        content: String(result.answer ?? ''),
        links: Array.isArray(result.links) ? result.links as LinkSuggestion[] : [],
        recommendations: Array.isArray(result.recommendations) ? result.recommendations as MenuSuggestion[] : [],
      }]);
    } catch (reason) {
      setMessages((current) => current.filter((message, index) => index !== current.length - 1 || message.role !== 'assistant'));
      setError(reason instanceof Error ? reason.message : 'The assistant could not reply.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.messages} ref={scrollRef} aria-live="polite">
        {!messages.length ? (
          <div className={styles.welcome}>
            <Sparkles size={18} />
            <p>{welcomeByMode[mode]}</p>
            {customer ? <div className={styles.suggestions}>
              {['What dishes are popular?', 'Recommend vegetarian dishes', 'Which dishes are best rated?'].map((question) => (
                <button type="button" key={question} disabled={sending} onClick={() => void send(undefined, question)}>{question}</button>
              ))}
            </div> : null}
          </div>
        ) : messages.map((message, index) => (
          <article key={`${index}-${message.role}`} className={`${styles.message} ${message.role === 'user' ? styles.user : styles.assistant}`}>
            <p>{message.content}</p>
            {message.links?.length ? <div className={styles.links}>{message.links.map((link) => (
              <a key={`${link.href}-${link.label}`} href={link.href}>{link.label}<ArrowUpRight size={13} /></a>
            ))}</div> : null}
            {message.recommendations?.length ? <div className={styles.recommendations}>{message.recommendations.map((item) => (
              <div key={item.id}><strong>{item.name}</strong>{item.category ? <small>{item.category}</small> : null}{item.description ? <p>{item.description}</p> : null}{typeof item.price === 'number' ? <small>₹{item.price}</small> : null}</div>
            ))}</div> : null}
          </article>
        ))}
        {sending ? <div className={styles.typing} role="status">Thinking…</div> : null}
      </div>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <form className={styles.composer} onSubmit={(event) => void send(event)}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={customer ? 500 : 600}
          rows={2}
          placeholder={customer ? 'Ask for a menu suggestion…' : mode === 'analytics' ? 'Ask about this branch’s results…' : 'Ask about TABLELY…'}
          aria-label="Ask the AI assistant"
          required
        />
        <button type="submit" disabled={sending || !draft.trim()} aria-label="Send question"><Send size={16} /></button>
      </form>
      <p className={styles.privacy}>
        {customer
          ? 'Uses only this restaurant’s public menu and aggregate popularity. Dish ratings are not available.'
          : `Restaurant-scoped AI · ${remaining === null ? 'Daily usage limit applies' : `${remaining} requests left today`}`}
      </p>
    </div>
  );
}
