'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

export default function DangerZonePage() {
  const supabase = getSupabaseBrowserClient();
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    let active = true;
    (async () => {
      const context = await getCurrentRestaurantContext(supabase);
      if (!active) return;
      if (!context.data) {
        setError(context.error?.message ?? 'Workspace not found.');
        setLoading(false);
        return;
      }
      setIsOwner(context.data.staff.role === 'OWNER');
      setOrgName(context.data.organization.name);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [supabase]);

  const expectedPhrase = `delete-${orgName}`;
  const canSubmit = confirmText.trim() === expectedPhrase;

  async function deleteRestaurant() {
    if (!supabase || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const { error: rpcError } = await supabase.rpc('delete_restaurant_for_current_user', {
        p_confirm_name: orgName,
      });
      if (rpcError) throw rpcError;
      await supabase.auth.signOut();
      router.replace('/onboarding');
      router.refresh();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not delete restaurant.');
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <StudioShell>
        <div className="setup-loading">Loading…</div>
      </StudioShell>
    );
  }

  if (!isOwner) {
    return (
      <StudioShell>
        <SectionHeader eyebrow="DANGER ZONE" title="Delete restaurant" description="Only the owner can delete the restaurant workspace." />
        <div className="notice notice-error" role="alert">
          You don&apos;t have access to this page.
        </div>
      </StudioShell>
    );
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="DANGER ZONE"
        title="Delete restaurant"
        description="Permanently delete this restaurant, its branches, staff, menu, orders, and all related data. This cannot be undone."
      />

      {error ? (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      ) : null}

      <section className="surface-card settings-card danger-zone-card">
        <div className="card-heading">
          <div>
            <h2>Delete &ldquo;{orgName}&rdquo;</h2>
            <p>
              This permanently removes the restaurant, every branch, all staff logins, the full menu, order
              history, coupons, subscription and billing records, and every other record tied to this
              workspace. There is no way to recover this data afterward.
            </p>
          </div>
          <AlertTriangle size={20} />
        </div>

        <button className="button button-danger" type="button" onClick={() => setModalOpen(true)}>
          <Trash2 size={15} /> Delete this restaurant
        </button>
      </section>

      {modalOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setModalOpen(false);
          }}
        >
          <div className="modal-card compact-modal">
            <div className="modal-head">
              <div>
                <span className="eyebrow">IRREVERSIBLE</span>
                <h2>Delete {orgName}</h2>
              </div>
            </div>

            <div className="modal-form">
              <p>
                This will permanently delete <strong>{orgName}</strong> and all of its data. This action
                cannot be undone.
              </p>
              <p>
                To confirm, type <code>{expectedPhrase}</code> below.
              </p>
              <label>
                Confirmation
                <input
                  className="staff-email"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  placeholder={expectedPhrase}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </label>

              <div className="modal-actions">
                <button
                  className="button button-light"
                  type="button"
                  onClick={() => {
                    setModalOpen(false);
                    setConfirmText('');
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  className="button button-danger"
                  type="button"
                  disabled={!canSubmit || busy}
                  onClick={() => void deleteRestaurant()}
                >
                  {busy ? 'Deleting…' : 'Permanently delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </StudioShell>
  );
}
