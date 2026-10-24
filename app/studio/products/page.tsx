'use client';

import ButtonLink from '../../components/ButtonLink';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { publicMediaUrl } from '../../lib/storage';
import { PLAN_CONFIG, planLimitMessage, getEffectivePlan } from '../../lib/entitlements';

export default function Products() {
  const [rows, setRows] = useState<any[]>([]);
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('All');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [plan, setPlan] = useState('free');

  async function load() {
    setLoading(true);
    setMessage('');
    if (!supabase) { setMessage('Supabase is not configured.'); setLoading(false); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setMessage('Please log in again.'); setLoading(false); return; }

    const { data: store, error: storeError } = await supabase.from('stores').select('id').eq('owner_id', user.id).maybeSingle();
    if (storeError) { setMessage(storeError.message); setLoading(false); return; }
    if (!store) { setMessage('Create your store before adding products.'); setLoading(false); return; }

    const [{ data, error }, { data: cats }, { data: planRow }] = await Promise.all([
      supabase.from('products').select('id,title,slug,short_description,description,price,compare_at_price,category,category_id,status,visibility,cover_image_path,file_path,file_access_url,digital_delivery_type,preview_file_path,product_type,license,refund_policy,created_at,store_id,currency,plan_archived').eq('store_id', store.id).order('sort_order',{ascending:true}).order('created_at',{ascending:false}),
      supabase.from('store_categories').select('id,name,slug,status,is_visible').eq('store_id', store.id).order('sort_order',{ascending:true}).order('created_at',{ascending:true}),
      supabase.from('creator_plans').select('plan,access_source,access_starts_at,access_expires_at').eq('creator_id', user.id).maybeSingle()
    ]);
    if (error) setMessage(error.message);
    setRows(data || []);
    setCategories(cats || []);
    setPlan(getEffectivePlan(planRow));
    setSelected([]);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  const visible = useMemo(() => rows.filter(p =>
    (status === 'All' || p.status === status.toLowerCase()) &&
    (categoryFilter === 'all' || p.category_id === categoryFilter) &&
    `${p.title} ${p.category || ''}`.toLowerCase().includes(query.toLowerCase().trim())
  ), [rows, query, status, categoryFilter]);

  const allSelected = visible.length > 0 && visible.every(p => selected.includes(p.id));

  function toggle(id: string) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  async function bulk(action: 'archive'|'delete') {
    if (!supabase || !selected.length) return;
    const label = action === 'delete' ? 'Remove' : 'Archive';
    if (!confirm(`${label} ${selected.length} product(s)? Products with order history will be archived instead of deleted.`)) return;
    setMessage('Working…');
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setMessage('Your session has expired. Please log in again.'); return; }
    let deleted = 0, archived = 0;
    for (const id of selected) {
      if (action === 'archive') {
        const r = await supabase.from('products').update({ status:'archived', plan_archived:false, plan_archived_at:null, updated_at:new Date().toISOString() }).eq('id', id);
        if (r.error) { setMessage(r.error.message); return; }
        archived++;
        continue;
      }
      const response = await fetch(`/api/products/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { setMessage(payload.error || 'Could not remove product.'); return; }
      if (payload.archived) archived++; else deleted++;
    }
    await load();
    setMessage(action === 'delete'
      ? `${deleted} product${deleted===1?'':'s'} removed${archived ? `, ${archived} archived because of order history` : ''}.`
      : `${archived} product${archived===1?'':'s'} archived.`);
  }

  async function duplicate(p:any) {
    if (!supabase) return;
    setMessage('');
    const { data: cats } = await supabase.from('store_categories').select('id').eq('store_id', p.store_id).eq('status','live').eq('is_visible',true).order('sort_order',{ascending:true}).limit(1);
    const categoryId = p.category_id || cats?.[0]?.id;
    if (!categoryId) { setMessage('Create a category before duplicating this product.'); return; }
    let slug = `${p.slug}-copy`;
    let suffix = 2;
    while (true) {
      const { data: existing, error: slugError } = await supabase.from('products').select('id').eq('store_id', p.store_id).eq('slug', slug).maybeSingle();
      if (slugError) { setMessage(slugError.message); return; }
      if (!existing) break;
      slug = `${p.slug}-copy-${suffix++}`;
      if (suffix > 100) { setMessage('Could not generate a unique product URL.'); return; }
    }
    const { error } = await supabase.from('products').insert({
      store_id:p.store_id, title:`${p.title} Copy`, slug, short_description:p.short_description, description:p.description,
      price:p.price, compare_at_price:p.compare_at_price, currency:p.currency, category:p.category,
      category_id:categoryId, cover_image_path:null,
      file_path:null, preview_file_path:null,
      file_access_url:p.digital_delivery_type === 'link' ? p.file_access_url : null,
      digital_delivery_type:p.digital_delivery_type === 'link' ? 'link' : 'upload',
      product_type:p.product_type, license:p.license, refund_policy:p.refund_policy, status:'draft', visibility:p.visibility || 'public'
    });
    if (error) {
      const friendly = planLimitMessage(error.message, plan);
      setMessage(friendly === error.message ? error.message : friendly);
      return;
    }
    setMessage('Product duplicated as a draft. Attach delivery files before publishing.');
    await load();
  }


  const limit = PLAN_CONFIG[plan as keyof typeof PLAN_CONFIG] || PLAN_CONFIG.free;
  const liveProductCount = rows.filter((p:any)=>p.status==='live').length;
  const addBlocked = Number.isFinite(limit.maxProducts) && liveProductCount >= limit.maxProducts;

  return <div className="studio-content">
    <div className="page-title">
      <div><div className="eyebrow">PRODUCT ENGINE</div><h1>Products</h1><p>Search, organize and manage your product catalog.</p></div>
      <div className="row-actions"><Link className="btn" href="/studio/categories">Categories</Link><ButtonLink href="/studio/products/new" primary>Add product +</ButtonLink></div>
    </div>
    {message && <div className="info-note" style={{marginBottom:16}}>{message}</div>}
    <div className="card panel">
      <div className="toolbar">
        <input className="input" style={{maxWidth:360}} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search title or category…"/>
        <select className="input" style={{width:160}} value={categoryFilter} onChange={e=>setCategoryFilter(e.target.value)}><option value="all">All categories</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className="input" style={{width:140}} value={status} onChange={e=>setStatus(e.target.value)}><option>All</option><option>Live</option><option>Draft</option><option>Archived</option></select>
        <button className="btn btn-sm" onClick={()=>void load()}>Refresh</button>
        {selected.length>0&&<><button className="btn btn-sm" onClick={()=>void bulk('archive')}>Archive {selected.length}</button><button className="btn btn-sm" onClick={()=>void bulk('delete')}>Delete {selected.length}</button></>}
      </div>
      <div className="muted" style={{fontSize:12,marginBottom:14}}>
        {limit.label}: {liveProductCount}/{Number.isFinite(limit.maxProducts) ? limit.maxProducts : '∞'} live products · {categories.filter((c:any)=>c.status==='live'&&c.is_visible).length}/{Number.isFinite(limit.maxCategories) ? limit.maxCategories : '∞'} live categories · <Link href="/studio/categories">Manage limits</Link>
      </div>
      {addBlocked && <div className="info-note" style={{marginBottom:14}}>You've reached the {limit.label} plan live-product limit. You can still create drafts, but you must upgrade or move a live product to draft before publishing another.</div>}
      {loading ? <div className="skeleton-list">{[1,2,3].map(i=><div className="skeleton-row" key={i}/>)}</div> :
      visible.length===0 ? <div className="empty-state"><div className="empty-icon">✦</div><h3>{rows.length?'No products match your filters.':'Your product shelf is empty.'}</h3><p className="muted">{rows.length?'Try another search or filter.':'Create your first digital product and publish it to your storefront.'}</p>{!rows.length&&<ButtonLink href="/studio/products/new" primary>Add your first product</ButtonLink>}</div> :
      <div className="product-list">
        <div style={{display:'flex',gap:10,alignItems:'center',paddingBottom:8}}><input type="checkbox" checked={allSelected} onChange={()=>setSelected(allSelected?[]:visible.map(p=>p.id))}/><span className="muted" style={{fontSize:12}}>{selected.length} selected</span></div>
        {visible.map(p=>{const cover=publicMediaUrl(p.cover_image_path);return <div className="product-row" key={p.id}>
          <input type="checkbox" checked={selected.includes(p.id)} onChange={()=>toggle(p.id)}/>
          <div className="row-cover">{cover?<img src={cover} alt=""/>:<div/>}</div>
          <div className="product-row-main"><div className="muted" style={{fontSize:10,textTransform:'uppercase',letterSpacing:'.09em'}}>{p.category||'Digital product'} · {p.digital_delivery_type==='link'?'Link delivery':'File delivery'}</div><b>{p.title}</b><p className="muted">{p.short_description||'No short description yet.'}</p></div>
          <div className="row-price"><b>₹{Number(p.price).toLocaleString('en-IN')}</b>{p.compare_at_price&&p.compare_at_price>p.price?<span className="compare-price">₹{Number(p.compare_at_price).toLocaleString('en-IN')}</span>:null}</div>
          <span className={`status ${p.status==='live'?'live':p.status==='draft'?'draft':'pending'}`}>{p.plan_archived?'Archived by plan':p.status}</span>
          <div style={{display:'flex',gap:7}}><Link className="btn btn-sm" href={`/studio/products/${p.id}`}>Edit</Link><button className="btn btn-sm" onClick={()=>void duplicate(p)}>Duplicate</button></div>
        </div>})}
      </div>}
    </div>
  </div>;
}
