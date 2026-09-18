'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, FileText, Mail, RefreshCw, UserRound } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type Row = { slug: string; title: string; is_published: boolean; version: number; updated_at: string; published_at: string };
const labels: Record<string,string> = { contact: 'Contact', vision: 'My Vision', privacy: 'Privacy Policy', terms: 'Terms & Conditions' };
const icons: Record<string, typeof Mail> = { contact: Mail, vision: UserRound, privacy: FileText, terms: FileText };
const paths: Record<string,string> = { contact: '/contact', vision: '/vision', privacy: '/privacy', terms: '/terms' };

export default function AdminContentPage() {
  const supabase = getSupabaseBrowserClient();
  const [rows,setRows]=useState<Row[]>([]); const [loading,setLoading]=useState(true); const [error,setError]=useState<string|null>(null);
  async function load(){ if(!supabase){setError('Supabase is not configured.');setLoading(false);return;} setLoading(true); const {data,error:e}=await supabase.rpc('admin_list_public_content_pages'); if(e)setError(e.message); else setRows((data??[]) as Row[]); setLoading(false); }
  useEffect(()=>{void load()},[]);
  return <main className="admin-page"><header className="admin-top"><div><Link href="/admin" className="back-link"><ArrowLeft size={15}/> Admin dashboard</Link><span className="eyebrow">PUBLIC CONTENT</span><h1>Content control</h1><p>Edit the public TABLELY website without opening the codebase.</p></div><div className="button-row"><Link className="button button-light" href="/admin/contacts"><Mail size={14}/> Contacts / Leads</Link><button className="button button-light" onClick={()=>void load()}><RefreshCw size={15}/> Refresh</button></div></header>{error?<div className="notice notice-error">{error}</div>:null}{loading?<div className="setup-loading">Loading content controls…</div>:<section className="content-control-grid">{rows.map(row=>{const Icon=icons[row.slug]??FileText;return <article className="surface-card content-control-card" key={row.slug}><div className="content-card-icon"><Icon size={20}/></div><div className="content-card-copy"><span className="eyebrow">{labels[row.slug]??row.slug}</span><h2>{row.title}</h2><p>Version {row.version} · Updated {new Date(row.updated_at).toLocaleString('en-IN')}</p><span className={`content-status ${row.is_published?'published':'draft'}`}>{row.is_published?'Published':'Unpublished'}</span></div><div className="button-row"><Link className="button button-light compact" href={`/admin/content/${row.slug}`}>Edit</Link><Link className="button button-light compact" href={paths[row.slug]} target="_blank">View</Link></div></article>})}</section>}</main>;
}
