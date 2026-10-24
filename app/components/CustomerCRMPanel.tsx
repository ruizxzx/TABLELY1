'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Metadata = { tags: { id: string; tag: string }[]; notes: { id: string; note: string; created_at: string }[] };

export default function CustomerCRMPanel({ email }: { email: string }) {
  const [data, setData] = useState<Metadata>({ tags: [], notes: [] });
  const [tag, setTag] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);

  async function request(method: 'GET' | 'POST', body?: Record<string, unknown>) {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('Please sign in again.');
    const response = await fetch(`/api/studio/customers/manage?email=${encodeURIComponent(email)}`, { method, headers: { Authorization: `Bearer ${session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify({ ...body, email }) } : {}) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'Customer update failed.');
    return payload.data;
  }

  async function load() { try { const next = await request('GET'); setData(next || { tags: [], notes: [] }); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load customer metadata.'); } }
  useEffect(() => { if (open) void load(); }, [open]);
  async function mutate(body: Record<string, unknown>) { try { await request('POST', body); setMessage('Saved.'); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save.'); } }

  return <div style={{ marginTop: 8 }}><button className="btn btn-sm" onClick={() => setOpen(value => !value)}>{open ? 'Hide CRM' : 'Tags & notes'}</button>{open && <div className="card panel" style={{ marginTop: 10, minWidth: 280 }}><div className="section-label">PRIVATE CRM</div><div className="row-actions"><input className="input" value={tag} onChange={event => setTag(event.target.value)} placeholder="Add tag"/><button className="btn btn-sm" onClick={() => { if (tag.trim()) { void mutate({ action: 'add_tag', tag: tag.trim() }); setTag(''); } }}>Add</button></div><div className="row-actions" style={{ flexWrap: 'wrap', marginTop: 8 }}>{data.tags.map(item => <button key={item.id} className="pill" onClick={() => void mutate({ action: 'remove_tag', tag: item.tag })}>{item.tag} ×</button>)}</div><textarea className="input" value={note} onChange={event => setNote(event.target.value)} placeholder="Private note" style={{ marginTop: 10, minHeight: 70 }} /><button className="btn btn-primary btn-sm" style={{ marginTop: 8 }} onClick={() => { if (note.trim()) { void mutate({ action: 'add_note', note: note.trim() }); setNote(''); } }}>Save note</button><div className="mini-list" style={{ marginTop: 10 }}>{data.notes.map(item => <div className="mini-list-row" key={item.id}><span>{item.note}</span><button className="btn btn-sm" onClick={() => void mutate({ action: 'delete_note', noteId: item.id })}>Delete</button></div>)}</div>{message && <div className="muted" style={{ marginTop: 8 }}>{message}</div>}</div>}</div>;
}
