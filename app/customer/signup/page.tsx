'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Chrome } from 'lucide-react';
import { Suspense, useState, type FormEvent } from 'react';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '@/lib/supabase';

function CustomerSignupForm() {
  const search = useSearchParams();
  const next = search.get('next')?.startsWith('/') ? search.get('next')! : '/customer/account';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function google() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true); setError(null);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (oauthError) { setBusy(false); setError(oauthError.message); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!isSupabaseConfigured()) { setError('Supabase is not configured.'); return; }
    if (password.length < 8) { setError('Use a password with at least 8 characters.'); return; }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(),
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    setBusy(false);
    if (signUpError) { setError(signUpError.message); return; }
    if (data.session) {
      window.location.assign(next);
      return;
    }
    setMessage('Account created. If email confirmation is enabled, open the link sent to your email, then sign in.');
  }

  return <main className="auth-page"><div className="auth-panel"><Link href="/" className="back-link">Back to site</Link><div className="eyebrow">TABLELY CUSTOMER</div><h1>Create your account.</h1><p>Use email and password or continue with Google. No OTP is used for account creation.</p>{error ? <div className="notice notice-error" role="alert">{error}</div> : null}{message ? <div className="notice notice-success" role="status">{message}</div> : null}<form className="auth-form" onSubmit={submit}><label>Email<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required /></label><label>Password<input type="password" autoComplete="new-password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 8 characters" required /></label><button className="button button-primary button-full" type="submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button><div className="auth-divider"><span>or</span></div><button className="button button-google button-full" type="button" onClick={()=>void google()} disabled={busy}><Chrome size={16}/> Continue with Google</button></form><p className="auth-foot">Already registered? <Link href={`/customer/login?next=${encodeURIComponent(next)}`}>Sign in</Link></p></div></main>;
}

export default function CustomerSignupPage() {
  return <Suspense fallback={<main className="auth-page"><div className="auth-panel">Loading…</div></main>}><CustomerSignupForm /></Suspense>;
}
