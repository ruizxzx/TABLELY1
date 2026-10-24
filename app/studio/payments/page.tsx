'use client';
import {useEffect,useMemo,useState} from 'react';
import Link from 'next/link';
import {supabase} from '../../lib/supabase';
function money(value:number,currency='INR'){return currency.toUpperCase()==='INR'?`₹${value.toLocaleString('en-IN')}`:`${currency.toUpperCase()} ${value.toLocaleString('en-IN')}`;}

export default function Payments(){
 const[orders,setOrders]=useState<any[]>([]),[account,setAccount]=useState<any>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const[keyId,setKeyId]=useState(''),[keySecret,setKeySecret]=useState(''),[webhookSecret,setWebhookSecret]=useState('');
 async function load(){
  if(!supabase){setLoading(false);return;}
  const{data:{user}}=await supabase.auth.getUser();
  if(!user){setLoading(false);return;}
  const[{data:o},{data:a}]=await Promise.all([
   supabase.from('orders').select('id,gross_amount,payment_fee,platform_fee,seller_net,currency,status,payment_status,created_at').eq('creator_id',user.id).order('created_at',{ascending:false}).limit(100),
   supabase.from('payment_accounts').select('provider,payment_model,provider_account_id,status,capabilities,country,default_currency,last_synced_at,metadata').eq('creator_id',user.id).eq('provider','razorpay').eq('is_current',true).maybeSingle()
  ]);
  setOrders(o||[]);setAccount(a||null);setLoading(false);
 }
 useEffect(()=>{void load()},[]);
 useEffect(()=>{const state=new URLSearchParams(window.location.search).get('razorpay');if(state==='connected')setMessage('Razorpay account connected successfully.');},[]);
 const metrics=useMemo(()=>{const paid=orders.filter(o=>['paid','partially_refunded'].includes(o.status));return{sales:paid.reduce((s,o)=>s+Number(o.gross_amount||0),0),orders:paid.length,currency:orders[0]?.currency||'INR'}},[orders]);
 async function connectWithCredentials(){
  if(!supabase)return;
  setBusy(true);setMessage('');
  try{
   const{data:{session}}=await supabase.auth.getSession();if(!session)throw new Error('Please sign in again.');
   if(!keyId.trim()||!keySecret.trim())throw new Error('Enter your Razorpay Key ID and Key Secret.');
   const r=await fetch('/api/payments/razorpay/connect',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({keyId,keySecret,webhookSecret})});
   const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Could not connect Razorpay.');
   setKeySecret('');setWebhookSecret('');
   await load();
   setMessage(`Razorpay connected in ${d.data?.mode||'test'} mode. Key ID ${d.data?.keyId||keyId} is now active.`);
  }catch(e){setMessage(e instanceof Error?e.message:'Could not connect Razorpay.');}finally{setBusy(false);}
 }
 async function disconnect(){
  if(!supabase)return;setBusy(true);setMessage('');
  try{
   const{data:{session}}=await supabase.auth.getSession();if(!session)throw new Error('Please sign in again.');
   const r=await fetch('/api/payments/razorpay/disconnect',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`}});const d=await r.json();
   if(!r.ok||!d.ok)throw new Error(d.error||'Could not disconnect Razorpay.');
   await load();setMessage('Razorpay account disconnected. New purchases are blocked until you reconnect.');
  }catch(e){setMessage(e instanceof Error?e.message:'Could not disconnect Razorpay.');}finally{setBusy(false);}
 }
 const mode=keyId.startsWith('rzp_live_')?'live':keyId.startsWith('rzp_test_')?'test':'';
 const connectionMethod=account?.metadata?.connection_method;
 return <div className="studio-content">
  <div className="page-title"><div><div className="eyebrow">SELL & PAYMENTS</div><h1>Payments</h1><p>Your product sales use your own Razorpay account. TABLELY charges <b>0% transaction commission</b>; your TABLELY subscription is billed separately.</p></div></div>
  {message&&<div className={message.includes('connected')||message.includes('disconnected')?'success-box':'error-box'}>{message}</div>}
  <div className="stats"><div className="card stat"><div className="label2">Product sales</div><div className="value">{loading?'—':money(metrics.sales,metrics.currency)}</div></div><div className="card stat"><div className="label2">Paid orders</div><div className="value">{loading?'—':metrics.orders}</div></div><div className="card stat"><div className="label2">TABLELY commission</div><div className="value">0%</div></div></div>
  <div className="dashboard-grid" style={{marginTop:14}}>
   <div className="card panel">
    <div className="panel-head"><div><div className="eyebrow">CREATOR PAYMENT ACCOUNT</div><h3 style={{margin:'4px 0'}}>Razorpay</h3></div><span className={`status ${account?.status==='connected'?'live':'pending'}`}>{account?.status||'setup_required'}</span></div>
    {account?.status==='connected'?<>
      <p className="muted" style={{lineHeight:1.7}}>Your Razorpay account is connected. New customer payments will be created using these server-side credentials.</p>
      <div className="info-note"><b>Key ID:</b> {account.provider_account_id||'—'}<br/><b>Mode:</b> {account?.metadata?.mode||'test'}<br/><b>Connection:</b> {connectionMethod==='api_credentials'?'API credentials':'Connected account'}<br/><b>Webhook:</b> {account?.capabilities?.webhooks?'Configured':'Not configured'}</div>
      <div style={{display:'flex',gap:10,marginTop:14}}><button className="btn" onClick={disconnect} disabled={busy}>{busy?'Working…':'Disconnect Razorpay'}</button></div>
    </>:<>
      <p className="muted" style={{lineHeight:1.7}}>Connect your own Razorpay account with API credentials. TABLELY verifies the credentials before storing them encrypted on the server. The secret is never returned to the browser after saving.</p>
      <div className="info-note"><b>Testing:</b> use your <code>rzp_test_...</code> Key ID and test secret. Live credentials are blocked until <code>PAYMENTS_LIVE_ENABLED=true</code>.</div>
      <label className="label" style={{marginTop:14}}>Razorpay Key ID</label>
      <input className="input" autoComplete="off" placeholder="rzp_test_..." value={keyId} onChange={e=>setKeyId(e.target.value)} />
      {mode&&<div className="muted" style={{fontSize:12,marginTop:6}}>Detected mode: <b>{mode}</b></div>}
      <label className="label" style={{marginTop:14}}>Razorpay Key Secret</label>
      <input className="input" type="password" autoComplete="new-password" placeholder="Your Razorpay secret" value={keySecret} onChange={e=>setKeySecret(e.target.value)} />
      <label className="label" style={{marginTop:14}}>Razorpay Webhook Secret <span className="muted">(recommended)</span></label>
      <input className="input" type="password" autoComplete="new-password" placeholder="Webhook signing secret" value={webhookSecret} onChange={e=>setWebhookSecret(e.target.value)} />
      <div className="muted" style={{fontSize:12,lineHeight:1.6,marginTop:8}}>For automatic webhook confirmation, enter the secret configured for your Razorpay webhook endpoint. For local testing, the global server webhook secret can be used instead.</div>
      <button className="btn btn-primary" style={{marginTop:14}} onClick={connectWithCredentials} disabled={busy}>{busy?'Verifying & saving…':'Connect with API credentials'}</button>
    </>}
   </div>
  <div className="card panel"><div className="eyebrow">TABLELY SUBSCRIPTIONS</div><h3 style={{margin:'4px 0'}}>Subscription plan</h3><p className="muted" style={{lineHeight:1.7}}>Your plan controls products, categories and platform features. Manage your TABLELY subscription and renewals from the subscriptions panel.</p><div className="info-note"><b>0% TABLELY transaction commission</b><br/>Creator sales are separate from your TABLELY subscription.</div><Link href="/studio/billing" className="btn btn-primary" style={{marginTop:14,display:'inline-flex'}}>Manage TABLELY subscription →</Link></div>
  </div>
  <div className="card panel" style={{marginTop:14}}><div className="panel-head"><div><h3>Recent product orders</h3><span className="muted">Verified product sales recorded by TABLELY.</span></div></div>{loading?<div className="loading-card">Loading orders…</div>:orders.slice(0,8).map(o=><div key={o.id} style={{display:'flex',justifyContent:'space-between',gap:12,padding:'14px 0',borderTop:'1px solid var(--line)'}}><div><b>{money(Number(o.gross_amount||0),o.currency)}</b><div className="muted" style={{fontSize:11}}>{o.id.slice(0,8).toUpperCase()} · {new Date(o.created_at).toLocaleString('en-IN')}</div></div><span className={`status ${o.status==='paid'?'live':o.status==='failed'?'danger':'pending'}`}>{o.status}</span></div>)}{!loading&&!orders.length&&<div className="empty-state"><b>No product orders yet</b><span>Orders will appear here after verified payments.</span></div>}</div>
 </div>
}
