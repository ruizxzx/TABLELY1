'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type Restaurant = { id: string; name: string; slug: string; status: string; plan_id: string; subscription_status: string };
const controls = [{ key: 'RESTAURANT_ORDERING', label: 'Ordering' }, { key: 'ONLINE_PAYMENTS', label: 'Online payments' }, { key: 'PAY_AFTER_DELIVERY', label: 'Pay after delivery' }, { key: 'REVIEWS', label: 'Reviews' }];

export default function AdminRestaurantsPage() {
  const supabase = getSupabaseBrowserClient();
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.rpc('admin_list_organizations');
    if (loadError) setError(loadError.message); else setRestaurants((data ?? []) as Restaurant[]);
  }
  useEffect(() => { void load(); }, []);
  async function setOverride(orgId: string, key: string, enabled: boolean | null) {
    if (!supabase) return;
    setBusy(`${orgId}:${key}`);
    const { error: updateError } = await supabase.rpc('admin_set_organization_feature_override', { p_organization_id: orgId, p_feature_key: key, p_enabled: enabled, p_maintenance_mode: false });
    if (updateError) setError(updateError.message);
    setBusy(null);
  }
  return <main className="admin-page">
    <header className="admin-top"><div><Link href="/admin" className="back-link"><ArrowLeft size={15} /> Admin dashboard</Link><span className="eyebrow">RESTAURANTS</span><h1>Restaurant controls</h1><p>Apply targeted availability overrides without changing the restaurant’s plan.</p></div><button className="button button-light" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button></header>
    {error ? <div className="notice notice-error">{error}</div> : null}
    <section className="surface-card admin-restaurant-list">{restaurants.map(restaurant => <div className="admin-restaurant-row" key={restaurant.id}><div><strong>{restaurant.name}</strong><p>{restaurant.slug} · {restaurant.plan_id} · {restaurant.status}</p></div><div className="button-row">{controls.map(control => <span className="button-row" key={control.key}><button className="button button-light" disabled={busy === `${restaurant.id}:${control.key}`} onClick={() => void setOverride(restaurant.id, control.key, false)}>{control.label} off</button><button className="button button-light" disabled={busy === `${restaurant.id}:${control.key}`} onClick={() => void setOverride(restaurant.id, control.key, null)}>Inherit</button></span>)}</div></div>)}</section>
  </main>;
}
