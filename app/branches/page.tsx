'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Check, MapPin, Plus, X } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

type Branch = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
};

export default function BranchesPage() {
  const supabase = getSupabaseBrowserClient();
  const [rows, setRows] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Branch | null>(null);
  const [draft, setDraft] = useState({ name: '', address: '', phone: '', active: true });
  const [canEdit, setCanEdit] = useState(false);
  const [canCreate, setCanCreate] = useState(false);

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

    const isOwner = context.data.staff.role === 'OWNER';
    setCanCreate(isOwner);

    if (isOwner) {
      setCanEdit(true);
    } else {
      const { data: delegateAllowed, error: delegateError } = await supabase.rpc('is_branch_manager_with_permission', {
        target_branch: context.data.branch.id,
        p_permission: 'BRANCH_MANAGEMENT',
      });
      if (delegateError) {
        setError(delegateError.message);
        setLoading(false);
        return;
      }
      setCanEdit(Boolean(delegateAllowed));
    }

    const { data, error: branchError } = await supabase
      .from('branches')
      .select('id,name,address,phone,is_active')
      .eq('organization_id', context.data.organization.id)
      .order('created_at');

    if (branchError) setError(branchError.message);
    else setRows((data ?? []) as Branch[]);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  function openAdd() {
    setDraft({ name: '', address: '', phone: '', active: true });
    setModal({ id: '', name: '', address: null, phone: null, is_active: true });
  }

  function openEdit(branch: Branch) {
    setDraft({
      name: branch.name,
      address: branch.address ?? '',
      phone: branch.phone ?? '',
      active: branch.is_active,
    });
    setModal(branch);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !modal) return;

    setBusy(true);
    setError(null);

    try {
      if (modal.id) {
        const { data, error: updateError } = await supabase.rpc('update_branch_settings', {
          p_branch_id: modal.id,
          p_name: draft.name,
          p_address: draft.address,
          p_phone: draft.phone,
          p_is_active: draft.active,
        });
        if (updateError) throw updateError;
        setRows((current) => current.map((row) => (row.id === modal.id ? (data as Branch) : row)));
        setModal(null);
      } else {
        const { data, error: createError } = await supabase.rpc('create_organization_branch', {
          p_name: draft.name,
          p_address: draft.address || null,
          p_phone: draft.phone || null,
        });
        if (createError) throw createError;
        setRows((current) => [...current, data as Branch]);
        setModal(null);
      }
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not save branch.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <StudioShell><div className="setup-loading">Loading branches…</div></StudioShell>;
  }

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="OPERATIONS"
        title="Branches"
        description="Create, edit, activate and switch between restaurant locations."
        action={
          canCreate ? (
            <button className="button button-primary" onClick={openAdd}>
              <Plus size={15} /> Add branch
            </button>
          ) : (
            <span className="role-note">Assigned branch only</span>
          )
        }
      />

      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}

      <div className="branch-grid">
        {rows.map((branch) => (
          <article className={`surface-card branch-card ${branch.is_active ? '' : 'branch-disabled'}`} key={branch.id}>
            <div className="branch-card-head">
              <div className="branch-icon"><Building2 size={20} /></div>
              <div>
                <h2>{branch.name}</h2>
                <span>{branch.is_active ? 'Active' : 'Disabled'}</span>
              </div>
              <span className="branch-status"><i />{branch.is_active ? 'LIVE' : 'OFF'}</span>
            </div>

            <div className="branch-details">
              {branch.address ? <span><MapPin size={14} />{branch.address}</span> : <span>No address configured</span>}
              {branch.phone ? <span>{branch.phone}</span> : null}
            </div>

            <div className="button-row">
              <button className="button button-light compact" disabled={!canEdit} onClick={() => openEdit(branch)}>Edit</button>
              {branch.id === window.localStorage.getItem('tablely_active_branch') ? (
                <span className="active-branch-chip"><Check size={13} /> Current</span>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      <div className="notice notice-info">
        Non-owner staff only see branches they are assigned to. Owners can manage the full organization.
      </div>

      {modal ? (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}>
          <div className="modal-card compact-modal">
            <div className="modal-head">
              <div>
                <span className="eyebrow">BRANCH</span>
                <h2>{modal.id ? 'Edit branch' : 'Add branch'}</h2>
              </div>
              <button className="icon-button" onClick={() => setModal(null)} aria-label="Close">
                <X size={17} />
              </button>
            </div>

            <form className="modal-form" onSubmit={(event) => void save(event)}>
              <label>Branch name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={100} required /></label>
              <label>Address<input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} maxLength={300} /></label>
              <label>Phone<input value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} maxLength={30} /></label>
              {modal.id ? (
                <label className="settings-toggle">
                  <div><strong>Branch active</strong><span>Inactive branches stop receiving customer traffic.</span></div>
                  <button type="button" className={`toggle ${draft.active ? 'on' : ''}`} onClick={() => setDraft({ ...draft, active: !draft.active })}>
                    {draft.active ? 'ON' : 'OFF'}
                  </button>
                </label>
              ) : null}

              <div className="modal-actions">
                <button type="button" className="button button-light" onClick={() => setModal(null)}>Cancel</button>
                <button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : modal.id ? 'Save branch' : 'Create branch'}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </StudioShell>
  );
}
