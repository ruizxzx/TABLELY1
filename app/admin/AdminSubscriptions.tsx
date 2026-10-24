'use client';

import { useCallback, useEffect, useState } from 'react';

function moneyMinor(value: number, currency = 'INR') {
  return currency === 'INR' ? `₹${(Number(value || 0) / 100).toLocaleString('en-IN')}` : `${currency} ${(Number(value || 0) / 100).toLocaleString('en-IN')}`;
}

export default function AdminSubscriptions({ token }: { token: string }) {
  const [data, setData] = useState<any>({ plans: [], versions: [], subscriptions: [], environment: 'test' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [prices, setPrices] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    const response = await fetch('/api/admin?section=subscriptions', { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!response.ok) setMessage(body.error || 'Could not load subscription data.');
    else {
      setData(body.data);
      const next: Record<string, string> = {};
      for (const variant of body.data?.variants || []) next[`${variant.plan_key}:${variant.billing_period}`] = String(Number(variant.price_minor || 0) / 100);
      setPrices(next);
      setMessage('');
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  async function action(payload: any) {
    const key = payload.planKey ? `${payload.planKey}-${payload.billingPeriod || ''}` : (payload.subscriptionId || payload.action);
    setBusy(String(key)); setMessage('');
    try {
      const response = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Admin subscription action failed.');
      setMessage(body.warning || body.message || 'Subscription operation completed.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Subscription operation failed.');
    } finally {
      setBusy(null);
    }
  }

  const versionsByPlan = new Map<string, any[]>();
  for (const version of data.versions || []) versionsByPlan.set(version.plan_key, [...(versionsByPlan.get(version.plan_key) || []), version]);

  return <div>
    <div className="card panel" style={{ marginBottom: 14 }}>
      <div className="panel-head">
        <div>
          <div className="eyebrow">TABLELY SUBSCRIPTION</div>
          <h3 style={{ margin: '4px 0' }}>Pricing & provider provisioning</h3>
          <p className="muted" style={{ marginBottom: 0, lineHeight: 1.6 }}>
            Environment: <b>{data.environment}</b>. Monthly and annual prices provision separate Razorpay plans. Annual prices and discounts are controlled here; existing subscribers stay on their historical provider plan until changed.
          </p>
        </div>
        <div className="row-actions"><button className="btn btn-primary btn-sm" onClick={() => { if (window.confirm('Provision all active monthly and annual paid plans in Razorpay?')) void action({ action: 'provision_all_plans' }); }} disabled={loading || busy === 'provision_all_plans'}>{busy === 'provision_all_plans' ? 'Provisioning all…' : 'Provision all plans'}</button><button className="btn btn-sm" onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button></div>
      </div>
      {message && <div className={message.toLowerCase().includes('fail') || message.toLowerCase().includes('error') ? 'error-box' : 'info-note'} style={{ marginTop: 12 }}>{message}</div>}
    </div>

    <div className="dashboard-grid">
      {(data.plans || []).map((plan: any) => {
        const versions = versionsByPlan.get(plan.plan_key) || [];
        const monthly = (data.variants || []).find((variant: any) => variant.plan_key === plan.plan_key && variant.billing_period === 'monthly');
        const yearly = (data.variants || []).find((variant: any) => variant.plan_key === plan.plan_key && variant.billing_period === 'yearly');
        const current = versions.find(v => v.is_current && v.billing_period === 'monthly') || null;
        const yearlyCurrent = versions.find(v => v.is_current && v.billing_period === 'yearly') || null;
        return <div className="card panel" key={plan.plan_key}>
          <div className="panel-head">
            <div><span className="pill">{plan.plan_key.toUpperCase()}</span><h3 style={{ marginTop: 9 }}>{plan.name}</h3></div>
            <span className={`status ${current?.status === 'current' ? 'live' : 'pending'}`}>{current?.status || 'unprovisioned'}</span>
          </div>
          <p className="muted" style={{ minHeight: 42 }}>{plan.description || 'TABLELY subscription plan.'}</p>
          <label className="label">Monthly price (INR)</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input className="input" type="number" min={plan.plan_key === 'free' ? 0 : 1} step="1" value={prices[`${plan.plan_key}:monthly`] ?? String(Number(monthly?.price_minor || 0) / 100)} onChange={e => setPrices({ ...prices, [`${plan.plan_key}:monthly`]: e.target.value })} disabled={busy === `${plan.plan_key}-monthly`} /><span className="muted">/ month</span></div>
          <label className="label">Annual price (INR)</label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><input className="input" type="number" min={plan.plan_key === 'free' ? 0 : 1} step="1" value={prices[`${plan.plan_key}:yearly`] ?? String(Number(yearly?.price_minor || 0) / 100)} onChange={e => setPrices({ ...prices, [`${plan.plan_key}:yearly`]: e.target.value })} disabled={busy === `${plan.plan_key}-yearly`} /><span className="muted">/ year</span></div>
          <div className="info-note" style={{ marginTop: 10, fontSize: 12 }}><b>Annual discount:</b> {yearly?.annual_discount_percent || 0}%</div>
          <div className="info-note" style={{ marginTop: 12, fontSize: 12 }}>
            <b>Limits:</b> {Number(plan.max_products) === 9223372036854775807 ? 'Unlimited products' : `${plan.max_products} products`} · {Number(plan.max_categories) === 9223372036854775807 ? 'Unlimited categories' : `${plan.max_categories} categories`}<br/>
            <b>Current provider:</b> {current?.provider_plan_id ? current.provider_plan_id : 'Not provisioned'}
          </div>
          <div className="row-actions" style={{ marginTop: 14 }}><button className="btn btn-primary" disabled={busy === `${plan.plan_key}-monthly` || loading} onClick={() => {
            const rupees = Number(prices[`${plan.plan_key}:monthly`]);
            if (!Number.isFinite(rupees) || rupees < 0 || !Number.isInteger(rupees)) { setMessage('Plan price must be a whole number of rupees.'); return; }
            if (plan.plan_key !== 'free' && rupees <= 0) { setMessage('Paid TABLELY plans must have a positive price.'); return; }
            if (plan.plan_key === 'free' && rupees !== 0) { setMessage('The Free plan must remain ₹0.'); return; }
            void action({ action: 'reprovision_plan', planKey: plan.plan_key, billingPeriod: 'monthly', amountMinor: rupees * 100 });
          }}>{busy === `${plan.plan_key}-monthly` ? 'Provisioning…' : 'Provision monthly'}</button><button className="btn btn-primary" disabled={busy === `${plan.plan_key}-yearly` || loading} onClick={() => {
            const rupees = Number(prices[`${plan.plan_key}:yearly`]);
            const monthlyRupees = Number(prices[`${plan.plan_key}:monthly`]);
            if (!Number.isFinite(rupees) || rupees < 0 || !Number.isInteger(rupees)) { setMessage('Plan price must be a whole number of rupees.'); return; }
            if (plan.plan_key !== 'free' && rupees <= 0) { setMessage('Paid TABLELY plans must have a positive price.'); return; }
            if (plan.plan_key === 'free' && rupees !== 0) { setMessage('The Free plan must remain ₹0.'); return; }
            if (monthlyRupees > 0 && rupees > monthlyRupees * 12) { setMessage('Annual price cannot exceed twelve monthly payments.'); return; }
            const discount = monthlyRupees > 0 ? Math.round((1 - rupees / (monthlyRupees * 12)) * 10000) / 100 : 0;
            void action({ action: 'reprovision_plan', planKey: plan.plan_key, billingPeriod: 'yearly', amountMinor: rupees * 100, annualDiscountPercent: discount });
          }}>{busy === `${plan.plan_key}-yearly` ? 'Provisioning…' : 'Provision annual'}</button></div>
          <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>
            {versions.length ? `${versions.length} provider version${versions.length === 1 ? '' : 's'}` : 'No provider versions'}
          </div>
        </div>;
      })}
    </div>

    <div className="card panel" style={{ marginTop: 14, overflowX: 'auto' }}>
      <div className="panel-head"><div><div className="eyebrow">ACTIVE CREATOR BILLING</div><h3>Subscriptions</h3></div></div>
      {!(data.subscriptions || []).length ? <div className="empty-state"><b>No creator subscriptions yet</b><span>Subscriptions appear here after a creator completes TABLELY subscription checkout.</span></div> : <table className="table"><thead><tr><th>Creator</th><th>Plan</th><th>Status</th><th>Current period</th><th>Pending change</th><th>Provider</th><th>Action</th></tr></thead><tbody>{(data.subscriptions || []).map((sub: any) => <tr key={sub.id}><td><b>{sub.customer_email || sub.creator_id.slice(0, 8)}</b><div className="muted" style={{ fontSize: 11 }}>{sub.id.slice(0, 8)}</div></td><td>{sub.plan_key}</td><td><span className={`status ${['active','authenticated','paused'].includes(sub.status) ? 'live' : sub.status === 'failed' ? 'danger' : 'pending'}`}>{sub.status}</span></td><td>{sub.current_end ? new Date(sub.current_end).toLocaleDateString('en-IN') : '—'}</td><td>{sub.pending_plan_key ? `${sub.pending_plan_key} · ${sub.pending_change_at}` : sub.cancel_at_period_end ? 'Cancellation' : '—'}</td><td>{sub.provider_subscription_id}</td><td><div className="row-actions"><button className="btn btn-sm" disabled={busy === sub.id} onClick={() => void action({ action: 'sync_subscription', subscriptionId: sub.id })}>Sync</button>{sub.cancel_at_period_end && sub.pending_plan_key === 'free' ? <button className="btn btn-sm" disabled={busy === sub.id} onClick={() => void action({ action: 'admin_resume_subscription', subscriptionId: sub.id })}>Resume</button> : !['cancelled','completed','expired'].includes(sub.status) && <button className="btn btn-sm" disabled={busy === sub.id} onClick={() => void action({ action: 'admin_cancel_subscription', subscriptionId: sub.id })}>Cancel at cycle end</button>}</div></td></tr>)}</tbody></table>}
    </div>

    <div className="card panel" style={{ marginTop: 14 }}>
      <div className="eyebrow">PRICING RULE</div>
      <p className="muted" style={{ marginBottom: 0, lineHeight: 1.65 }}>
        The price shown publicly comes from <code>sellora_plans</code>. Reprovisioning creates a new immutable provider plan version, updates the public catalog price, and keeps existing subscription records tied to their historical provider plan until their scheduled change takes effect.
      </p>
    </div>
  </div>;
}
