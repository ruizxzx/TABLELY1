'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, CreditCard, ShieldCheck } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type Row={organization_id:string;organization_name:string;plan_id:string;plan_name:string;status:string;billing_interval:string;selected_price:number;trial_ends_at:string|null;current_period_end:string|null;provider_subscription_id:string|null;staff_used:number;staff_limit:number|null;branches_used:number;branches_limit:number|null;tables_used:number;tables_limit:number|null;menu_items_used:number;menu_items_limit:number|null;orders_used:number;orders_limit:number|null;cancellation_requested_at:string|null};
function money(v:number|null|undefined){return v==null?'—':new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(v));}
function when(v:string|null){return v?new Date(v).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'—';}
export default function AdminSubscriptionsPage(){
 const s=getSupabaseBrowserClient(); const[rows,setRows]=useState<Row[]>([]); const[loading,setLoading]=useState(true); const[error,setError]=useState<string|null>(null);
 async function load(){if(!s){setError('Supabase is not configured.');setLoading(false);return;}setLoading(true);setError(null);try{const{data,error:e}=await s.rpc('admin_list_subscription_overview_v2');if(e)throw new Error(e.message);setRows(data??[]);}catch(e:unknown){setError(e instanceof Error?e.message:'Could not load subscription overview.');}finally{setLoading(false);}}
 useEffect(()=>{void load();},[]);
 if(loading)return <main className="admin-page"><div className="setup-loading">Loading subscription overview…</div></main>;
 return <main className="admin-page"><header className="admin-top"><div><span className="eyebrow">TABLELY ADMIN</span><h1>Subscription overview</h1><p>Plan, billing state and organization usage across the platform.</p></div><div className="button-row"><Link className="button button-light" href="/admin"><ArrowLeft size={14}/> Admin</Link><button className="button button-light" disabled={loading} onClick={()=>void load()}><RefreshCw size={15}/> Refresh</button></div></header>
 {error?<div className="notice notice-error">{error}</div>:null}
 <section className="surface-card"><div className="card-heading"><div><h2>Organizations</h2><p>Current subscription state and live usage against the authoritative plan limits.</p></div><CreditCard size={18}/></div><div className="data-table admin-subscription-table"><div className="data-row data-head"><span>Restaurant</span><span>Plan</span><span>Status</span><span>Usage</span><span>Billing</span></div>{rows.map(r=><div className="data-row" key={r.organization_id}><div><strong>{r.organization_name}</strong><span>{r.organization_id}</span></div><div><strong>{r.plan_name}</strong><span>{money(r.selected_price)} / {r.billing_interval}</span></div><span className={`payment-state ${r.status==='ACTIVE'||r.status==='TRIALING'?'paid':r.status==='PAST_DUE'?'pending':'failed'}`}>{r.status}</span><div className="admin-sub-usage"><span>Staff {r.staff_used}/{r.staff_limit??'∞'}</span><span>Branches {r.branches_used}/{r.branches_limit??'∞'}</span><span>Tables {r.tables_used}/{r.tables_limit??'∞'}</span><span>Menu {r.menu_items_used}/{r.menu_items_limit??'∞'}</span><span>Orders {r.orders_used}/{r.orders_limit??'∞'}</span></div><div><span>{r.status==='TRIALING'?`Trial ends ${when(r.trial_ends_at)}`:`Period ends ${when(r.current_period_end)}`}</span><span>{r.cancellation_requested_at?`Cancellation requested ${when(r.cancellation_requested_at)}`:'No pending cancellation'}</span><span>{r.provider_subscription_id?'Provider linked':'No provider subscription'}</span></div></div>)}{rows.length===0?<div className="empty-wide">No subscriptions found.</div>:null}</div></section>
 <div className="admin-note"><ShieldCheck size={17}/><span>Billing mutations remain Owner-only for restaurant workspaces; this page is platform-admin visibility.</span></div>
 </main>;
}
