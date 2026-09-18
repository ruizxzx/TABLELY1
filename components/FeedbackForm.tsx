'use client';

import { useState } from 'react';
import { Send, X } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

export function FeedbackForm({ source, tableCode, onClose }: { source: 'CUSTOMER' | 'RESTAURANT'; tableCode?: string; onClose: () => void }) {
  const [category, setCategory] = useState('BUG');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase || subject.trim().length < 3 || description.trim().length < 5) { setMessage('Add a subject and a description before sending.'); return; }
    setBusy(true); setMessage(null);
    const result = source === 'CUSTOMER'
      ? await supabase.rpc('submit_customer_feedback', { p_table_code: tableCode, p_category: category, p_subject: subject, p_description: description, p_reporter_name: name || null, p_reporter_email: email || null })
      : await supabase.rpc('submit_restaurant_feedback', { p_category: category, p_subject: subject, p_description: description });
    if (result.error) setMessage(result.error.message);
    else { setMessage('Thanks — your feedback was sent to the Tablely admin team.'); setSubject(''); setDescription(''); }
    setBusy(false);
  }
  return <div className="feedback-modal-backdrop" role="dialog" aria-modal="true"><section className="feedback-modal"><div className="feedback-modal-head"><div><span className="eyebrow">TABLELY FEEDBACK</span><h2>{source === 'CUSTOMER' ? 'Report a problem or suggest an idea' : 'Report a problem or suggest an idea'}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={17}/></button></div><label>Type<select value={category} onChange={event => setCategory(event.target.value)}><option value="BUG">Report a problem</option><option value="IDEA">Suggest an idea</option><option value="SUPPORT">Request support</option><option value="OTHER">Other</option></select></label><label>Subject<input value={subject} onChange={event => setSubject(event.target.value)} maxLength={160} placeholder="What should the admin team know?" /></label><label>Description<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={4000} rows={6} placeholder="Tell us what happened or what you would like to improve." /></label>{source === 'CUSTOMER' ? <div className="feedback-contact-grid"><label>Name (optional)<input value={name} onChange={event => setName(event.target.value)} maxLength={120} /></label><label>Email (optional)<input type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={200} /></label></div> : null}{message ? <div className={message.startsWith('Thanks') ? 'notice notice-success' : 'notice notice-error'}>{message}</div> : null}<button className="button button-primary button-full" disabled={busy} onClick={() => void submit()}><Send size={15}/>{busy ? 'Sending…' : 'Send feedback'}</button></section></div>;
}
