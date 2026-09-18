'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft, CreditCard, FileText, RefreshCw, Tag, ToggleLeft, ToggleRight } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type Subscription = { organization_id: string; organization_name: string; plan_id: string; plan_name: string; status: string; billing_interval: string; selected_price: number; trial_ends_at: string | null; current_period_end: string | null; provider_subscription_id: string | null };
type Plan = { id: string; name: string };
type Invoice = { id: string; organization_name: string | null; provider_payment_id: string | null; provider_subscription_id: string | null; status: string | null; amount: number | null; currency: string; issued_at: string; event_type: string };
type Coupon = { id: string; organization_name: string; code: string; title: string | null; discount_type: string; discount_value: number; is_active: boolean; usage_limit_total: number | null; usage_count: number; updated_at: string };
type Tab = 'subscriptions' | 'invoices' | 'coupons';

const statuses = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED'];
const money = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value));
const when = (value: string | null) => value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function AdminBillingPage() {
  const supabase = getSupabaseBrowserClient();
  const [tab, setTab] = useState<Tab>('subscriptions');
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { plan: string; status: string; start: string; end: string }>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    setLoading(true); setError(null);
    const [sub, plan, invoice, coupon] = await Promise.all([
      supabase.rpc('admin_list_subscription_overview_v2'),
      supabase.rpc('admin_list_plans_v2'),
      supabase.rpc('admin_list_invoices', { p_limit: 250 }),
      supabase.rpc('admin_list_coupons', { p_limit: 500 }),
    ]);
    const first = sub.error ?? plan.error ?? invoice.error ?? coupon.error;
    if (first) setError(first.message);
    else {
      setSubscriptions((sub.data ?? []) as Subscription[]);
      setPlans((plan.data ?? []) as Plan[]);
      setInvoices((invoice.data ?? []) as Invoice[]);
      setCoupons((coupon.data ?? []) as Coupon[]);
    }
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  function draft(row: Subscription) {
    return drafts[row.organization_id] ?? { plan: row.plan_id, status: row.status === 'TRIALING' ? 'TRIAL' : row.status, start: '', end: '' };
  }
  function setDraft(id: string, changes: Partial<{ plan: string; status: string; start: string; end: string }>) {
    setDrafts(current => ({ ...current, [id]: { ...(current[id] ?? { plan: '', status: 'ACTIVE', start: '', end: '' }), ...changes } }));
  }
  async function saveSubscription(row: Subscription) {
    if (!supabase) return;
    const value = draft(row);
    setBusy(`sub:${row.organization_id}`); setError(null);
    const { error: updateError } = await supabase.rpc('admin_update_subscription', {
      p_organization_id: row.organization_id, p_plan_id: value.plan, p_status: value.status,
      p_start_at: value.start ? new Date(value.start).toISOString() : null,
      p_end_at: value.end ? new Date(value.end).toISOString() : null,
    });
    if (updateError) setError(updateError.message); else await load();
    setBusy(null);
  }
  async function toggleCoupon(coupon: Coupon) {
    if (!supabase) return;
    setBusy(`coupon:${coupon.id}`); setError(null);
    const { error: updateError } = await supabase.rpc('admin_set_coupon_status', { p_coupon_id: coupon.id, p_is_active: !coupon.is_active });
    if (updateError) setError(updateError.message); else setCoupons(current => current.map(item => item.id === coupon.id ? { ...item, is_active: !coupon.is_active } : item));
    setBusy(null);
  }
  async function deleteCoupon(coupon: Coupon) {
    if (!supabase || !window.confirm(`Delete coupon ${coupon.code}? Historical order snapshots remain safe.`)) return;
    setBusy(`delete:${coupon.id}`); setError(null);
    const { error: deleteError } = await supabase.rpc('admin_delete_coupon', { p_coupon_id: coupon.id });
    if (deleteError) setError(deleteError.message); else setCoupons(current => current.filter(item => item.id !== coupon.id));
    setBusy(null);
  }

  if (loading) return <main className="admin-page"><div className="setup-loading">Loading billing controls…</div></main>;
  return <main className="admin-page">
    <header className="admin-top"><div><Link href="/admin" className="back-link"><ArrowLeft size={15} /> Admin dashboard</Link><span className="eyebrow">BILLING CONTROL</span><h1>Billing operations</h1><p>Control plans, subscriptions, invoices, payment events and coupons across every restaurant.</p></div><button className="button button-light" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button></header>
    {error ? <div className="notice notice-error">{error}</div> : null}
    <nav className="admin-billing-tabs">{(['subscriptions', 'invoices', 'coupons'] as Tab[]).map(item => <button key={item} className={`toggle ${tab === item ? 'on' : ''}`} onClick={() => setTab(item)}>{item === 'subscriptions' ? <CreditCard size={14} /> : item === 'invoices' ? <FileText size={14} /> : <Tag size={14} />} {item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
    {tab === 'subscriptions' ? <section className="surface-card"><div className="card-heading"><div><h2>Subscription controls</h2><p>Change plan, lifecycle status, trial dates and billing period for any restaurant.</p></div></div><div className="admin-billing-list">{subscriptions.map(row => { const value = draft(row); return <div className="admin-billing-row" key={row.organization_id}><div className="admin-billing-identity"><strong>{row.organization_name}</strong><span>{row.plan_name} · {row.organization_id}</span><small>{row.provider_subscription_id ? `Provider: ${row.provider_subscription_id}` : 'No provider subscription linked'}</small></div><select className="field-select" value={value.plan} onChange={event => setDraft(row.organization_id, { plan: event.target.value })}>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select><select className="field-select" value={value.status} onChange={event => setDraft(row.organization_id, { status: event.target.value })}>{statuses.map(status => <option key={status} value={status}>{status}</option>)}</select><label className="admin-date-field">Start<input type="datetime-local" value={value.start} onChange={event => setDraft(row.organization_id, { start: event.target.value })} /></label><label className="admin-date-field">End<input type="datetime-local" value={value.end} onChange={event => setDraft(row.organization_id, { end: event.target.value })} /></label><button className="button button-primary" disabled={busy === `sub:${row.organization_id}`} onClick={() => void saveSubscription(row)}>{busy === `sub:${row.organization_id}` ? 'Saving…' : 'Apply'}</button></div> })}</div></section> : null}
    {tab === 'invoices' ? <section className="surface-card"><div className="card-heading"><div><h2>Invoices and payment events</h2><p>Provider invoice/payment events recorded by webhook processing.</p></div><FileText size={18} /></div><div className="data-table admin-billing-table"><div className="data-row data-head"><span>Restaurant</span><span>Event</span><span>Status</span><span>Amount</span><span>Issued</span></div>{invoices.map(invoice => <div className="data-row" key={invoice.id}><div><strong>{invoice.organization_name ?? 'Unmatched event'}</strong><span>{invoice.provider_payment_id ?? invoice.provider_subscription_id ?? 'No provider ID'}</span></div><span>{invoice.event_type}</span><span>{invoice.status ?? '—'}</span><strong>{money(invoice.amount)} {invoice.currency}</strong><span>{when(invoice.issued_at)}</span></div>)}{invoices.length === 0 ? <div className="empty-wide">No invoice or payment events recorded.</div> : null}</div></section> : null}
    {tab === 'coupons' ? <section className="surface-card"><div className="card-heading"><div><h2>Coupon controls</h2><p>Disable or permanently remove coupons created by any restaurant.</p></div><Tag size={18} /></div><div className="data-table admin-billing-table"><div className="data-row data-head"><span>Restaurant</span><span>Coupon</span><span>Discount</span><span>Usage</span><span>Actions</span></div>{coupons.map(coupon => <div className="data-row" key={coupon.id}><div><strong>{coupon.organization_name}</strong><span>{coupon.title ?? 'Untitled offer'}</span></div><strong>{coupon.code}</strong><span>{coupon.discount_type === 'PERCENTAGE' ? `${coupon.discount_value}%` : money(coupon.discount_value)}</span><span>{coupon.usage_count}/{coupon.usage_limit_total ?? '∞'}</span><div className="button-row"><button className="button button-light compact" disabled={busy === `coupon:${coupon.id}`} onClick={() => void toggleCoupon(coupon)}>{coupon.is_active ? <><ToggleRight size={14} /> Disable</> : <><ToggleLeft size={14} /> Enable</>}</button><button className="button button-danger compact" disabled={busy === `delete:${coupon.id}`} onClick={() => void deleteCoupon(coupon)}>Delete</button></div></div>)}{coupons.length === 0 ? <div className="empty-wide">No coupons found.</div> : null}</div></section> : null}
  </main>;
}
