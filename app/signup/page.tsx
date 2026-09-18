'use client';

import Link from 'next/link';
import { ArrowLeft, Check, Loader2, Chrome } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient, getSupabaseConfigurationError } from '@/lib/supabase';

export default function SignupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ restaurant: '', owner: '', email: '', phone: '', address: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function signInWithGoogle() {
    setError(null);
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setError('Supabase is not configured.'); return; }
    setBusy(true);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/onboarding` },
    });
    if (oauthError) { setBusy(false); setError(oauthError.message); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    const configurationError = getSupabaseConfigurationError();
    if (configurationError) {
      setError(configurationError);
      return;
    }
    if (form.password.length < 8) {
      setError('Use a password with at least 8 characters.');
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setBusy(true);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        data: {
          full_name: form.owner.trim(),
          phone: form.phone.trim(),
          restaurant_name: form.restaurant.trim(),
          restaurant_address: form.address.trim(),
        },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/onboarding`,
      },
    });
    setBusy(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    if (data.session) {
      router.push('/onboarding');
      router.refresh();
      return;
    }

    setMessage('Account created. Check your email to confirm the account, then sign in to finish restaurant setup.');
  }

  return (
    <main className="auth-page auth-page-split">
      <div className="auth-visual">
        <Brand light />
        <div className="auth-visual-copy">
          <div className="eyebrow">BUILD 2 · REAL AUTHENTICATION</div>
          <h1>Create the operating base for your restaurant.</h1>
          <p>Your account is secured by Supabase Auth. Restaurant setup is completed after authentication so the organization and branch are created server-side through a protected database function.</p>
          <div className="hero-points"><span><Check size={15} /> Tenant-isolated data</span><span><Check size={15} /> Owner role from day one</span></div>
        </div>
      </div>
      <div className="auth-panel auth-panel-right">
        <Link href="/" className="back-link"><ArrowLeft size={15} /> Back to site</Link>
        <div className="eyebrow">GET STARTED</div>
        <h1>Create your restaurant.</h1>
        <p>Use a real email and a strong password. We will create the organization after authentication.</p>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        {message ? <div className="notice notice-success" role="status">{message}</div> : null}
        <form className="auth-form" onSubmit={submit}>
          <label>Restaurant name<input name="restaurant" value={form.restaurant} onChange={(e) => update('restaurant', e.target.value)} placeholder="Spice Route" required /></label>
          <label>Owner name<input name="owner" value={form.owner} onChange={(e) => update('owner', e.target.value)} autoComplete="name" placeholder="Your name" required /></label>
          <label>Email<input name="email" value={form.email} onChange={(e) => update('email', e.target.value)} type="email" autoComplete="email" placeholder="owner@restaurant.com" required /></label>
          <label>Phone<input name="phone" value={form.phone} onChange={(e) => update('phone', e.target.value)} inputMode="tel" autoComplete="tel" placeholder="+91 98xxxxxx10" required /></label>
          <label>Address<textarea name="address" value={form.address} onChange={(e) => update('address', e.target.value)} placeholder="Restaurant address" rows={3} required /></label>
          <label>Password<input name="password" value={form.password} onChange={(e) => update('password', e.target.value)} type="password" autoComplete="new-password" minLength={8} placeholder="At least 8 characters" required /></label>
          <button className="button button-primary button-full" type="submit" disabled={busy}>{busy ? <><Loader2 size={16} className="spin" /> Creating account…</> : 'Create account'}</button>
          <div className="auth-divider"><span>or</span></div>
          <button className="button button-google button-full" type="button" onClick={() => void signInWithGoogle()} disabled={busy}><Chrome size={16}/> Continue with Google</button>
        </form>
        <p className="auth-foot">Already have an account? <Link href="/login">Sign in</Link></p>
      </div>
    </main>
  );
}
