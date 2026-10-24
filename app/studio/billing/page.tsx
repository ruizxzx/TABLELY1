'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

function moneyMinor(value: number, currency = 'INR') {
  return currency.toUpperCase() === 'INR' ? `₹${(Number(value || 0) / 100).toLocaleString('en-IN')}` : `${currency.toUpperCase()} ${(Number(value || 0) / 100).toLocaleString('en-IN')}`;
}

function planLabel(key: string) { return key.charAt(0).toUpperCase() + key.slice(1); }

async function loadRazorpay(): Promise<any> {
  if ((window as any).Razorpay) return (window as any).Razorpay;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load Razorpay Checkout. Check your connection or content-security policy.'));
    document.body.appendChild(script);
  });
  const Razorpay = (window as any).Razorpay;
  if (!Razorpay) throw new Error('Razorpay oheckout failed to initialize.');
  return Razorpay;
}

export default function BillingPage() {
  const [plans, setPlans] = useState<any[]>([]);
  const [subscription, setSubscription] = useState<any>(null);
  const [creatorPlan, setCreatorPlan] = useState<any>(null);
  const [payments, setPayments] = useState<any[]>([]);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [environment, setEnvironment] = useState('test');
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly');

  const authHeaders = useCallback(async () => {
    if (!supabase) throw new Error('Supabase is not configured.');
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Please sign in again.');
    return { Authorization: `Bearer ${session.access_token}` };
  }, []);

  const load = useCallback(async () => {
    try {
      const headers = await authHeaders();
      const response = await fetch('/api/billing/me', { headers, cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load subscriptions.');
      setPlans(body.data?.plans || []);
      setSubscription(body.data?.subscription || null);
      setCreatorPlan(body.data?.creatorPlan || null);
      setPayments(body.data?.payments || []);
      setEmail(body.data?.email || '');
      setEnvironment(body.data?.environment || 'test');
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load subscriptions.');
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => { void load(); }, [load]);

  const currentPlanKey = creatorPlan?.plan || subscription?.plan_key || 'free';
  const currentPlan = plans.find(p => p.plan_key === currentPlanKey) || plans.find(p => p.plan_key === 'free');
  const selectedVariant = (plan: any) => plan?.variants?.find((variant: any) => variant.billing_period === billingPeriod) || plan;
  const hasLiveSubscription = Boolean(subscription && ['authenticated','active','pending','paused','halted'].includes(String(subscription.status)));
  const planFeatures: Record<string, string[]> = {
    free: ['Link Hub', 'Store', 'Checkout', 'Email capture', '1 product', '1 category', 'Basic analytics', 'TABLELY branding'],
    creator: ['Up to 10 products', 'Up to 2 categories', 'Coupons', 'Bundles', 'Upsells', 'Standard analytics', 'Branding removal'],
    pro: ['Unlimited products', 'Up to 10 categories', 'Custom domain', 'Advanced analytics', 'Coupons', 'Bundles', 'Upsells'],
    max: ['Unlimited products', 'Unlimited categories', 'Custom domain', 'Advanced analytics', 'Coupons', 'Bundles', 'Upsells'],
  };

  const sortedPlans = useMemo(() => [...plans].sort((a,b) => Number(a.price_minor||0) - Number(b.price_minor||0)), [plans]);

  async function subscribe(planKey: string, period = billingPeriod) {
    setBusy(`${planKey}-${period}`); setError(''); setMessage('');
    try {
      const headers = await authHeaders();
      const response = await fetch('/api/billing/create-subscription', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ planKey, billingPeriod: period }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not start subscription.');
      const Razorpay = await loadRazorpay();
      await new Promise<void>((resolve, reject) => {
        const abandonoheckout = async () => {
          try {
            const cleanupHeaders = await authHeaders();
            await fetch('/api/billing/abandon', { method:'POST', headers:{...cleanupHeaders,'Content-Type':'application/json'}, body:JSON.stringify({ subscriptionId: body.data.subscriptionRecordId }) });
          } catch {}
        };
        const checkout = new Razorpay({
          key: body.data.keyId,
          subscription_id: body.data.subscriptionId,
          name: 'TABLELY',
          description: `${planLabel(planKey)} subscription`,
          prefill: { email },
          theme: { color: '#5b4be7' },
          handler: async (response: any) => {
            try {
              const verifyHeaders = await authHeaders();
              const verifyResponse = await fetch('/api/billing/verify', { method:'POST', headers:{...verifyHeaders,'Content-Type':'application/json'}, body:JSON.stringify(response) });
              const verifyBody = await verifyResponse.json();
              if (!verifyResponse.ok) throw new Error(verifyBody.error || 'Subscription verification failed.');
              setMessage('Subscription payment verified. Your TABLELY entitlement will update from the confirmed provider state.');
              resolve();
            } catch (e) { reject(e); }
          },
          modal: { ondismiss: () => { void abandonoheckout(); reject(new Error('Checkout cancelled. You can try again anytime.')); } },
        });
        checkout.open();
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start subscription.');
    } finally { setBusy(''); }
  }

  async function changePlan(planKey: string, period = billingPeriod) {
    setBusy(`${planKey}-${period}`); setError(''); setMessage('');
    try {
      if (!window.confirm(`Change your TABLELY plan to ${planLabel(planKey)} (${period === 'yearly' ? 'annual' : 'monthly'})?`)) { setBusy(''); return; }
      const headers = await authHeaders();
      const response = await fetch('/api/billing/change-plan', { method:'POST', headers:{...headers,'Content-Type':'application/json'}, body:JSON.stringify({planKey, billingPeriod: period}) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not change subscription.');
      setMessage(body.data?.changeAt === 'cycle_end' || body.data?.scheduledPlanKey ? `Change to ${planLabel(planKey)} is scheduled for the current billing cycle end.` : `Plan changed to ${planLabel(planKey)}.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change plan.'); }
    finally { setBusy(''); }
  }

  async function cancel() {
    setBusy('cancel'); setError(''); setMessage('');
    try {
      if (!window.confirm('Cancel your TABLELY subscription at the end of the current billing period?')) { setBusy(''); return; }
      const headers = await authHeaders();
      const response = await fetch('/api/billing/cancel', { method:'POST', headers:{...headers,'Content-Type':'application/json'} });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not cancel subscription.');
      setMessage('Cancellation has been scheduled for the current billing cycle end.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not cancel subscription.'); }
    finally { setBusy(''); }
  }

  async function resumeCancellation() {
    setBusy('resume'); setError(''); setMessage('');
    try {
      if (!window.confirm('Resume your current TABLELY plan and remove the scheduled cancellation?')) { setBusy(''); return; }
      const headers = await authHeaders();
      const response = await fetch('/api/billing/resume', { method:'POST', headers:{...headers,'Content-Type':'application/json'} });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not resume subscription.');
      setMessage('Scheduled cancellation has been removed. Your current plan will continue renewing normally.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not resume subscription.'); }
    finally { setBusy(''); }
  }

  async function sync() {
    setBusy('sync'); setError(''); setMessage('');
    try {
      const headers = await authHeaders();
      const response = await fetch('/api/billing/sync', { method:'POST', headers:{...headers,'Content-Type':'application/json'} });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not sync billing.');
      setMessage('Subscription state synchronized with the provider.');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not sync billing.'); }
    finally { setBusy(''); }
  }

  return <div className="studio-content">
    <div className="page-title"><div><div className="eyebrow">TABLELY SUBSCRIPTIONS</div><h1>Subscriptions</h1><p>Your TABLELY subscription controls your creator workspace limits and platform features. Creator product sales remain connected to your own Razorpay account and are separate from your TABLELY subscription.</p></div></div>
    {message && <div className="success-box">{message}</div>}
    {error && <div className="error-box">{error}</div>}

    <div className="stats">
      <div className="card stat"><div className="label2">Current plan</div><div className="value" style={{fontSize:25}}>{planLabel(String(currentPlanKey))}</div></div>
      <div className="card stat"><div className="label2">{billingPeriod === 'yearly' ? 'Annual price' : 'Monthly price'}</div><div className="value" style={{fontSize:25}}>{moneyMinor(Number(selectedVariant(currentPlan)?.price_minor || 0), selectedVariant(currentPlan)?.currency || 'INR')}</div></div>
      <div className="card stat"><div className="label2">Subscription status</div><div className="value" style={{fontSize:18}}>{subscription?.status || (creatorPlan?.access_source ? creatorPlan.access_source : 'free')}</div></div>
      <div className="card stat"><div className="label2">Environment</div><div className="value" style={{fontSize:18}}>{environment}</div></div>
    </div>

    {subscription && <div className="card panel" style={{ marginTop:14 }}>
      <div className="panel-head"><div><div className="eyebrow">CURRENT SUBSCRIPTION</div><h3>{planLabel(subscription.plan_key)} · {subscription.provider_subscription_id}</h3><p className="muted">Current period: {subscription.current_start ? new Date(subscription.current_start).toLocaleDateString('en-IN') : '—'} → {subscription.current_end ? new Date(subscription.current_end).toLocaleDateString('en-IN') : '—'}</p></div><button className="btn btn-sm" disabled={busy==='sync'} onClick={()=>void sync()}>{busy==='sync'?'Syncing…':'Sync now'}</button></div>
      <div className="dashboard-grid">
        <div className="card" style={{padding:16}}><b>Provider state</b><p className="muted" style={{marginBottom:0}}>{subscription.status}</p></div>
        <div className="card" style={{padding:16}}><b>Next charge</b><p className="muted" style={{marginBottom:0}}>{subscription.charge_at ? new Date(subscription.charge_at).toLocaleDateString('en-IN') : '—'}</p></div>
        <div className="card" style={{padding:16}}><b>Pending change</b><p className="muted" style={{marginBottom:0}}>{subscription.pending_plan_key ? `${planLabel(subscription.pending_plan_key)} (${subscription.pending_change_at})` : subscription.cancel_at_period_end ? 'Cancellation at period end' : 'None'}</p></div>
      </div>
      {hasLiveSubscription && <div className="row-actions" style={{marginTop:14}}><button className="btn" disabled={Boolean(busy)} onClick={()=>void changePlan('free')}>Move to Free at period end</button>{subscription.cancel_at_period_end && !subscription.pending_plan_key ? <button className="btn" disabled={Boolean(busy)} onClick={()=>void resumeCancellation()}>{busy==='resume'?'Resuming…':'Resume subscription'}</button> : <button className="btn" disabled={Boolean(busy)||subscription.cancel_at_period_end} onClick={()=>void cancel()}>{busy==='cancel'?'Scheduling…':'Cancel at period end'}</button>}</div>}
    </div>}

    <div className="card panel" style={{marginTop:14}}>
      <div className="panel-head"><div><div className="eyebrow">AVAILABLE PLANS</div><h3>Choose an TABLELY plan</h3></div><div className="billing-toggle"><button className={billingPeriod === 'monthly' ? 'active' : ''} onClick={()=>setBillingPeriod('monthly')}>Monthly</button><button className={billingPeriod === 'yearly' ? 'active' : ''} onClick={()=>setBillingPeriod('yearly')}>Annual <span>save more</span></button></div></div>
      {loading ? <div className="loading-card">Loading plans…</div> : <div className="feature-grid">{sortedPlans.map(plan => {
        const variant = selectedVariant(plan);
        const active = plan.plan_key === currentPlanKey && (subscription?.billing_period || 'monthly') === billingPeriod;
        const pending = subscription?.pending_plan_key === plan.plan_key && (subscription?.pending_billing_period || subscription?.billing_period || 'monthly') === billingPeriod;
        const disabled = Boolean(busy) || plan.plan_key === 'free' && !hasLiveSubscription;
        const features = planFeatures[plan.plan_key] || [];
        return <div className="card feature" key={plan.plan_key} style={{borderColor: active ? '#cfc5ff' : undefined}}>
          {active && <span className="pill">CURRENT</span>}
          {pending && <span className="pill" style={{marginLeft:6}}>SCHEDULED</span>}
          <h3 style={{marginTop:12}}>{plan.name}</h3>
          <div style={{fontFamily:'Space Grotesk',fontSize:36,margin:'10px 0'}}>{moneyMinor(Number(variant?.price_minor || plan.price_minor || 0),variant?.currency || plan.currency)}<span style={{fontSize:13,color:'#777'}}> / {billingPeriod === 'yearly' ? 'year' : 'mo'}</span></div>
          {billingPeriod === 'yearly' && Number(variant?.annual_discount_percent || 0) > 0 && <div className="billing-savings">Save {variant.annual_discount_percent}% with annual billing</div>}
          <p style={{minHeight:44}}>{plan.description || 'TABLELY creator subscription.'}</p>
          <div className="muted" style={{fontSize:12,lineHeight:1.7}}>{Number(plan.max_products) === 9223372036854775807 ? 'Unlimited products' : `${plan.max_products} products`} · {Number(plan.max_categories) === 9223372036854775807 ? 'Unlimited categories' : `${plan.max_categories} categories`}</div>
          <ul style={{paddingLeft:18, margin:'12px 0 0', color:'#4d4d5f', fontSize:12, lineHeight:1.8}}>{features.map(feature => <li key={feature}>{feature}</li>)}</ul>
          <div style={{marginTop:16}}>
            {active ? <button className="btn" disabled>Current plan</button> : plan.plan_key === 'free' ? <button className="btn" disabled={disabled} onClick={()=>void changePlan('free', billingPeriod)}>Downgrade at period end</button> : hasLiveSubscription ? <button className="btn btn-primary" disabled={disabled} onClick={()=>void changePlan(plan.plan_key, billingPeriod)}>{busy===`${plan.plan_key}-${billingPeriod}`?'Changing…':(Number(variant?.price_minor || plan.price_minor)>Number(selectedVariant(currentPlan)?.price_minor || 0)?'Upgrade now':'Change plan')}</button> : <button className="btn btn-primary" disabled={disabled} onClick={()=>void subscribe(plan.plan_key, billingPeriod)}>{busy===`${plan.plan_key}-${billingPeriod}`?'Starting…':'Subscribe'}</button>}
          </div>
        </div>;
      })}</div>}
    </div>

    <div className="card panel" style={{marginTop:14,overflowX:'auto'}}>
      <div className="panel-head"><div><div className="eyebrow">SUBSCRIPTION HISTORY</div><h3>Subscription payments</h3></div></div>
      {!payments.length ? <div className="empty-state"><b>No completed subscription payments yet</b><span>Completed TABLELY subscription charges will appear here.</span></div> : <table className="table"><thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Method</th><th>Provider payment</th><th>Invoice</th></tr></thead><tbody>{payments.map((p:any)=><tr key={p.id}><td>{new Date(p.created_at).toLocaleString('en-IN')}</td><td>{moneyMinor(Number(p.amount_minor||0),p.currency)}</td><td><span className="status live">captured</span></td><td>{p.payment_method || '—'}</td><td>{p.provider_payment_id}</td><td>{p.provider_invoice_id || '—'}</td></tr>)}</tbody></table>}
    </div>
  </div>;
}
