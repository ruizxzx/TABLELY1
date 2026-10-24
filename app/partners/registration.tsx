'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

type Form = {
  fullName: string;
  email: string;
  city: string;
  state: string;
  category: string;
  company: string;
  website: string;
  source: string;
  address: string;
  agreement: boolean;
};

const empty: Form = {
  fullName: '',
  email: '',
  city: '',
  state: '',
  category: 'FREELANCER',
  company: '',
  website: '',
  source: '',
  address: '',
  agreement: false,
};
const draftKey = 'tablely-partner-application';

async function submitApplication(form: Form) {
  const response = await fetch('/api/partners/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(form),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Could not submit partner application.');
  localStorage.removeItem(draftKey);
  return body.partner?.code as string | undefined;
}

export default function PartnerRegistration() {
  const supabase = getSupabaseBrowserClient();
  const [form, setForm] = useState<Form>(empty);
  const [emailOtp, setEmailOtp] = useState('');
  const [stage, setStage] = useState<'details' | 'email' | 'done'>('details');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) setForm((current) => ({ ...current, ...JSON.parse(saved) as Partial<Form> }));
    } catch {
      localStorage.removeItem(draftKey);
    }
    if (supabase) {
      void supabase.auth.getSession().then(({ data, error: sessionError }) => {
        if (sessionError) {
          setError(sessionError.message);
          return;
        }
        const email = data.session?.user.email?.trim().toLowerCase() ?? '';
        if (email) {
          setAuthenticated(true);
          setAccountEmail(email);
          setForm((current) => ({ ...current, email }));
        }
      });
    }
  }, [supabase]);

  function change(key: keyof Form, value: string | boolean) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function sendEmailCode(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (!supabase) {
      setError('Supabase is not configured.');
      return;
    }
    if (!form.agreement) {
      setError('Accept the partner agreement to continue.');
      return;
    }
    setBusy(true);
    try {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (session) {
        const sessionEmail = session.user.email?.trim().toLowerCase();
        if (sessionEmail !== form.email.trim().toLowerCase()) {
          throw new Error(`You are signed in as ${sessionEmail || 'another account'}. Sign out before applying with a different email.`);
        }
        const code = await submitApplication(form);
        setStage('done');
        setMessage(`Application submitted${code ? ` with partner code ${code}` : ''}. You can start sharing after TABLELY approves your account.`);
        return;
      }

      localStorage.setItem(draftKey, JSON.stringify(form));
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: form.email.trim(),
        options: {
          shouldCreateUser: true,
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent('/partners/complete')}`,
          data: { full_name: form.fullName.trim() },
        },
      });
      if (otpError) throw otpError;
      setStage('email');
      setMessage('We emailed you a sign-in link and verification code. Open the link or enter the code here to submit your application.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not send the partner verification email.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyEmail(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (!supabase) throw new Error('Supabase is not configured.');
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: form.email.trim(),
        token: emailOtp.trim(),
        type: 'email',
      });
      if (verifyError) throw verifyError;
      const code = await submitApplication(form);
      setStage('done');
      setMessage(`Application submitted${code ? ` with partner code ${code}` : ''}. You can start sharing after TABLELY approves your account.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Email verification failed.');
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'done') {
    return (
      <section className="surface-card partner-form-card">
        <div className="partner-success-icon"><CheckCircle2 size={26} /></div>
        <span className="eyebrow">APPLICATION RECEIVED</span>
        <h2>Thanks for applying.</h2>
        <p>{message}</p>
        <Link className="button button-primary" href="/partners/dashboard">Open partner dashboard</Link>
      </section>
    );
  }

  return (
    <section className="surface-card partner-form-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">PARTNER APPLICATION</span>
          <h2>Join the TABLELY network</h2>
          <p>Use an email address you control. Your partner profile is separate from your restaurant workspace.</p>
        </div>
        <ShieldCheck size={22} />
      </div>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {message ? <div className="notice notice-info" role="status">{message}</div> : null}
      {stage === 'email' ? (
        <form className="partner-form-grid" onSubmit={verifyEmail}>
          <p className="partner-form-wide">Enter the email verification code sent to <strong>{form.email}</strong>, or open the sign-in link in that email.</p>
          <label className="partner-form-wide">Email verification code
            <input inputMode="numeric" autoComplete="one-time-code" value={emailOtp} onChange={(event) => setEmailOtp(event.target.value)} required />
          </label>
          <button className="button button-primary partner-form-wide" disabled={busy || !emailOtp.trim()}>
            {busy ? <><Loader2 size={15} className="spin" /> Verifying…</> : 'Verify email and submit application'}
          </button>
          <button className="text-button partner-form-wide" type="button" onClick={() => { setStage('details'); setEmailOtp(''); setMessage(''); }}>Back to application details</button>
        </form>
      ) : (
        <form className="partner-form-grid" onSubmit={sendEmailCode}>
          <label>Full name<input value={form.fullName} onChange={(event) => change('fullName', event.target.value)} autoComplete="name" required minLength={2} /></label>
          <label>Email<input type="email" value={form.email} onChange={(event) => change('email', event.target.value)} autoComplete="email" required readOnly={authenticated} /><small>{authenticated ? `Using signed-in account: ${accountEmail}` : 'This email is your partner sign-in.'}</small></label>
          <label>City<input value={form.city} onChange={(event) => change('city', event.target.value)} required /></label>
          <label>State<input value={form.state} onChange={(event) => change('state', event.target.value)} required /></label>
          <label>Partner category<select value={form.category} onChange={(event) => change('category', event.target.value)}>
            <option value="STUDENT">Student</option><option value="FREELANCER">Freelancer</option><option value="AGENCY">Agency</option><option value="CONSULTANT">Consultant</option><option value="OTHER">Other</option>
          </select></label>
          <label>Company name <small>Optional</small><input value={form.company} onChange={(event) => change('company', event.target.value)} /></label>
          <label>Website or social profile <small>Optional</small><input type="url" value={form.website} onChange={(event) => change('website', event.target.value)} placeholder="https://" /></label>
          <label>How did you hear about TABLELY? <small>Optional</small><input value={form.source} onChange={(event) => change('source', event.target.value)} /></label>
          <label>Address <small>Optional</small><input value={form.address} onChange={(event) => change('address', event.target.value)} /></label>
          <label className="partner-agreement partner-form-wide"><input type="checkbox" checked={form.agreement} onChange={(event) => change('agreement', event.target.checked)} /> I agree to the TABLELY Partner terms and understand that referral commissions are subject to restaurant verification, successful subscription payments and manual approval.</label>
          <button className="button button-primary partner-form-wide" disabled={busy}>
            {busy ? <><Loader2 size={15} className="spin" /> Sending email…</> : 'Continue with email'}
          </button>
        </form>
      )}
      <p className="partner-phone-note"><Link href="/partners/login">Already a partner? Sign in</Link></p>
    </section>
  );
}
