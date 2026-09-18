'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, BadgeCheck, Check, CreditCard, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

declare global { interface Window { Razorpay?: new (options: Record<string, unknown>) => { open: () => void }; } }

type Plan = { id: string; name: string; description: string | null; price_monthly: number; price_annual: number; currency: string; billing_interval: string; trial_days: number; active: boolean; features: Record<string, boolean | number | null>; max_staff: number | null; max_branches: number | null; max_tables: number | null; max_menu_items: number | null; max_monthly_orders: number | null; has_monthly?: boolean; has_annual?: boolean };
type Subscription = { id: string; organization_id: string; plan_id: string; status: string; price_monthly_snapshot: number | null; price_annual_snapshot?: number | null; selected_price_snapshot?: number | null; currency: string; billing_interval: string; trial_started_at: string | null; trial_ends_at: string | null; current_period_start: string | null; current_period_end: string | null; provider_subscription_id: string | null; pending_plan_id: string | null; pending_provider_plan_id: string | null; pending_billing_interval: string | null; cancellation_requested_at: string | null };
type Billing = { plan_id: string; plan_name: string; price_monthly: number; price_annual?: number; selected_price?: number; currency: string; status: string; billing_interval?: string; trial_ends_at: string | null; current_period_end: string | null; provider_subscription_id: string | null; pending_plan_id: string | null; cancellation_requested_at: string | null };
type HistoryRow = { id: string; provider_payment_id: string | null; amount: number; currency: string; status: string; paid_at: string | null; created_at: string };
type Invoice = { id: string; status: string | null; amount: number; amount_paid: number; currency: string; date: string | null; billing_start: string | null; billing_end: string | null; short_url: string | null; description: string | null };

// Every bullet a plan card shows comes from this map applied to
// plan.features -- the same jsonb the admin Plan Management screen
// edits (GET /api/subscriptions/plans -> saas_plans.features). There is
// no separate hardcoded feature list for this page: add a feature toggle
// in the admin panel and, once it has a label below, it appears here
// automatically. (The public marketing pricing page on the homepage is
// the marketing pricing page is also backed by the same server-side catalog, with a safe static fallback only when the catalog cannot be reached.)
const featureLabels: Record<string, string> = { ONLINE_PAYMENTS: 'Online restaurant payments', UNLIMITED_STAFF: 'Unlimited staff', SERVICE_REQUESTS: 'Service requests', ANALYTICS: 'Analytics', PAYMENT_TRACKING: 'Payment tracking', CUSTOM_BRANDING: 'Custom branding', MULTI_BRANCH: 'Multiple branches', ADVANCED_ANALYTICS: 'Advanced analytics', CROSS_BRANCH_REPORTING: 'Cross-branch reporting', ADVANCED_PERMISSIONS: 'Advanced permissions', CUSTOM_DOMAIN: 'Custom domain' };

function money(value: number, currency = 'INR') { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value); }
function dateText(value: string | null) { return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
function daysLeft(value: string | null) { if (!value) return null; return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86400000)); }

