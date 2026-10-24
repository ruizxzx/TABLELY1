'use client';
import {useState} from 'react';
export default function DisputeRequest({orderId,buyerEmail,eligible}:{orderId:string;buyerEmail:string;eligible:boolean}){
 const[email,setEmail]=useState(buyerEmail),[reason,setReason]=useState(''),[status,setStatus]=useState('');
 if(!eligible)return null;
 async function submit(e:React.FormEvent){e.preventDefault();setStatus('Submitting…');try{const r=await fetch('/api/disputes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId,email,reason})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Request failed');setStatus('Dispute submitted for review.');}catch(e){setStatus(e instanceof Error?e.message:'Request failed.');}}
 return <div className="card panel" style={{marginTop:18}}><div className="section-label">DISPUTE</div><p className="muted">Open a dispute when there is a payment or delivery issue that needs platform review.</p><form onSubmit={submit}><label className="label">Order email</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} required/><label className="label">Reason</label><textarea className="input textarea-lg" value={reason} onChange={e=>setReason(e.target.value)} minLength={5} required/><button className="btn" style={{marginTop:12}}>Open dispute</button>{status&&<p className="muted" style={{fontSize:12}}>{status}</p>}</form></div>
}
