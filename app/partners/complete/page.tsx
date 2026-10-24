'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

const draftKey = 'tablely-partner-application';

export default function CompletePartnerApplicationPage() {
  const [message, setMessage] = useState('Finishing your partner application…');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function complete() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        setError('Supabase is not configured.');
        return;
      }
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) {
        setError(sessionError.message);
        return;
      }
      if (!session) {
        setError('Your sign-in link did not create a session. Request a new partner sign-in email.');
        return;
      }
      let draft: unknown;
      try {
        const saved = localStorage.getItem(draftKey);
        draft = saved ? JSON.parse(saved) : null;
      } catch {
        setError('The saved application details could not be read. Return to the application and submit it again.');
        return;
      }
      if (!draft || typeof draft !== 'object') {
        setMessage('Email confirmed. Sign in to the partner portal, or apply using this signed-in email.');
        return;
      }
      try {
        const response = await fetch('/api/partners/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || 'Could not submit your partner application.');
        localStorage.removeItem(draftKey);
        if (active) window.location.replace('/partners/dashboard');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Could not submit your partner application.');
      }
    }
    void complete();
    return () => { active = false; };
  }, []);

  return (
    <main className="auth-page">
      <div className="auth-panel">
        <div className="eyebrow">PARTNER PORTAL</div>
        <h1>{error ? 'We could not finish that.' : 'One moment…'}</h1>
        {error ? <div className="notice notice-error" role="alert">{error}</div> : <p><Loader2 size={16} className="spin" /> {message}</p>}
        <div className="button-row">
          <Link className="button button-primary" href="/partners/login">Partner sign in</Link>
          <Link className="button button-light" href="/partners#partner-apply">Partner application</Link>
        </div>
      </div>
    </main>
  );
}
