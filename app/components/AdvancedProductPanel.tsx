'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { uploadProductFile, removeStorageFiles } from '../lib/storage';

type Extension = { id:string; name?:string; sku?:string|null; price?:number; currency?:string; status?:string; version_label?:string; changelog?:string|null; created_at:string; };
type Props = { productId:string };

export default function AdvancedProductPanel({productId}:Props){
  const [variants,setVariants]=useState<Extension[]>([]);
  const [versions,setVersions]=useState<Extension[]>([]); const [files,setFiles]=useState<any[]>([]);
  const [name,setName]=useState('');
  const [sku,setSku]=useState('');
  const [price,setPrice]=useState('');
  const [version,setVersion]=useState('');
  const [changelog,setChangelog]=useState('');
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState(''); const [extraFile,setExtraFile]=useState<File|null>(null);

  const load=useCallback(async()=>{
    if(!supabase)return;
    const {data:{session}}=await supabase.auth.getSession();
    if(!session){setLoading(false);return;}
    const res=await fetch(`/api/products/advanced?productId=${encodeURIComponent(productId)}`,{headers:{Authorization:`Bearer ${session.access_token}`}});
    const json=await res.json();
    if(!res.ok){setMessage(json.error||'Could not load advanced product settings.');setLoading(false);return;}
    setVariants(json.data?.variants||[]);
    setVersions(json.data?.versions||[]); setFiles(json.data?.files||[]);
    setLoading(false);
  },[productId]);

  useEffect(()=>{void load();},[load]);

  async function post(body:any){
    if(!supabase)return;
    setSaving(true);setMessage('');
    try{
      const {data:{session}}=await supabase.auth.getSession();
      if(!session)throw new Error('Please sign in again.');
      const res=await fetch('/api/products/advanced',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({...body,productId})});
      const json=await res.json();
      if(!res.ok)throw new Error(json.error||'Could not save.');
      await load();
      return true;
    }catch(e){setMessage(e instanceof Error?e.message:'Could not save.');return false;}
    finally{setSaving(false);}
  }


  async function addFile(){
    if(!extraFile||!supabase)return;
    setSaving(true);setMessage('');
    let uploaded:string|null=null;
    try{
      const {data:{user}}=await supabase.auth.getUser(); if(!user)throw new Error('Please sign in again.');
      uploaded=await uploadProductFile(user.id,productId,extraFile);
      const {error}=await supabase.from('product_files').insert({product_id:productId,file_path:uploaded,filename:extraFile.name,mime_type:extraFile.type||'application/octet-stream',size_bytes:extraFile.size,sort_order:999,is_primary:false});
      if(error)throw error;
      setExtraFile(null);const input=document.getElementById('advanced-product-file') as HTMLInputElement|null;if(input)input.value='';
      await load();
    }catch(e){if(uploaded){try{await removeStorageFiles('product-files',[uploaded]);}catch{}}setMessage(e instanceof Error?e.message:'Could not add file.');}
    finally{setSaving(false);}
  }

  async function remove(type:string,id:string){
    if(!supabase)return;
    setSaving(true);setMessage('');
    try{
      const {data:{session}}=await supabase.auth.getSession(); if(!session)throw new Error('Please sign in again.');
      const res=await fetch('/api/products/advanced',{method:'DELETE',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({productId,type,id})});
      const json=await res.json(); if(!res.ok)throw new Error(json.error||'Could not delete.');
      await load();
    }catch(e){setMessage(e instanceof Error?e.message:'Could not delete.');}
    finally{setSaving(false);}
  }

  return <div>
    {loading?<div className="muted">Loading variants and versions…</div>:<>
      {message&&<div className="error-box" style={{marginBottom:10}}>{message}</div>}
      <div className="form-grid-2">
        <div><label className="label">Variant name</label><input className="input" value={name} onChange={e=>setName(e.target.value)} placeholder="Standard / Pro"/></div>
        <div><label className="label">SKU</label><input className="input" value={sku} onChange={e=>setSku(e.target.value)} placeholder="Optional SKU"/></div>
      </div>
      <div style={{display:'flex',gap:10,marginTop:10}}>
        <input className="input" style={{maxWidth:180}} type="number" min="0" value={price} onChange={e=>setPrice(e.target.value)} placeholder="Price"/>
        <button className="btn btn-sm" disabled={saving} onClick={async()=>{if(await post({type:'variant',name,sku,price})){setName('');setSku('');setPrice('');}}}>Add variant</button>
      </div>
      <div className="mini-list" style={{marginTop:12}}>
        {variants.map(v=><div className="mini-list-row" key={v.id}><span><b>{v.name}</b>{v.sku?` · ${v.sku}`:''} · ₹{Number(v.price||0).toLocaleString('en-IN')}</span><button className="btn btn-sm" disabled={saving} onClick={()=>void remove('variant',v.id)}>Remove</button></div>)}
        {!variants.length&&<div className="muted">No variants configured.</div>}
      </div>
      <div className="section-label" style={{marginTop:20}}>ADDITIONAL FILES</div>
      <div style={{display:'flex',gap:10,alignItems:'end',flexWrap:'wrap'}}><div style={{minWidth:260,flex:1}}><label className="label">Add downloadable file</label><input id="advanced-product-file" className="input" type="file" onChange={e=>setExtraFile(e.target.files?.[0]||null)}/></div><button className="btn btn-sm" disabled={saving||!extraFile} onClick={()=>void addFile()}>Upload file</button></div>
      <div className="mini-list" style={{marginTop:10}}>{files.map(f=><div className="mini-list-row" key={f.id}><span><b>{f.filename}</b> · {Math.round(Number(f.size_bytes||0)/1024)} KB</span><span className="muted">{f.is_primary?"Primary":"Additional"}</span></div>)}{!files.length&&<div className="muted">No additional files recorded yet.</div>}</div>
      <div className="section-label" style={{marginTop:20}}>PRODUCT VERSIONS</div>
      <div className="form-grid-2">
        <div><label className="label">Version label</label><input className="input" value={version} onChange={e=>setVersion(e.target.value)} placeholder="v2.0"/></div>
        <div><label className="label">Changelog</label><input className="input" value={changelog} onChange={e=>setChangelog(e.target.value)} placeholder="What changed?"/></div>
      </div>
      <button className="btn btn-sm" style={{marginTop:10}} disabled={saving} onClick={async()=>{if(await post({type:'version',versionLabel:version,changelog})){setVersion('');setChangelog('');}}}>Add version</button>
      <div className="mini-list" style={{marginTop:12}}>
        {versions.map(v=><div className="mini-list-row" key={v.id}><span><b>{v.version_label}</b> · {v.changelog||'No changelog'}</span><button className="btn btn-sm" disabled={saving} onClick={()=>void remove('version',v.id)}>Remove</button></div>)}
        {!versions.length&&<div className="muted">No versions recorded.</div>}
      </div>
    </>}
  </div>;
}
