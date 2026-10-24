'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { PLAN_CONFIG, planLimitMessage, getEffectivePlan } from '../../lib/entitlements';
import { getPrimaryPublicPage, getStorePath } from '../../lib/public-paths';

function slugify(value:string){return value.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60) || 'category';}

export default function CategoriesPage(){
  const [store,setStore]=useState<any>(null);
  const [categories,setCategories]=useState<any[]>([]);
  const [productCounts,setProductCounts]=useState<Record<string,number>>({});
  const [plan,setPlan]=useState('free');
  const [name,setName]=useState('');
  const [description,setDescription]=useState('');
  const [editing,setEditing]=useState<string|null>(null);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState('');
  const [loading,setLoading]=useState(true);

  async function load(){
    if(!supabase){setMessage('Supabase is not configured.');setLoading(false);return;}
    setLoading(true);setMessage('');
    const {data:{user}}=await supabase.auth.getUser();
    if(!user){setMessage('Please log in again.');setLoading(false);return;}
    const {data:s,error:se}=await supabase.from('stores').select('id,username,link_hub_config').eq('owner_id',user.id).maybeSingle();
    if(se) setMessage(se.message);
    if(!s){setMessage('Create your store before managing categories.');setLoading(false);return;}
    const [{data:c,error:ce},{data:p},{data:pr}] = await Promise.all([
      supabase.from('store_categories').select('id,name,slug,description,status,is_visible,plan_archived,sort_order,created_at,updated_at').eq('store_id',s.id).order('sort_order',{ascending:true}).order('created_at',{ascending:true}),
      supabase.from('products').select('id,category_id').eq('store_id',s.id),
      supabase.from('creator_plans').select('plan,access_source,access_starts_at,access_expires_at').eq('creator_id',user.id).maybeSingle()
    ]);
    if(ce) setMessage(ce.message);
    const counts:Record<string,number>={};
    (p||[]).forEach((x:any)=>{counts[x.category_id]=(counts[x.category_id]||0)+1;});
    setStore(s);setCategories(c||[]);setProductCounts(counts);setPlan(getEffectivePlan(pr));setLoading(false);
  }
  useEffect(()=>{void load();},[]);

  const limits=PLAN_CONFIG[plan as keyof typeof PLAN_CONFIG]||PLAN_CONFIG.free;
  const liveCategories=categories.filter((c:any)=>c.status==='live'&&c.is_visible);
  const canCreate=Number.isFinite(limits.maxCategories) ? liveCategories.length < limits.maxCategories : true;

  function reset(){setEditing(null);setName('');setDescription('');}

  async function save(){
    if(!supabase||!store)return;
    const clean=name.trim();
    if(!clean)return setMessage('Category name is required.');
    if(clean.length>60)return setMessage('Category name must be 60 characters or fewer.');
    setSaving(true);setMessage('');
    try{
      if(editing){
        const {error}=await supabase.from('store_categories').update({name:clean,slug:slugify(clean),description:description.trim()||null,updated_at:new Date().toISOString()}).eq('id',editing).eq('store_id',store.id);
        if(error)throw error;
      }else{
        if(!canCreate)return setMessage(`You've reached the ${limits.label} plan category limit.`);
        const base=slugify(clean);
        let slug=base, suffix=2;
        while(categories.some(c=>c.slug===slug)){slug=`${base}-${suffix++}`;}
        const {error}=await supabase.from('store_categories').insert({store_id:store.id,name:clean,slug,description:description.trim()||null,sort_order:categories.length});
        if(error)throw error;
      }
      reset();await load();setMessage(editing?'Category updated.':'Category created.');
    }catch(error){
      const text=error instanceof Error?error.message:'Could not save category.';
      setMessage(planLimitMessage(text,plan));
    }finally{setSaving(false);}
  }

  async function toggle(c:any){
    if(!supabase)return;
    const targetLive = c.status !== 'live' || !c.is_visible;
    if(targetLive && !canCreate && c.status !== 'live') return setMessage(`You've reached the ${limits.label} plan category limit.`);
    const {error}=await supabase.from('store_categories').update({status:targetLive?'live':'archived',is_visible:targetLive,plan_archived:false,plan_archived_at:null,updated_at:new Date().toISOString()}).eq('id',c.id).eq('store_id',store.id);
    if(error)setMessage(error.message);else await load();
  }

  async function remove(c:any){
    if(!supabase)return;
    const count=productCounts[c.id]||0;
    if(count>0){setMessage(`Move ${count} product${count===1?'':'s'} to another category before deleting "${c.name}".`);return;}
    if(!confirm(`Delete "${c.name}"?`))return;
    const {error}=await supabase.from('store_categories').delete().eq('id',c.id).eq('store_id',store.id);
    if(error)setMessage(error.message);else{await load();setMessage('Category deleted.');}
  }

  async function move(index:number,direction:-1|1){
    if(!supabase)return;
    const next=index+direction;if(next<0||next>=categories.length)return;
    const a=categories[index],b=categories[next];
    const [{error:e1},{error:e2}]=await Promise.all([
      supabase.from('store_categories').update({sort_order:b.sort_order,updated_at:new Date().toISOString()}).eq('id',a.id),
      supabase.from('store_categories').update({sort_order:a.sort_order,updated_at:new Date().toISOString()}).eq('id',b.id),
    ]);
    if(e1||e2)setMessage((e1||e2)?.message||'Could not reorder categories.');else await load();
  }

  const usage=`${liveCategories.length}/${Number.isFinite(limits.maxCategories)?limits.maxCategories:'∞'}`;

  if(loading)return <div className="studio-content"><div className="loading-card card">Loading categories…</div></div>;

  return <div className="studio-content">
    <div className="page-title"><div><div className="eyebrow">STOREFRONT ORGANIZATION</div><h1>Categories</h1><p>Organize your public storefront into clear sections like Courses, Books or Templates.</p></div><Link className="btn" href="/studio/products">Products</Link></div>
    {message&&<div className={message.includes('created')||message.includes('updated')||message.includes('deleted')?'success-box':'info-note'} style={{marginBottom:16}}>{message}</div>}
    <div className="card panel" style={{marginBottom:18}}>
      <div className="section-label">{editing?'EDIT CATEGORY':'NEW CATEGORY'}</div>
      <div className="form-grid-2">
        <div><label className="label">Name *</label><input className="input" value={name} onChange={e=>setName(e.target.value)} maxLength={60} placeholder="Courses"/></div>
        <div><label className="label">Description</label><input className="input" value={description} onChange={e=>setDescription(e.target.value)} maxLength={180} placeholder="What visitors will find here"/></div>
      </div>
      <div className="row-actions" style={{marginTop:12}}>
        <button className="btn btn-primary" disabled={saving||(!editing&&!canCreate)} onClick={()=>void save()}>{saving?'Saving…':editing?'Save category':'Create category'}</button>
        {editing&&<button className="btn" onClick={reset}>Cancel</button>}
        <span className="muted" style={{fontSize:12}}>Plan: {limits.label} · {usage} categories · {Number.isFinite(limits.maxProducts)?`${limits.maxProducts} max products`:'unlimited products'}</span>
      </div>
      {!canCreate&&!editing&&<div className="info-note" style={{marginTop:12}}>Category limit reached. Upgrade your plan to add another storefront section.</div>}
    </div>
    <div className="card panel">
      {categories.length===0?<div className="empty-state"><h3>No categories yet.</h3><p className="muted">Create your first storefront section.</p></div>:
      <div className="product-list">{categories.map((c:any,i:number)=><div className="product-row" key={c.id}>
        <div className="product-row-main"><div className="muted" style={{fontSize:10,textTransform:'uppercase',letterSpacing:'.09em'}}>{c.status==='archived'?(c.plan_archived?'Archived by plan':'Archived'):c.is_visible?'Visible':'Hidden'}</div><b>{c.name}</b><p className="muted">{c.description||'No description'} · {productCounts[c.id]||0} live product{(productCounts[c.id]||0)===1?'':'s'}</p></div>
        <div className="row-actions"><button className="btn btn-sm" disabled={i===0} onClick={()=>void move(i,-1)}>↑</button><button className="btn btn-sm" disabled={i===categories.length-1} onClick={()=>void move(i,1)}>↓</button><button className="btn btn-sm" onClick={()=>{setEditing(c.id);setName(c.name);setDescription(c.description||'');}}>Edit</button><button className="btn btn-sm" onClick={()=>void toggle(c)}>{c.status==='live'&&c.is_visible?'Archive':'Restore live'}</button><button className="btn btn-sm" onClick={()=>void remove(c)}>Delete</button></div>
      </div>)}</div>}
    </div>
    {store&&<div className="muted" style={{marginTop:14,fontSize:12}}>Public storefront: <Link href={getStorePath(store.username, getPrimaryPublicPage(store.link_hub_config?.primaryPage))} target="_blank">{getStorePath(store.username, getPrimaryPublicPage(store.link_hub_config?.primaryPage))}</Link></div>}
  </div>;
}
