'use client';
import { useState } from 'react';

export default function EmailCapture({ storeId }: { storeId: string }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/marketing/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId, email }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Could not subscribe.');
      setEmail(''); setMessage('You’re on the list.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not subscribe.'); }
    finally { setBusy(false); }
  }
  return <div className="card panel email-capture"><div className="eyebrow">STAY IN THE LOOP</div><h3>Get creator updates</h3><p className="muted">New products and useful drops, without an account.</p><form onSubmit={submit} className="email-capture-form"><input className="input" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"/><button className="btn btn-primary" disabled={busy}>{busy ? 'Joining…' : 'Join list'}</button></form>{message && <div className={message.includes('list') ? 'success-box' : 'error-box'}>{message}</div>}</div>;
}
