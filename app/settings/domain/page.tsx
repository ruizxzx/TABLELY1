'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Globe2, RefreshCw, ShieldAlert } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

type DomainRow = {
  id: string;
  hostname: string;
  verification_token: string;
  status: string;
  verified_at: string | null;
};

export default function DomainPage() {
  const supabase = getSupabaseBrowserClient();
  const [organizationId, setOrganizationId] = useState('');
  const [domain, setDomain] = useState('');
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }

    const context = await getCurrentRestaurantContext(supabase);
    if (!context.data) {
      setError(context.error?.message ?? 'Workspace not found.');
      setLoading(false);
      return;
    }

    if (context.data.staff.role !== 'OWNER') {
      setError('Only the owner can manage custom domains.');
      setLoading(false);
      return;
    }

    setOrganizationId(context.data.organization.id);

    const { data, error: queryError } = await supabase
      .from('organization_domains')
      .select('id,hostname,verification_token,status,verified_at')
      .eq('organization_id', context.data.organization.id)
      .order('created_at');

    if (queryError) setError(queryError.message);
    else setRows((data ?? []) as DomainRow[]);

    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function verify(domainId: string) {
    setVerifying(domainId);
    setError(null);

    try {
      const response = await fetch('/api/domains/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domainId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Verification failed.');
      await load();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Verification failed.');
    } finally {
      setVerifying(null);
    }
  }

  async function add() {
    if (!supabase || !organizationId || !domain.trim()) return;

    const hostname = domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');

    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostname)) {
      setError('Enter a valid hostname such as menu.restaurant.com.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const { error: createError } = await supabase.rpc('create_organization_domain', {
        p_org_id: organizationId,
        p_hostname: hostname,
      });
      if (createError) throw createError;
      setDomain('');
      await load();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not add domain.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <StudioShell><div className="setup-loading">Loading domains…</div></StudioShell>;
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="PRO"
        title="Custom domain"
        description="Configure a customer-facing hostname for your branded ordering experience."
      />

      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}

      <section className="surface-card settings-card">
        <div className="card-heading">
          <div>
            <h2>Add domain</h2>
            <p>Tablely stores verification state. DNS routing and TLS remain deployment/provider configuration.</p>
          </div>
          <Globe2 size={18} />
        </div>

        <div className="button-row">
          <input
            className="staff-email"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="menu.restaurant.com"
            aria-label="Custom domain"
          />
          <button className="button button-primary" disabled={busy} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add domain'}
          </button>
        </div>
      </section>

      <div className="domain-grid">
        {rows.map((row) => (
          <article className="surface-card domain-card" key={row.id}>
            <div>
              <strong>{row.hostname}</strong>
              <span className={`domain-state ${row.status === 'VERIFIED' ? 'verified' : ''}`}>
                {row.status === 'VERIFIED' ? <CheckCircle2 size={14} /> : <ShieldAlert size={14} />}
                {row.status}
              </span>
            </div>

            <div className="dns-instructions">
              <span>Publish this TXT token for verification</span>
              <code>{row.verification_token}</code>
              <div className="button-row">
                <button
                  className="button button-light compact"
                  onClick={() => void navigator.clipboard.writeText(row.verification_token)}
                >
                  <Copy size={13} /> Copy token
                </button>
                {row.status !== 'VERIFIED' ? (
                  <button
                    className="button button-primary compact"
                    disabled={verifying === row.id}
                    onClick={() => void verify(row.id)}
                  >
                    <RefreshCw size={13} />
                    {verifying === row.id ? 'Checking…' : 'Verify DNS'}
                  </button>
                ) : null}
              </div>
            </div>

            <small>
              Record name: <code>_tablely-verification.{row.hostname}</code>. After verification, your hosting layer must route the hostname to Tablely and provide TLS.
            </small>
          </article>
        ))}
      </div>
    </StudioShell>
  );
}
