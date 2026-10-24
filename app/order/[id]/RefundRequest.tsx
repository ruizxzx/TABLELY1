'use client';
import {useState} from 'react';
export default function RefundRequest({orderId,buyerEmail,eligible}:{orderId:string;buyerEmail:string;eligible:boolean}){
 const[email,setEmail]=useState(buyerEmail);const[reason,setReason]=useState('');const[status,setStatus]=useState('');
 if(!eligible)return null;
 async function submit(e:React.FormEvent){e.preventDefault();setStatus('Submitting…');try{const r=await fetch('/api/refunds/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId,email,reason})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Request failed');setStatus('Refund request submitted. TABLELY will review it.');}catch(e){setStatus(e instanceof Error?e.message:'Request failed.');}}
 return <div className="card panel" style={{marginTop:18}}><div className="section-label">REFUND REQUEST</div><p className="muted">Request a refund for this order. Approval and provider processing are handled by TABLELY/admin.</p><form onSubmit={submit}><label className="label">Order email</label><input className="input" type="email" value={email} onChange={e=>setEmail(e.target.value)} required/><label className="label">Reason</label><textarea className="input textarea-lg" value={reason} onChange={e=>setReason(e.target.value)} minLength={5} required/><button className="btn" style={{marginTop:12}}>Request refund</button>{status&&<p className="muted" style={{fontSize:12}}>{status}</p>}</form></div>
}
