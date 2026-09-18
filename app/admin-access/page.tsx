'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Loader2, ShieldAlert } from 'lucide-react';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '@/lib/supabase';

export default function AdminAccessPage() {
  return (
    <Suspense fallback={<main className="auth-page"><div className="auth-panel"><div className="setup-loading">Loading…</div></div></main>}>
      <AdminAccessPageContent />
    </Suspense>
  );
}

function AdminAccessPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/admin';
  const denied = searchParams.get('denied') === '1';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(denied ? 'That account does not have Super Admin access.' : null);
  const [busy, setBusy] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  // If an already-authenticated platform admin lands here directly, skip
  // straight through instead of asking them to sign in again.
  useEffect(() => {
    let cancelled = false;
    async function redirectExistingAdmin() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) { setCheckingSession(false); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) { setCheckingSession(false); return; }
      const { data: isAdmin } = await supabase.rpc('is_platform_admin');
      if (cancelled) return;
      if (isAdmin) {
        router.replace(next.startsWith('/admin') ? next : '/admin');
        return;
      }
      setCheckingSession(false);
    }
    void redirectExistingAdmin();
    return () => { cancelled = true; };
  }, [next, router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured. Add the required environment variables first.');
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setBusy(false);
      setError(signInError.message);
      return;
    }

    const { data: isAdmin, error: adminCheckError } = await supabase.rpc('is_platform_admin');
    if (adminCheckError) {
      setBusy(false);
      setError(adminCheckError.message);
      await supabase.auth.signOut();
      return;
    }
    if (!isAdmin) {
      setBusy(false);
      setError('That account does not have Super Admin access.');
      // Do not leave a signed-in, non-admin session sitting on this page.
      await supabase.auth.signOut();
      return;
    }

    setBusy(false);
    router.replace(next.startsWith('/admin') ? next : '/admin');
    router.refresh();
  }

  if (checkingSession) {
    return <main className="auth-page"><div className="auth-panel"><div className="setup-loading">Loading…</div></div></main>;
  }

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="auth-brand"><Brand /></div>
        <Link href="/" className="back-link"><ArrowLeft size={15} /> Back to site</Link>
        <div className="eyebrow">SUPER ADMIN</div>
        <h1>Platform access.</h1>
        <p>Restricted to Tablely platform administrators.</p>
        {error ? <div className="notice notice-error" role="alert"><ShieldAlert size={15} /> {error}</div> : null}
        <form className="auth-form" onSubmit={submit}>
          <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} name="email" type="email" autoComplete="email" placeholder="admin@tablely.app" required /></label>
          <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} name="password" type="password" autoComplete="current-password" placeholder="••••••••" required /></label>
          <button className="button button-primary button-full" type="submit" disabled={busy}>{busy ? <><Loader2 size={16} className="spin" /> Verifying…</> : 'Sign in'}</button>
        </form>
      </div>
    </main>
  );
}
