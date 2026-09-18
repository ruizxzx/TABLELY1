'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Chrome } from 'lucide-react';
import { Suspense, useState, type FormEvent } from 'react';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '@/lib/supabase';

function CustomerLoginForm() {
  const search = useSearchParams();
  const next = search.get('next')?.startsWith('/') ? search.get('next')! : '/customer/account';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showForgot, setShowForgot] = useState(false);
  const [error, setError] = useState<string | null>(search.get('detail') ?? null);
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
    setError(null); setMessage(null);
    if (!isSupabaseConfigured()) { setError('Supabase is not configured.'); return; }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    if (signInError) { setError(signInError.message); return; }
    window.location.assign(next);
  }

  async function forgotPassword() {
    setError(null); setMessage(null);
    if (!isSupabaseConfigured()) { setError('Supabase is not configured.'); return; }
    if (!email.trim()) { setError('Enter your email first.'); return; }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${window.location.origin}/auth/reset-password?next=${encodeURIComponent(next)}` });
    setBusy(false);
    if (resetError) { setError(resetError.message); return; }
    setMessage('If that email belongs to a Tablely customer account, a password reset link has been sent.');
  }

  return <main className="auth-page"><div className="auth-panel"><Link href="/" className="back-link">Back to site</Link><div className="eyebrow">TABLELY CUSTOMER</div><h1>Welcome back.</h1><p>Sign in with email and password or continue with Google. No OTP is used.</p>{error ? <div className="notice notice-error" role="alert">{error}</div> : null}{message ? <div className="notice notice-info" role="status">{message}</div> : null}<form className="auth-form" onSubmit={submit}><label>Email<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Your password" required /></label><button className="button button-primary button-full" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button><div className="auth-divider"><span>or</span></div><button className="button button-google button-full" type="button" onClick={()=>void google()} disabled={busy}><Chrome size={16}/> Continue with Google</button></form><button className="auth-text-button" type="button" onClick={()=>setShowForgot(v=>!v)}>{showForgot ? 'Hide password recovery' : 'Forgot password?'}</button>{showForgot ? <div className="auth-recovery"><label>Email for reset<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" /></label><button className="button button-light button-full" type="button" onClick={()=>void forgotPassword()} disabled={busy}>Send password reset link</button></div> : null}<p className="auth-foot">New to Tablely? <Link href={`/customer/signup?next=${encodeURIComponent(next)}`}>Create an account</Link></p></div></main>;
}

export default function CustomerLoginPage() {
  return <Suspense fallback={<main className="auth-page"><div className="auth-panel">Loading…</div></main>}><CustomerLoginForm /></Suspense>;
}
