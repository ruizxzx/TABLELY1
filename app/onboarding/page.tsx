'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, LogOut, MapPin, Store } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient } from '@/lib/supabase';

export default function OnboardingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ restaurant: '', address: '', phone: '' });

  useEffect(() => {
    async function load() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        setError('Supabase is not configured. Add the required environment variables first.');
        setLoading(false);
        return;
      }

      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        router.replace('/login');
        return;
      }

      // Returning users who already have an owner/staff record should never
      // be sent through the one-time onboarding form again. The staff lookup is
      // intentionally used instead of querying organizations directly so the
      // check stays scoped to the authenticated user.
      const { data: existingStaff, error: staffError } = await supabase
        .from('staff')
        .select('id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle();

      if (staffError) {
        setError(staffError.message);
        setLoading(false);
        return;
      }

      if (existingStaff) {
        router.replace('/dashboard');
        return;
      }

      setForm({
        restaurant: String(user.user_metadata?.restaurant_name ?? ''),
        address: String(user.user_metadata?.restaurant_address ?? ''),
        phone: String(user.user_metadata?.phone ?? ''),
      });
      setLoading(false);
    }
    void load();
  }, [router]);

  async function finish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    if (!form.restaurant.trim() || !form.address.trim()) {
      setError('Restaurant name and address are required.');
      return;
    }

    setBusy(true);
    const { error: rpcError } = await supabase.rpc('create_restaurant_for_current_user', {
      p_name: form.restaurant.trim(),
      p_address: form.address.trim(),
      p_phone: form.phone.trim() || null,
    });
    setBusy(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    router.replace('/dashboard');
    router.refresh();
  }

  async function signOut() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) {
      setError(signOutError.message);
      setBusy(false);
      return;
    }
    router.replace('/login');
    router.refresh();
  }

  if (loading) {
    return <main className="auth-page"><div className="setup-loading"><Loader2 size={22} className="spin" /> Loading restaurant setup…</div></main>;
  }

  return (
    <main className="auth-page">
      <div className="auth-panel auth-panel-wide">
        <Brand />
        <div className="eyebrow">ONE-TIME SETUP</div>
        <h1>Your restaurant workspace.</h1>
        <p>Confirm the restaurant details that will be used to create your organization, main branch and owner staff record.</p>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        <form className="auth-form onboarding-form" onSubmit={finish}>
          <label><span><Store size={14} /> Restaurant name</span><input value={form.restaurant} onChange={(e) => setForm((v) => ({ ...v, restaurant: e.target.value }))} required /></label>
          <label><span><MapPin size={14} /> Address</span><textarea value={form.address} onChange={(e) => setForm((v) => ({ ...v, address: e.target.value }))} rows={4} required /></label>
          <label>Phone<input value={form.phone} onChange={(e) => setForm((v) => ({ ...v, phone: e.target.value }))} inputMode="tel" /></label>
          <button className="button button-primary button-full" disabled={busy}>{busy ? <><Loader2 size={16} className="spin" /> Creating workspace…</> : 'Create restaurant workspace'}</button>
        </form>
        <button className="button button-light button-full" type="button" onClick={() => void signOut()} disabled={busy}><LogOut size={16} /> Sign out</button>
      </div>
    </main>
  );
}
