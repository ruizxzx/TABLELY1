'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, ArrowLeft, BarChart3, BookOpen, CreditCard, FileWarning, LifeBuoy, RefreshCw, Settings, Shield } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type Tab = 'overview' | 'orders' | 'payments' | 'customers' | 'support' | 'feedback' | 'security' | 'webhooks' | 'settings';
type Row = Record<string, unknown>;
type Overview = Record<string, unknown>;
const tabs: Array<[Tab, string, typeof Activity]> = [['overview', 'Overview', BarChart3], ['orders', 'Orders', Activity], ['payments', 'Payments', CreditCard], ['customers', 'Customers', BookOpen], ['support', 'Support', LifeBuoy], ['feedback', 'Feedback', BookOpen], ['security', 'Security', Shield], ['webhooks', 'Webhooks', FileWarning], ['settings', 'System settings', Settings]];
const text = (value: unknown) => value == null ? '—' : String(value);
const date = (value: unknown) => value ? new Date(String(value)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const money = (value: unknown) => value == null ? '—' : `₹${Number(value).toLocaleString('en-IN')}`;

export default function AdminOperationsPage() {
  const supabase = getSupabaseBrowserClient();
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [settings, setSettings] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(nextTab = tab) {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    setLoading(true); setError(null);
    const calls: Record<Tab, () => Promise<{ data: unknown; error: { message: string } | null }>> = {
      overview: async () => await supabase.rpc('admin_operations_overview'),
      orders: async () => await supabase.rpc('admin_list_orders', { p_limit: 250 }),
      payments: async () => await supabase.rpc('admin_list_payments', { p_limit: 250 }),
      customers: async () => await supabase.rpc('admin_list_customers', { p_limit: 250 }),
      support: async () => await supabase.rpc('admin_list_support', { p_limit: 250 }),
      feedback: async () => await supabase.rpc('admin_list_feedback_reports', { p_limit: 300 }),
      security: async () => await supabase.rpc('admin_list_security_events', { p_limit: 250 }),
      webhooks: async () => await supabase.rpc('admin_list_webhook_events', { p_limit: 250 }),
      settings: async () => await supabase.rpc('admin_list_system_settings'),
    };
    const result = await calls[nextTab]();
    if (result.error) setError(result.error.message);
    else if (nextTab === 'overview') setOverview((result.data ?? null) as Overview);
    else if (nextTab === 'settings') setSettings((result.data ?? []) as Row[]);
    else setRows((result.data ?? []) as Row[]);
    setLoading(false);
  }
  useEffect(() => { void load(); }, [tab]);

  async function setMaintenance(enabled: boolean) {
    if (!supabase) return;
    setBusy(true); setError(null);
    const { error: updateError } = await supabase.rpc('admin_set_maintenance', { p_enabled: enabled, p_message: enabled ? 'Tablely is temporarily under maintenance.' : '' });
    if (updateError) setError(updateError.message); else await load('overview');
    setBusy(false);
  }
  async function saveSetting(setting: Row, value: string) {
    if (!supabase) return;
    setBusy(true); setError(null);
    let parsed: unknown = value;
    try { parsed = JSON.parse(value); } catch { setError('Settings must contain valid JSON.'); setBusy(false); return; }
    const { error: updateError } = await supabase.rpc('admin_update_system_setting', { p_key: setting.key, p_value: parsed });
    if (updateError) setError(updateError.message); else await load('settings');
    setBusy(false);
  }

  const maintenance = Boolean((overview?.maintenance as { enabled?: boolean } | undefined)?.enabled);
  return <main className="admin-page">
    <header className="admin-top"><div><Link href="/admin" className="back-link"><ArrowLeft size={15} /> Admin dashboard</Link><span className="eyebrow">PLATFORM OPERATIONS</span><h1>Operations & system control</h1><p>Global data, analytics, support, security, webhooks, maintenance and platform settings.</p></div><button className="button button-light" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button></header>
    {error ? <div className="notice notice-error">{error}</div> : null}
    <nav className="admin-operations-tabs">{tabs.map(([key, label, Icon]) => <button key={key} className={`toggle ${tab === key ? 'on' : ''}`} onClick={() => setTab(key)}><Icon size={14} /> {label}</button>)}</nav>
    {tab === 'overview' ? <section className="surface-card"><div className="metric-grid admin-ops-metrics">{Object.entries(overview ?? {}).filter(([key]) => key !== 'maintenance').map(([key, value]) => <div className="metric-card" key={key}><span>{key.replaceAll('_', ' ')}</span><strong>{typeof value === 'number' && key.includes('revenue') ? money(value) : text(value)}</strong><small>Platform-wide</small></div>)}</div><div className={`admin-maintenance ${maintenance ? 'active' : ''}`}><div><strong>{maintenance ? 'Maintenance mode is ON' : 'Maintenance mode is OFF'}</strong><p>{maintenance ? 'Global maintenance messaging and policy controls are active.' : 'Turn this on before planned platform work.'}</p></div><button className={`toggle ${maintenance ? 'on' : ''}`} disabled={busy} onClick={() => void setMaintenance(!maintenance)}>{maintenance ? 'Disable maintenance' : 'Enable maintenance'}</button></div></section> : null}
    {tab !== 'overview' && tab !== 'settings' ? <DataSection tab={tab} rows={rows} /> : null}
    {tab === 'settings' ? <section className="surface-card"><div className="card-heading"><div><h2>System and content settings</h2><p>Edit JSON configuration used by the platform control center.</p></div><Settings size={18} /></div><div className="admin-settings-list">{settings.map(setting => <SettingRow key={String(setting.key)} setting={setting} busy={busy} onSave={saveSetting} />)}</div></section> : null}
  </main>;
}

function DataSection({ tab, rows }: { tab: Tab; rows: Row[] }) {
  const columns: Record<string, string[]> = {
    orders: ['organization_name', 'order_number', 'status', 'payment_status', 'payment_method', 'total', 'created_at'],
    payments: ['organization_name', 'provider', 'provider_payment_id', 'amount', 'status', 'method', 'created_at'],
    customers: ['name', 'email', 'phone', 'order_count', 'lifetime_value', 'created_at'],
    support: ['organization_name', 'type', 'status', 'note', 'created_at'],
    feedback: ['organization_name', 'source', 'category', 'subject', 'description', 'reporter_name', 'reporter_email', 'status', 'created_at'],
    security: ['action', 'entity_type', 'actor_user_id', 'created_at'],
    webhooks: ['organization_name', 'provider_event_id', 'event_type', 'status', 'amount', 'occurred_at'],
  };
  const labels = columns[tab] ?? [];
  return <section className="surface-card"><div className="card-heading"><div><h2>{tab[0].toUpperCase() + tab.slice(1)}</h2><p>Platform-wide records visible to Super Admin.</p></div>{tab === 'security' ? <AlertTriangle size={18} /> : <Activity size={18} />}</div><div className="data-table admin-ops-table"><div className="data-row data-head">{labels.map(label => <span key={label}>{label.replaceAll('_', ' ')}</span>)}</div>{rows.map((row, index) => <div className="data-row" key={String(row.id ?? index)}>{labels.map(label => <span key={label}>{label.includes('at') || label === 'created_at' ? date(row[label]) : label.includes('amount') || label === 'total' || label === 'lifetime_value' ? money(row[label]) : text(row[label])}</span>)}</div>)}{rows.length === 0 ? <div className="empty-wide">No records found.</div> : null}</div></section>;
}

function SettingRow({ setting, busy, onSave }: { setting: Row; busy: boolean; onSave: (setting: Row, value: string) => Promise<void> }) {
  const initial = JSON.stringify(setting.value ?? {}, null, 2);
  const [value, setValue] = useState(initial);
  return <div className="admin-setting-row"><div><strong>{text(setting.key)}</strong><p>{text(setting.description)}</p></div><textarea value={value} onChange={event => setValue(event.target.value)} rows={4} /><button className="button button-primary" disabled={busy} onClick={() => void onSave(setting, value)}>Save</button></div>;
}
