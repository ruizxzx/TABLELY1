'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Loader2, Mail } from 'lucide-react';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '@/lib/supabase';

export default function PartnerLoginPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    if (code === 'missing_auth_code') setError('That sign-in link is incomplete. Request a new partner sign-in email.');
    else if (code === 'supabase_not_configured') setError('Supabase is not configured.');
    else if (code === 'auth_callback_failed') setError('That sign-in link has expired or was already used. Request a new one.');
  }, []);

  async function sendSignInLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    setError('');
    if (!isSupabaseConfigured()) {
      setError('Supabase is not configured.');
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setError('Supabase is not configured.');
      return;
    }
    setBusy(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/partners/dashboard')}`,
        },
      });
      if (signInError) throw signInError;
      setMessage('If a TABLELY account exists for that email, a secure partner sign-in link has been sent.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send the partner sign-in email.');
    } finally {
      setBusy(false);
    }
  }

  async function sendRecoveryLink() {
    setMessage('');
    setError('');
    if (!email.trim()) {
      setError('Enter your account email first.');
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !isSupabaseConfigured()) {
      setError('Supabase is not configured.');
      return;
    }
    setBusy(true);
    try {
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/reset-password?next=${encodeURIComponent('/partners/dashboard')}`,
      });
      if (recoveryError) throw recoveryError;
      setMessage('If that email belongs to a TABLELY account, a password recovery link has been sent.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send the recovery email.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="auth-brand"><Brand /></div>
        <Link href="/partners" className="back-link"><ArrowLeft size={15} /> Partner network</Link>
        <div className="eyebrow">PARTNER PORTAL</div>
        <h1>Partner sign in.</h1>
        <p>Access your referrals, commission ledger, and payout details with a secure link sent to your email.</p>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        {message ? <div className="notice notice-info" role="status">{message}</div> : null}
        <form className="auth-form" onSubmit={sendSignInLink}>
          <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" placeholder="you@example.com" required /></label>
          <button className="button button-primary button-full" type="submit" disabled={busy}>
            {busy ? <><Loader2 size={16} className="spin" /> Sending…</> : <><Mail size={16} /> Email me a sign-in link</>}
          </button>
        </form>
        <button className="text-button" type="button" onClick={() => void sendRecoveryLink()} disabled={busy}>Forgot password?</button>
        <p className="auth-foot">Not a partner yet? <Link href="/partners#partner-apply">Apply to join</Link></p>
        <p className="auth-foot">Restaurant account? <Link href="/login">Restaurant sign in</Link></p>
      </div>
    </main>
  );
}
