'use client';

import { useState, type FormEvent } from 'react';
import { CheckCircle2, Loader2, Send } from 'lucide-react';
import type { ContactContent } from '@/lib/public-content';

export function ContactForm({ content }: { content: ContactContent }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', company_name: '', restaurant_count: '', subject: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(key: keyof typeof form, value: string) { setForm(current => ({ ...current, [key]: value })); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(null); setSent(false);
    try {
      const count = form.restaurant_count.trim() ? Number(form.restaurant_count) : null;
      if (count !== null && (!Number.isInteger(count) || count < 1)) throw new Error('Enter a valid restaurant count.');
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone || undefined,
          company_name: form.company_name || undefined,
          restaurant_count: count,
          subject: form.subject || 'TABLELY enquiry',
          message: form.message,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Could not send your message.');
      setSent(true);
      setForm({ name: '', email: '', phone: '', company_name: '', restaurant_count: '', subject: '', message: '' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send your message.');
    } finally { setBusy(false); }
  }

  if (sent) {
    return (
      <section className="public-form-card">
        <div className="public-success-icon"><CheckCircle2 size={28} /></div>
        <span className="eyebrow">MESSAGE RECEIVED</span>
        <h2>Thank you.</h2>
        <p>{content.success_message}</p>
        <a className="button button-primary" href={`mailto:${content.email}`}>Email us directly</a>
      </section>
    );
  }

  return (
    <form className="public-form-card public-contact-form" onSubmit={submit} noValidate>
      <div><span className="eyebrow">CONTACT TABLELY</span><h2>{content.form_title}</h2><p>{content.form_description}</p></div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      <div className="public-form-grid two">
        <label>Name<input value={form.name} onChange={e => update('name', e.target.value)} maxLength={120} required placeholder="Your name" /></label>
        <label>Email<input type="email" value={form.email} onChange={e => update('email', e.target.value)} maxLength={240} required placeholder="you@company.com" /></label>
      </div>
      <div className="public-form-grid two">
        <label>Phone <span className="field-optional">Optional</span><input value={form.phone} onChange={e => update('phone', e.target.value)} maxLength={40} placeholder="+91 …" /></label>
        <label>Restaurant / company<input value={form.company_name} onChange={e => update('company_name', e.target.value)} maxLength={180} placeholder="Restaurant name" /></label>
      </div>
      <div className="public-form-grid two">
        <label>Restaurants / branches <span className="field-optional">Optional</span><input type="number" min="1" max="100000" value={form.restaurant_count} onChange={e => update('restaurant_count', e.target.value)} placeholder="e.g. 3" /></label>
        <label>Subject<input value={form.subject} onChange={e => update('subject', e.target.value)} maxLength={160} required placeholder="What can we help with?" /></label>
      </div>
      <label>Message<textarea value={form.message} onChange={e => update('message', e.target.value)} maxLength={6000} required rows={7} placeholder="Tell us about your restaurants and what you need from TABLELY." /></label>
      <button className="button button-primary" type="submit" disabled={busy}>{busy ? <><Loader2 size={16} className="spin" /> Sending…</> : <><Send size={16} /> {content.form_cta}</>}</button>
      <p className="public-form-note">Prefer email? <a href={`mailto:${content.email}`}>{content.email}</a></p>
    </form>
  );
}
