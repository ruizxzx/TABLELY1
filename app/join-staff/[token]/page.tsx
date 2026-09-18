'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, LogOut } from 'lucide-react';
import { Brand } from '@/components/Brand';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import type { StaffRole } from '@/lib/restaurant-context';

function roleHome(role: StaffRole, canKitchen: boolean, canWaiter: boolean) {
  if (canKitchen && !canWaiter) return '/kitchen';
  if (canWaiter && !canKitchen) return '/service-requests';
  if (role === 'KITCHEN') return '/kitchen';
  if (role === 'WAITER') return '/service-requests';
  return '/dashboard';
}

export default function JoinStaffPage({ params }: { params: Promise<{ token: string }> }) {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [sessionUser, setSessionUser] = useState<{ id: string; email: string } | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void params.then((value) => setToken(value.token)); }, [params]);

  useEffect(() => {
    const s = getSupabaseBrowserClient();
    if (!s) return;
    void s.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setSessionUser({ id: user.id, email: user.email ?? "" });
        setEmail(user.email ?? "");
      }
    });
  }, []);

  async function signOutCurrentAccount() {
    const s = getSupabaseBrowserClient();
    if (!s) return;
    setBusy(true);
    setError(null);
    const { error: e } = await s.auth.signOut();
    setBusy(false);
    if (e) { setError(e.message); return; }
    setSessionUser(null);
    setEmail('');
    setPassword('');
    setMessage('Current account signed out. Enter the staff member’s email to continue.');
  }

  async function claim() {
    const s = getSupabaseBrowserClient();
    if (!s || !token) return;
    setBusy(true);
    setError(null);
    const { data, error: e } = await s.rpc('claim_staff_invitation', { p_token: token, p_display_name: displayName });
    setBusy(false);
    if (e) { setError(e.message); return; }
    const row = Array.isArray(data) ? data[0] : data;
    const role = row && typeof row === 'object' && 'role' in row ? String((row as { role: unknown }).role) as StaffRole : 'MANAGER';
    const canKitchen = Boolean(row && typeof row === 'object' && 'can_kitchen' in row && (row as { can_kitchen?: unknown }).can_kitchen);
    const canWaiter = Boolean(row && typeof row === 'object' && 'can_waiter' in row && (row as { can_waiter?: unknown }).can_waiter);
    router.replace(roleHome(role, canKitchen, canWaiter));
    router.refresh();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const s = getSupabaseBrowserClient();
    if (!s) return;
    setBusy(true); setError(null); setMessage(null);
    if (sessionUser) {
      setBusy(false);
      setError('A different Tablely account is already signed in. Sign out that account first, then sign in or create the invited staff account.');
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) { setBusy(false); setError('Enter the invited staff email address.'); return; }
    if (password.length < 8) { setBusy(false); setError('Use a password with at least 8 characters.'); return; }
    const { data, error: e } = await s.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: { full_name: displayName.trim() },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/join-staff/${encodeURIComponent(token)}`,
      },
    });
    if (e) {
      setBusy(false);
      setError(/rate limit exceeded/i.test(e.message)
        ? 'Supabase has temporarily limited confirmation emails. Wait before retrying, or use “Sign in with that account” if this staff account already exists.'
        : e.message);
      return;
    }
    if (!data.session) {
      setBusy(false);
      setMessage('Account created. Confirm the email if required, then open this invitation link again or sign in with the invited staff account.');
      return;
    }
    await claim();
  }

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="auth-brand"><Brand /></div>
        <div className="eyebrow">STAFF INVITATION</div>
        <h1>Join your restaurant team.</h1>
        <p>This invitation creates a separate staff login. Your restaurant-owner login is never reused for a staff role.</p>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
        {message ? <div className="notice notice-success" role="status">{message}</div> : null}

        {sessionUser ? (
          <div className="surface-card" style={{ marginBottom: 16 }}>
            <div className="setup-note"><Check size={15}/> Currently signed in as <strong>{sessionUser.email || sessionUser.id.slice(0, 8)}</strong></div>
            <p className="muted-small" style={{ margin: '10px 0 14px' }}>This is your existing account. Staff invitations must be claimed by the invited staff account, not by the owner account.</p>
            <button type="button" className="button button-light button-full" disabled={busy} onClick={() => void signOutCurrentAccount()}>
              {busy ? <Loader2 size={16} className="spin"/> : <LogOut size={16}/>}
              Sign out and switch account
            </button>
          </div>
        ) : (
          <>
            <form className="auth-form" onSubmit={submit}>
              <label>Name<input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Staff name" required /></label>
              <label>Email<input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" placeholder="staff@example.com" required /></label>
              <label>Password<input type="password" value={password} onChange={e=>setPassword(e.target.value)} minLength={8} autoComplete="new-password" placeholder="At least 8 characters" required /></label>
              <button className="button button-primary button-full" disabled={busy||!token}>{busy?<><Loader2 size={16} className="spin"/> Joining…</>:'Create / join staff account'}</button>
            </form>
            <p className="auth-foot">Already have a staff account? <a href={`/login?next=/join-staff/${encodeURIComponent(token)}`}>Sign in with that account</a></p>
          </>
        )}
      </div>
    </main>
  );
}
