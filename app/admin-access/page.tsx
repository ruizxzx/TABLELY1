'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Loader2, ShieldAlert } from 'lucide-react';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '@/lib/supabase';

function getRequestError(reason: unknown) {
  if (reason instanceof TypeError && reason.message.toLowerCase().includes('fetch')) {
    return 'Could not reach Supabase. Check your internet connection and the Supabase project URL/status, then try again.';
  }
  return reason instanceof Error ? reason.message : 'Could not complete the sign-in request.';
}

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
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (cancelled) return;
        if (!session?.user) { setCheckingSession(false); return; }
        const { data: isAdmin, error: adminError } = await supabase.rpc('is_platform_admin');
        if (adminError) throw adminError;
        if (cancelled) return;
        if (isAdmin) {
          router.replace(next.startsWith('/admin') ? next : '/admin');
          return;
        }
        setCheckingSession(false);
      } catch (reason) {
        if (!cancelled) {
          setError(getRequestError(reason));
          setCheckingSession(false);
        }
      }
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
    let signedIn = false;
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        return;
      }
      signedIn = true;

      const { data: isAdmin, error: adminCheckError } = await supabase.rpc('is_platform_admin');
      if (adminCheckError) {
        setError(adminCheckError.message);
        await supabase.auth.signOut();
        return;
      }
      if (!isAdmin) {
        setError('That account does not have Super Admin access.');
        // Do not leave a signed-in, non-admin session sitting on this page.
        await supabase.auth.signOut();
        return;
      }

      router.replace(next.startsWith('/admin') ? next : '/admin');
      router.refresh();
    } catch (reason) {
      const requestError = getRequestError(reason);
      setError(requestError);
      if (signedIn) {
        try {
          const { error: signOutError } = await supabase.auth.signOut();
          if (signOutError) setError(`${requestError} The temporary session could not be cleared; reload this page before continuing.`);
        } catch {
          setError(`${requestError} The temporary session could not be cleared; reload this page before continuing.`);
        }
      }
    } finally {
      setBusy(false);
    }
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
