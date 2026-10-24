'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import Logo from '../../components/Logo';
import { supabase } from '../../lib/supabase';
import { getClientAppBaseUrl } from '../../lib/site';

function AdminLoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/admin';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!supabase) {
        if (active) setCheckingSession(false);
        return;
      }
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (active && session) {
          router.replace(next);
          return;
        }
      } catch {
        // Safe fallback: show login form if session lookup fails.
      } finally {
        if (active) setCheckingSession(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [next, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage('');
    if (!supabase) {
      setMessage('Supabase is not configured. Add your environment variables and restart the app.');
      return;
    }
    if (!email.trim() || !password.trim()) {
      setMessage('Enter both your email and password.');
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (error) throw error;
      router.push(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Admin sign-in failed.');
    } finally {
      setLoading(false);
    }
  }

  async function continueWithGoogle() {
    setMessage('');
    if (!supabase) {
      setMessage('Supabase is not configured. Add your environment variables and restart the app.');
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${getClientAppBaseUrl()}/auth/callback?next=${encodeURIComponent(next)}` },
      });
      if (error) throw error;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Google admin sign-in failed.');
      setLoading(false);
    }
  }

  if (checkingSession) {
    return (
      <main className="auth-shell">
        <div className="auth-form-wrap">
          <div className="form-card">
            <h2>Checking access…</h2>
            <p className="muted">Loading your admin session.</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <div className="auth-side">
        <Logo light />
        <div>
          <span className="pill">Admin access</span>
          <h1>Secure admin sign in.</h1>
          <p>Use your approved TABLELY administrator account to manage creators, content, and platform operations.</p>
        </div>
        <span style={{ color: '#777789', fontSize: 12 }}>TABLELY • Restricted admin console</span>
      </div>

      <div className="auth-form-wrap">
        <form className="form-card" onSubmit={submit}>
          <Link href="/" className="muted" style={{ fontSize: 12 }}>← Back to TABLELY</Link>
          <h2 style={{ marginTop: 18 }}>Admin login</h2>
          <p className="muted">Only authorised admin accounts can access this area.</p>

          <button type="button" className="btn" style={{ width: '100%', marginTop: 16 }} onClick={() => void continueWithGoogle()} disabled={loading}>Continue with Google</button>

          <label className="label">Email</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@example.com"
            autoComplete="email"
            required
          />

          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />

          <div className="form-actions">
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={loading}>
              {loading ? 'Signing in…' : 'Continue to admin →'}
            </button>
          </div>

          {message && (
            <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 12 }}>{message}</p>
          )}
        </form>
      </div>
    </main>
  );
}

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<main className="auth-shell"><div className="auth-form-wrap"><div className="form-card"><h2>Loading…</h2></div></div></main>}>
      <AdminLoginPageInner />
    </Suspense>
  );
}
