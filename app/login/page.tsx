'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Loader2, Chrome } from 'lucide-react';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '@/lib/supabase';

export default function LoginPage() {
  return <Suspense fallback={<main className="auth-page"><div className="auth-panel"><div className="setup-loading">Loading…</div></div></main>}><LoginPageContent /></Suspense>;
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/dashboard';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showForgot, setShowForgot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash) {
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const desc = hashParams.get('error_description');
      const code = hashParams.get('error_code');
      if (desc) {
        setError(desc.replaceAll('+', ' ') + '. Please sign in with your email and password, or request a fresh link.');
        return;
      }
      if (code) {
        setError(`Authentication error (${code}). Please sign in with your email and password.`);
        return;
      }
    }

    const paramError = searchParams.get('error');
    if (paramError === 'missing_auth_code') {
      setError('The sign-in link is invalid or has expired. Please sign in below, or use Forgot password to get a fresh link.');
    } else if (paramError === 'auth_callback_failed') {
      setError('Authentication failed or the link has expired. Please sign in below.');
    } else if (paramError === 'supabase_not_configured') {
      setError('Supabase is not configured. Add the required environment variables first.');
    } else if (paramError) {
      setError(`Sign-in notice: ${paramError.replaceAll('_', ' ')}`);
    }
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    async function redirectExistingSession() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      const { data: staff } = await supabase.from('staff').select('id, role, can_kitchen, can_waiter').eq('user_id', user.id).limit(1).maybeSingle();
      if (cancelled) return;
      if (!staff) { router.replace('/onboarding'); return; }
      const role = String((staff as { role?: unknown }).role ?? 'OWNER');
      const kitchen = Boolean((staff as { can_kitchen?: unknown }).can_kitchen);
      const waiter = Boolean((staff as { can_waiter?: unknown }).can_waiter);
      router.replace(role === 'KITCHEN' && kitchen && !waiter ? '/kitchen' : role === 'WAITER' && waiter && !kitchen ? '/service-requests' : kitchen && !waiter ? '/kitchen' : waiter && !kitchen ? '/service-requests' : '/dashboard');
    }
    void redirectExistingSession();
    return () => { cancelled = true; };
  }, [router]);

  async function signInWithGoogle() {
    setError(null);
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured. Add the required environment variables first.');
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    if (oauthError) {
      setBusy(false);
      setError(oauthError.message);
    }
  }

  async function forgotPassword() {
    setError(null);
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured.');
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    if (!email.trim()) {
      setError('Enter your staff login email first.');
      return;
    }
    setBusy(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    setBusy(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    setError('If that email belongs to a Tablely staff account, a password reset link has been sent.');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to .env.local.');
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

    // Staff invitation deep links must be preserved so the invited account can
    // claim its staff role instead of being redirected to the restaurant owner's home.
    if (next.startsWith('/join-staff/')) {
      setBusy(false);
      router.replace(next);
      router.refresh();
      return;
    }

    // A return path is honored for protected deep links, but plain login
    // should resolve the user's actual workspace instead of always sending
    // existing users through one-time onboarding.
    if (next.startsWith('/') && next !== '/onboarding' && next !== '/login' && next !== '/signup') {
      setBusy(false);
      router.replace(next);
      router.refresh();
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      setError('Signed in, but the session could not be loaded. Please try again.');
      return;
    }

    const { data: staff, error: staffError } = await supabase
      .from('staff')
      .select('id, role, can_kitchen, can_waiter')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle();

    setBusy(false);
    if (staffError) {
      setError(staffError.message);
      return;
    }

    if (!staff) {
      router.replace('/onboarding');
    } else {
      const role = String((staff as { role?: unknown }).role ?? 'OWNER');
      const kitchen = Boolean((staff as { can_kitchen?: unknown }).can_kitchen);
      const waiter = Boolean((staff as { can_waiter?: unknown }).can_waiter);
      router.replace(role === 'KITCHEN' && kitchen && !waiter ? '/kitchen' : role === 'WAITER' && waiter && !kitchen ? '/service-requests' : kitchen && !waiter ? '/kitchen' : waiter && !kitchen ? '/service-requests' : '/dashboard');
    }
    router.refresh();
  }

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="auth-brand"><Brand /></div>
        <Link href="/" className="back-link"><ArrowLeft size={15} /> Back to site</Link>
        <div className="eyebrow">RESTAURANT STUDIO</div>
        <h1>Welcome back.</h1>
        <p>Sign in to manage your restaurant.</p>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        <form className="auth-form" onSubmit={submit}>
          <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} name="email" type="email" autoComplete="email" placeholder="owner@restaurant.com" required /></label>
          <div className="auth-forgot-row"><label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} name="password" type="password" autoComplete="current-password" placeholder="••••••••" required /></label><button type="button" className="text-button" onClick={()=>setShowForgot(v=>!v)}>Forgot password?</button></div>
          {showForgot?<div className="notice notice-info"><p>Enter your login email above, then click below.</p><button type="button" className="button button-light button-full" onClick={()=>void forgotPassword()} disabled={busy}>Send reset link</button></div>:null}
          <button className="button button-primary button-full" type="submit" disabled={busy}>{busy ? <><Loader2 size={16} className="spin" /> Signing in…</> : 'Sign in'}</button>
          <div className="auth-divider"><span>or</span></div>
          <button className="button button-google button-full" type="button" onClick={() => void signInWithGoogle()} disabled={busy}><Chrome size={16}/> Continue with Google</button>
        </form>
        <p className="auth-foot">New to Tablely? <Link href="/signup">Create a restaurant</Link></p>
      </div>
    </main>
  );
}
