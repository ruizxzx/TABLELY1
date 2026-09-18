'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient, isSupabaseConfigured } from '@/lib/supabase';

export default function ResetPasswordPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next')?.startsWith('/') ? searchParams.get('next')! : '/dashboard';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const s = getSupabaseBrowserClient();
    if (!s || !isSupabaseConfigured()) {
      setError('Supabase is not configured.');
      return;
    }

    const { data: listener } = s.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (session && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        setReady(true);
        setError(null);
      }
    });

    void s.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      if (session) {
        setReady(true);
        setError(null);
      } else {
        setError('This password-reset link is invalid or has expired. Request a new link.');
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const s = getSupabaseBrowserClient();
    if (!s || !ready) return;
    setError(null);
    setMessage(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    const { error: updateError } = await s.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setMessage('Password updated. You can now sign in with the new password.');
    await s.auth.signOut();
    window.setTimeout(() => router.replace(next.startsWith('/customer') ? `/customer/login?next=${encodeURIComponent(next)}` : '/login'), 900);
  }

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="auth-brand"><Brand /></div>
        <div className="eyebrow">ACCOUNT RECOVERY</div>
        <h1>Set a new password.</h1>
        <p>Use this page only after opening the password-reset link sent to your staff login email.</p>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        {message ? <div className="notice notice-info" role="status">{message}</div> : null}
        <form className="auth-form" onSubmit={submit}>
          <label>New password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" required /></label>
          <label>Confirm password<input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" autoComplete="new-password" required /></label>
          <button className="button button-primary button-full" type="submit" disabled={busy || !ready}>{busy ? 'Updating…' : 'Update password'}</button>
        </form>
      </div>
    </main>
  );
}