export default function SubscriptionPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<'OWNER' | 'MANAGER' | 'WAITER' | 'KITCHEN' | ''>('');
  const [usage, setUsage] = useState<Record<string, unknown> | null>(null);
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month');

  async function load() {
    setLoading(true); setError(null);
    try {
      const responses = await Promise.all([
        fetch('/api/subscriptions/me', { cache: 'no-store' }),
        fetch('/api/subscriptions/history', { cache: 'no-store' }),
        fetch('/api/subscriptions/invoices', { cache: 'no-store' }),
        fetch('/api/subscriptions/plans', { cache: 'no-store' }),
        fetch('/api/subscriptions/usage', { cache: 'no-store' }),
      ]);
      const [me, historyData, invoiceData, adminData, usageData] = await Promise.all(responses.map(async (r) => ({ ok: r.ok, body: await r.json().catch(() => ({})) }))); 
      if (!me.ok) throw new Error(me.body.error || 'Could not load subscription.');
      if (!historyData.ok) throw new Error(historyData.body.error || 'Could not load subscription history.');
      setSubscription(me.body.subscription ?? null); setBilling(me.body.billing ?? null);
      if (me.body.subscription?.billing_interval === 'year') setBillingInterval('year'); else if (me.body.subscription?.billing_interval === 'month') setBillingInterval('month');
      setHistory(historyData.body.history ?? []); setInvoices(invoiceData.ok ? (invoiceData.body.invoices ?? []) : []);
      if (adminData.ok) setPlans((adminData.body.plans ?? []).filter((p: Plan) => p.active));
      if (usageData.ok) setUsage(usageData.body.usage ?? null);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not load subscription.'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (supabase) void getCurrentRestaurantContext(supabase).then((result) => { if (result.data) setRole(result.data.staff.role); });
    void load();
  }, []);

  const currentPlan = useMemo(() => plans.find((p) => p.id === subscription?.plan_id) ?? null, [plans, subscription?.plan_id]);
  const orderedPlans = useMemo(() => [...plans].sort((a, b) => Number(a.price_monthly) - Number(b.price_monthly)), [plans]);
  const isTrial = subscription?.status === 'TRIAL' || subscription?.status === 'TRIALING';
  const trialDays = daysLeft(subscription?.trial_ends_at ?? null);
  // The interval the restaurant is actually billed on, independent of the
  // monthly/annual toggle used to browse plan options below.
  const activeInterval: 'month' | 'year' = subscription?.billing_interval === 'year' ? 'year' : 'month';
  const currentPrice = billing?.selected_price ?? subscription?.selected_price_snapshot ?? (activeInterval === 'year' ? currentPlan?.price_annual : currentPlan?.price_monthly) ?? null;
  // Compare like with like: the price of the current plan at whichever interval the
  // plan cards are currently showing, so an annual card is never labelled an
  // "upgrade" purely because an annual price exceeds a monthly one.
  const comparisonPrice = billingInterval === 'year' ? (currentPlan?.price_annual ?? null) : (currentPlan?.price_monthly ?? null);

  async function startCheckout(planId: string) {
    setBusy(`checkout:${planId}`); setError(null); setMessage(null);
    try {
      const r = await fetch('/api/subscriptions/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId, interval: billingInterval }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'Could not start subscription checkout.');
      if (!body.providerSubscriptionId || !body.keyId) throw new Error('Subscription checkout is not configured.');
      if (!window.Razorpay) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script'); script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.onload = () => resolve(); script.onerror = () => reject(new Error('Could not load Razorpay Checkout.')); document.body.appendChild(script);
        });
      }
      if (!window.Razorpay) throw new Error('Razorpay Checkout is unavailable.');
      const selected = plans.find((p) => p.id === planId);
      const rzp = new window.Razorpay({ key: body.keyId, subscription_id: body.providerSubscriptionId, name: 'Tablely', description: `${selected?.name ?? planId} ${billingInterval === 'year' ? 'annual' : 'monthly'} subscription`, handler: async (response: Record<string, string>) => {
        const verify = await fetch('/api/subscriptions/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paymentId: response.razorpay_payment_id, subscriptionId: response.razorpay_subscription_id, signature: response.razorpay_signature }) });
        const verifyBody = await verify.json().catch(() => ({}));
        if (!verify.ok) setError(verifyBody.error || 'Payment verification failed.'); else { setMessage('Subscription payment verified.'); await load(); }
        setBusy(null);
      }, modal: { ondismiss: () => setBusy(null) }, theme: { color: '#f2762e' } });
      rzp.open();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Could not start subscription checkout.'); setBusy(null); }
  }

  async function changePlan(planId: string) {  setBusy(`change:${planId}`); setError(null); setMessage(null); try { const r=await fetch('/api/subscriptions/change',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({planId,interval:billingInterval})}); const b=await r.json().catch(()=>({})); if(!r.ok)throw new Error(b.error||'Could not schedule plan change.'); setMessage(`Plan change to ${planId} is scheduled for the next billing boundary.`); await load(); } catch(e:unknown){setError(e instanceof Error?e.message:'Could not change plan.');} finally{setBusy(null);} }
  async function cancelSubscription() { if(!window.confirm('Cancel the Tablely subscription at the end of the current billing period?')) return; setBusy('cancel'); setError(null); setMessage(null); try{const r=await fetch('/api/subscriptions/cancel',{method:'POST'});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||'Could not cancel subscription.');setMessage('Subscription cancellation is scheduled for the end of the current billing period.');await load();}catch(e:unknown){setError(e instanceof Error?e.message:'Could not cancel subscription.');}finally{setBusy(null);} }

  // Combined, chronological view of everything actually charged --
  // provider invoices (which have a receipt link) plus server-recorded
  // payment events that have no matching invoice yet.
  const paymentRows = useMemo(() => {
    const fromInvoices = invoices.map((inv) => ({ key: `inv:${inv.id}`, label: inv.description ?? 'Tablely subscription invoice', amount: inv.amount, currency: inv.currency, status: inv.status ?? '—', date: inv.date, url: inv.short_url }));
    const invoicedAt = new Set(invoices.map((inv) => inv.date));
    const fromHistory = history.filter((row) => !invoicedAt.has(row.paid_at ?? row.created_at)).map((row) => ({ key: `hist:${row.id}`, label: row.provider_payment_id ?? 'Payment event', amount: Number(row.amount), currency: row.currency, status: row.status, date: row.paid_at ?? row.created_at, url: null as string | null }));
    return [...fromInvoices, ...fromHistory].sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime());
  }, [invoices, history]);

  if (loading) return <StudioShell><div className="page-loading-card"><div className="setup-loading">Loading subscription…</div></div></StudioShell>;
  return <StudioShell><div className="settings-page sub2-page">
    <header className="page-header"><div><span className="eyebrow">BILLING</span><h1>Subscription</h1><p>Manage your Tablely plan, billing and feature access.</p></div><button className="button button-light" onClick={()=>void load()} disabled={busy!==null}><RefreshCw size={15}/> Refresh</button></header>
    {error?<div className="notice notice-error">{error}</div>:null}
    {message?<div className="notice notice-success">{message}</div>:null}

    <section className="surface-card sub2-current">
      <div className="sub2-current-top">
        <div>
          <span className="eyebrow">CURRENT PLAN</span>
          <h2>{billing?.plan_name ?? currentPlan?.name ?? subscription?.plan_id ?? 'No plan'} · {currentPrice!==null?money(Number(currentPrice),billing?.currency ?? currentPlan?.currency ?? 'INR'):'—'}/{activeInterval==='year'?'year':'month'}</h2>
          <p className="sub2-status-line">Status: <strong>{billing?.status ?? subscription?.status ?? 'UNKNOWN'}</strong></p>
        </div>
        <span className="sub2-icon-badge"><ShieldCheck size={17}/></span>
      </div>
      <div className="sub2-stat-grid">
        <div><span>Starts</span><strong>{dateText(subscription?.trial_started_at ?? subscription?.current_period_start ?? null)}</strong></div>
        <div><span>Trial ends</span><strong>{isTrial?dateText(subscription?.trial_ends_at ?? null):'—'}</strong></div>
        <div><span>Next billing</span><strong>{dateText(subscription?.current_period_end ?? billing?.current_period_end ?? null)}</strong></div>
        <div><span>Staff limit</span><strong>{currentPlan?.max_staff ?? 'Unlimited'}</strong></div>
        <div><span>Branches</span><strong>{currentPlan?.max_branches ?? 'Unlimited'}</strong></div><div><span>Tables</span><strong>{currentPlan?.max_tables ?? 'Unlimited'}</strong></div><div><span>Menu items</span><strong>{currentPlan?.max_menu_items ?? 'Unlimited'}</strong></div><div><span>Orders / month</span><strong>{currentPlan?.max_monthly_orders ?? 'Unlimited'}</strong></div>
      </div>
      {subscription?.provider_subscription_id&&subscription.status!=='CANCELLED'&&subscription.status!=='EXPIRED'&&!subscription.cancellation_requested_at&&role==='OWNER'?<button className="button button-light" onClick={()=>void cancelSubscription()} disabled={busy!==null}><XCircle size={15}/> Cancel at period end</button>:null}
    </section>

    {usage ? <section className="surface-card"><div className="card-heading"><div><h2>Usage</h2><p>Current usage against your plan limits.</p></div></div><div className="sub2-stat-grid">{[['Staff','staff'],['Branches','branches'],['Tables','tables'],['Menu items','menu_items'],['Orders this month','orders']].map(([label,key])=>{const used=Number((usage.usage as Record<string,unknown>|undefined)?.[key] ?? 0);const limitRaw=(usage.limits as Record<string,unknown>|undefined)?.[key==='staff'?'max_staff':key==='branches'?'max_branches':key==='tables'?'max_tables':key==='menu_items'?'max_menu_items':'max_monthly_orders'];const limit=limitRaw==null?null:Number(limitRaw);return <div key={key}><span>{label}</span><strong>{used} / {limit==null?'Unlimited':limit}</strong></div>;})}</div></section> : null}

    <section className="surface-card sub2-payments">
      <div className="card-heading"><div><h2>Tablely subscription payments</h2><p>Historical SaaS subscription charges for this restaurant.</p></div><CreditCard size={18}/></div>
      <div className="data-table">{paymentRows.length?paymentRows.map((row)=><div className="sub-table-row" key={row.key}><div><strong>{row.label}</strong><div className="muted">{dateText(row.date)}</div></div><span className="sub-amount">{money(row.amount,row.currency)}</span><span className={`sub-chip ${row.status==='PAID'||row.status==='CAPTURED'||row.status==='paid'?'tone-good':row.status==='FAILED'||row.status==='failed'?'tone-bad':'tone-warn'}`}>{row.status}</span><span/>{row.url?<a className="button button-light compact" href={row.url} target="_blank" rel="noreferrer">Open</a>:<span/>}</div>):<div className="empty-wide">No subscription payments recorded yet.</div>}</div>
    </section>

    {isTrial&&trialDays!==null?<section className="sub-panel tone-trial"><ShieldCheck size={16}/> Trial ends on {dateText(subscription.trial_ends_at)}. Paid access follows the selected plan until the trial expires.</section>:null}
    {subscription?.pending_plan_id?<div className="sub-panel tone-info"><RefreshCw size={16}/> Plan change to {subscription.pending_plan_id}{subscription.pending_billing_interval?` (${subscription.pending_billing_interval==='year'?'annual':'monthly'})`:''} is scheduled for the next billing boundary.</div>:null}
    {subscription?.cancellation_requested_at?<div className="sub-panel tone-warn"><XCircle size={16}/> Cancellation requested on {dateText(subscription.cancellation_requested_at)}. Access remains available until the current period ends.</div>:null}

    <section>
      <div className="card-heading"><div><h2>Plan options</h2><p>Choose the plan that matches your restaurant operations.</p></div></div>
      <div className="button-row" style={{ marginBottom: 16 }}><button className={`button ${billingInterval==='month'?'button-primary':'button-light'}`} onClick={()=>setBillingInterval('month')}>Monthly</button><button className={`button ${billingInterval==='year'?'button-primary':'button-light'}`} onClick={()=>setBillingInterval('year')}>Annual</button></div>
      <div className="sub2-plan-grid">{orderedPlans.map((plan)=>{
        const isCurrent = subscription?.plan_id===plan.id && subscription?.status==='ACTIVE' && billingInterval===activeInterval;
        const planPrice = billingInterval === 'year' ? Number(plan.price_annual) : Number(plan.price_monthly);
        const isDowngrade = comparisonPrice!==null && planPrice < Number(comparisonPrice);
        const isUpgrade = comparisonPrice!==null && planPrice > Number(comparisonPrice);
        const busyKey = busy===`checkout:${plan.id}`||busy===`change:${plan.id}`;
        // Don't offer an interval the catalog has no provider plan for; the server
        // rejects it and the owner would only see an opaque error.
        const intervalAvailable = billingInterval==='year' ? plan.has_annual!==false : plan.has_monthly!==false;
        return <article className={`sub2-plan-card ${isCurrent?'is-current':''}`} key={plan.id}>
          <span className="sub2-plan-accent"/>
          <div className="sub2-plan-top"><span className="eyebrow">TABLELY</span><span className="sub2-plan-price">{money(planPrice,plan.currency)}<small>/{billingInterval==='year'?'year':'month'}</small></span></div>
          <h3>{plan.name}</h3>
          <ul className="sub2-plan-features">{Object.entries(plan.features).filter(([key,value])=>key===key.toUpperCase()&&value===true).map(([feature])=><li key={feature}><Check size={14}/><span>{featureLabels[feature]??feature.replaceAll('_',' ')}</span></li>)}</ul>
          {isCurrent?<button className="button button-light" disabled><BadgeCheck size={15}/> Current plan</button>
            :role!=='OWNER'?<button className="button button-light" disabled>Owner approval required</button>
            :!intervalAvailable?<button className="button button-light" disabled>{billingInterval==='year'?'Annual billing unavailable':'Monthly billing unavailable'}</button>
            :<button className="button button-primary" disabled={busy!==null} onClick={()=>subscription?.provider_subscription_id&&subscription?.status==='ACTIVE'?void changePlan(plan.id):void startCheckout(plan.id)}>
              {busyKey?<><RefreshCw size={14} className="spin"/> Processing…</>
                :isTrial?<>{subscription?.plan_id===plan.id?`Subscribe to ${plan.name}`:`Choose ${plan.name}`}</>
                :isDowngrade?<><ArrowDownCircle size={15}/> Downgrade</>
                :isUpgrade?<><ArrowUpCircle size={15}/> Upgrade</>
                :`Switch to ${plan.name}`}
            </button>}
        </article>;
      })}</div>
    </section>
  </div></StudioShell>;
}
