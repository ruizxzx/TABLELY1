'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, CircleAlert, RefreshCw, ShieldCheck } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type Flag = { key: string; label: string; description: string; enabled: boolean; maintenance_mode: boolean; updated_at: string };
type Health = Record<string, { status: string; checked_at: string }>;

export default function AdminControlPage() {
  const supabase = getSupabaseBrowserClient();
  const [flags, setFlags] = useState<Flag[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!supabase) { setError('Supabase is not configured.'); setLoading(false); return; }
    setError(null);
    const [{ data: flagData, error: flagError }, { data: healthData, error: healthError }] = await Promise.all([
      supabase.rpc('admin_list_feature_flags'),
      supabase.rpc('admin_platform_health'),
    ]);
    const firstError = flagError ?? healthError;
    if (firstError) setError(firstError.message);
    else { setFlags((flagData ?? []) as Flag[]); setHealth((healthData ?? null) as Health | null); }
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function updateFlag(flag: Flag, field: 'enabled' | 'maintenance_mode') {
    if (!supabase) return;
    setBusy(flag.key);
    setError(null);
    const next = !flag[field];
    const { data, error: updateError } = await supabase.rpc('admin_set_feature_flag', {
      p_key: flag.key,
      p_enabled: field === 'enabled' ? next : flag.enabled,
      p_maintenance_mode: field === 'maintenance_mode' ? next : flag.maintenance_mode,
    });
    if (updateError) setError(updateError.message);
    else setFlags(current => current.map(item => item.key === flag.key ? { ...item, ...(data as Flag) } : item));
    setBusy(null);
  }

  if (loading) return <main className="admin-page"><div className="setup-loading">Loading control center…</div></main>;
  return <main className="admin-page">
    <header className="admin-top">
      <div><Link href="/admin" className="back-link"><ArrowLeft size={15} /> Admin dashboard</Link><span className="eyebrow">SYSTEM CONTROL</span><h1>Control center</h1><p>Manage platform-wide availability without changing application code.</p></div>
      <button className="button button-light" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button>
    </header>
    {error ? <div className="notice notice-error">{error}</div> : null}
    <section className="surface-card">
      <div className="card-heading"><div><h2>System status</h2><p>Availability checks from the current platform configuration.</p></div><ShieldCheck size={18} /></div>
      <div className="metric-grid admin-health-grid">{Object.entries(health ?? {}).map(([key, value]) => <div className="metric-card" key={key}><div className="metric-head"><span>{key}</span>{value.status === 'HEALTHY' || value.status === 'CONFIGURED' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}</div><strong>{value.status.replaceAll('_', ' ')}</strong><small>Checked {new Date(value.checked_at).toLocaleTimeString()}</small></div>)}</div>
    </section>
    <section className="surface-card">
      <div className="card-heading"><div><h2>Global feature flags</h2><p>These controls apply across the platform. Plan entitlements remain an additional gate.</p></div></div>
      <div className="admin-feature-list">{flags.map(flag => <div className="admin-feature-row" key={flag.key}><div><strong>{flag.label}</strong><p>{flag.description}</p><small>{flag.key}</small></div><div className="button-row"><button className={`toggle ${flag.enabled ? 'on' : ''}`} disabled={busy === flag.key} onClick={() => void updateFlag(flag, 'enabled')}>{flag.enabled ? 'Enabled' : 'Disabled'}</button><button className={`toggle ${flag.maintenance_mode ? 'on' : ''}`} disabled={busy === flag.key} onClick={() => void updateFlag(flag, 'maintenance_mode')}>{flag.maintenance_mode ? 'Maintenance on' : 'Maintenance off'}</button></div></div>)}</div>
    </section>
  </main>;
}
