'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, ShieldCheck } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

const FEATURES = ['ONLINE_PAYMENTS','UNLIMITED_STAFF','SERVICE_REQUESTS','ANALYTICS','PAYMENT_TRACKING','CUSTOM_BRANDING','MULTI_BRANCH','ADVANCED_ANALYTICS','CROSS_BRANCH_REPORTING','ADVANCED_PERMISSIONS','CUSTOM_DOMAIN'] as const;
type Feature = typeof FEATURES[number];
type Plan = {
  id:string; name:string; price_monthly:number; price_annual:number; trial_days:number; active:boolean;
  features:Record<string,unknown>; max_staff:number|null; max_branches:number|null; max_tables:number|null;
  max_menu_items:number|null; max_monthly_orders:number|null; provider_plan_id:string|null;
  provider_plan_id_annual:string|null; description:string|null; currency:string; billing_interval:string;
};
type OriginalPrice = { monthly:number; annual:number };
type BillingStatus = { configured:boolean; environment:string; webhookConfigured:boolean; publicKey:string|null };

export default function AdminPlansPage(){
  const s=getSupabaseBrowserClient();
  const [plans,setPlans]=useState<Plan[]>([]);
  const [originalPrices,setOriginalPrices]=useState<Record<string,OriginalPrice>>({});
  const [billing,setBilling]=useState<BillingStatus|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState<string|null>(null);

  async function load(){
    setLoading(true);setError(null);
    try{
      const r=await fetch('/api/admin/billing-plans',{cache:'no-store'});
      const b=await r.json();
      if(!r.ok)throw new Error(b.error||'Could not load plan catalog.');
      const next=(b.plans??[]) as Plan[];
      setPlans(next);
      setBilling((b.billing??null) as BillingStatus|null);
      setOriginalPrices(Object.fromEntries(next.map(plan=>[plan.id,{monthly:Number(plan.price_monthly),annual:Number(plan.price_annual)}])));
    }catch(e:unknown){setError(e instanceof Error?e.message:'Could not load plan catalog.')}finally{setLoading(false)}
  }
  useEffect(()=>{void load()},[]);

  async function save(plan:Plan){
    if(!s)return;
    const original=originalPrices[plan.id];
    const monthlyChanged=Boolean(original)&&Number(plan.price_monthly)!==Number(original.monthly);
    const annualChanged=Boolean(original)&&Number(plan.price_annual)!==Number(original.annual);
    if((monthlyChanged&&Boolean(plan.provider_plan_id))||(annualChanged&&Boolean(plan.provider_plan_id_annual))){
      setError('Pricing changes for an already-provisioned interval require that interval’s Re-provision action. No price was saved.');
      return;
    }
    setBusy(`save:${plan.id}`);setError(null);
    try{
      const r=await s.rpc('admin_update_plan_v2',{
        p_plan_id:plan.id,p_price_monthly:plan.price_monthly,p_price_annual:plan.price_annual,p_trial_days:plan.trial_days,
        p_active:plan.active,p_features:plan.features,p_max_staff:plan.max_staff,p_max_branches:plan.max_branches,
        p_max_tables:plan.max_tables,p_max_menu_items:plan.max_menu_items,p_max_monthly_orders:plan.max_monthly_orders,
        p_description:plan.description
      });
      if(!r?.data||r.error)throw new Error(r?.error?.message||'Could not save plan.');
      setPlans(v=>v.map(p=>p.id===plan.id?({...p,...r.data} as Plan):p));
      setOriginalPrices(v=>({...v,[plan.id]:{monthly:Number(plan.price_monthly),annual:Number(plan.price_annual)}}));
    }catch(e:unknown){setError(e instanceof Error?e.message:'Could not save plan.')}finally{setBusy(null)}
  }

  async function provision(plan:Plan,interval:'month'|'year'){
    const amount=interval==='year'?Number(plan.price_annual):Number(plan.price_monthly);
    if(!Number.isFinite(amount)||amount<1){setError(`The ${interval==='year'?'annual':'monthly'} price must be at least ₹1.`);return;}
    setBusy(`provider:${plan.id}:${interval}`);setError(null);
    try{
      const r=await fetch('/api/admin/billing-plans',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({planId:plan.id,interval,amountRupees:amount})
      });
      const b=await r.json();
      if(!r.ok)throw new Error(b.error||'Could not provision provider plan.');
      const providerId=String(b.providerPlanId||'');
      if(!providerId)throw new Error('Provider plan was created without a usable provider ID.');
      setPlans(v=>v.map(p=>p.id===plan.id?({...p,...(interval==='year'?{provider_plan_id_annual:providerId,price_annual:amount}:{provider_plan_id:providerId,price_monthly:amount})}):p));
      setOriginalPrices(v=>({...v,[plan.id]:{monthly:interval==='year'?Number(v[plan.id]?.monthly??plan.price_monthly):amount,annual:interval==='year'?amount:Number(v[plan.id]?.annual??plan.price_annual)}}));
    }catch(e:unknown){setError(e instanceof Error?e.message:'Could not provision provider plan.')}finally{setBusy(null)}
  }

  function patch(id:string,changes:Partial<Plan>){setPlans(v=>v.map(p=>p.id===id?{...p,...changes}:p))}
  function intervalChanged(plan:Plan,interval:'month'|'year'){
    const original=originalPrices[plan.id];
    if(!original)return false;
    return interval==='year'?Number(plan.price_annual)!==Number(original.annual):Number(plan.price_monthly)!==Number(original.monthly);
  }

  if(loading)return <main className="admin-page"><div className="setup-loading">Loading plan catalog…</div></main>;
  return <main className="admin-page"><header className="admin-top"><div><span className="eyebrow">TABLELY ADMIN</span><h1>Plan catalog</h1><p>Authoritative SaaS pricing, feature entitlements and billing-plan links.</p></div><div className="button-row"><Link className="button button-light" href="/admin"><ArrowLeft size={14}/> Admin</Link><button className="button button-light" onClick={()=>void load()} disabled={busy!==null}><RefreshCw size={15}/> Refresh</button></div></header>
    {error?<div className="notice notice-error">{error}</div>:null}
    {billing?<div className="notice"><strong>TABLELY Razorpay:</strong> {billing.configured?`${billing.environment.toUpperCase()} configured`:'not configured'} · Webhook {billing.webhookConfigured?'configured':'not configured'}. Current environment is used for every new provider plan.</div>:null}
    <div className="admin-plan-grid">{plans.map(plan=><section className="surface-card admin-plan-card" key={plan.id}><div className="admin-plan-head"><div><span className="eyebrow">{plan.id}</span><h2>{plan.name}</h2><p>{plan.description??''}</p></div><span className={`payment-state ${plan.active?'paid':'failed'}`}>{plan.active?'ACTIVE':'INACTIVE'}</span></div>
      <div className="admin-plan-fields"><label>Monthly price (₹)<input type="number" min="1" step="1" value={plan.price_monthly} onChange={e=>patch(plan.id,{price_monthly:Number(e.target.value)})}/></label><label>Annual price (₹)<input type="number" min="1" step="1" value={plan.price_annual} onChange={e=>patch(plan.id,{price_annual:Number(e.target.value)})}/></label><label>Trial days<input type="number" min="0" max="90" value={plan.trial_days} onChange={e=>patch(plan.id,{trial_days:Number(e.target.value)})}/></label><label>Max staff<input type="number" min="0" value={plan.max_staff??''} placeholder="Unlimited" onChange={e=>patch(plan.id,{max_staff:e.target.value===''?null:Number(e.target.value)})}/></label><label>Max branches<input type="number" min="0" value={plan.max_branches??''} placeholder="Policy" onChange={e=>patch(plan.id,{max_branches:e.target.value===''?null:Number(e.target.value)})}/></label><label>Max tables<input type="number" min="0" value={plan.max_tables??''} placeholder="Unlimited" onChange={e=>patch(plan.id,{max_tables:e.target.value===''?null:Number(e.target.value)})}/></label><label>Max menu items<input type="number" min="0" value={plan.max_menu_items??''} placeholder="Unlimited" onChange={e=>patch(plan.id,{max_menu_items:e.target.value===''?null:Number(e.target.value)})}/></label><label>Max monthly orders<input type="number" min="0" value={plan.max_monthly_orders??''} placeholder="Unlimited" onChange={e=>patch(plan.id,{max_monthly_orders:e.target.value===''?null:Number(e.target.value)})}/></label></div>
      <label className="admin-plan-toggle"><input type="checkbox" checked={plan.active} onChange={e=>patch(plan.id,{active:e.target.checked})}/><span>Plan available for new subscriptions</span></label>
      <div className="admin-feature-grid">{FEATURES.map((feature:Feature)=><label key={feature} className="admin-feature"><input type="checkbox" checked={Boolean(plan.features?.[feature])} onChange={e=>patch(plan.id,{features:{...plan.features,[feature]:e.target.checked}})}/><span>{feature}</span></label>)}</div>
      <label className="admin-custom-lines">Custom landing-page feature lines (one per line)<textarea rows={5} value={Array.isArray(plan.features?.custom_lines)?plan.features.custom_lines.join('\n'):''} onChange={e=>patch(plan.id,{features:{...plan.features,custom_lines:e.target.value.split('\n').map(v=>v.trim()).filter(Boolean)}})} placeholder="Dedicated onboarding&#10;Custom rollout support&#10;Priority success team" /></label>
      {plan.id==='ENTERPRISE'?<div className="admin-note">Enterprise is displayed as “Let’s talk” and uses the contact-sales CTA instead of self-serve billing.</div>:null}
      {plan.id!=='ENTERPRISE'?<div className="admin-provider-row"><div><strong>Razorpay plans</strong><span>Monthly: {plan.provider_plan_id??'Not provisioned'} · Annual: {plan.provider_plan_id_annual??'Not provisioned'}</span><small>{intervalChanged(plan,'month')||intervalChanged(plan,'year')?'A changed price is draft-only until that interval is re-provisioned. Existing subscriptions are not migrated.':'Provider plans are immutable; use Re-provision to create a new version.'}</small></div><div className="button-row"><button className="button button-light compact" disabled={busy!==null||!plan.active} onClick={()=>void provision(plan,'month')}>{busy===`provider:${plan.id}:month`?<><RefreshCw size={13} className="spin"/> Creating…</>:<><ShieldCheck size={13}/> {plan.provider_plan_id?'Re-provision Monthly':'Provision Monthly'}</>}</button><button className="button button-light compact" disabled={busy!==null||!plan.active} onClick={()=>void provision(plan,'year')}>{busy===`provider:${plan.id}:year`?<><RefreshCw size={13} className="spin"/> Creating…</>:<><ShieldCheck size={13}/> {plan.provider_plan_id_annual?'Re-provision Annual':'Provision Annual'}</>}</button></div></div>:null}
      <button className="button button-primary" disabled={busy!==null} onClick={()=>void save(plan)}>{busy===`save:${plan.id}`?<><RefreshCw size={14} className="spin"/> Saving…</>:<>Save {plan.name}</>}</button>
    </section>)}</div></main>
}
