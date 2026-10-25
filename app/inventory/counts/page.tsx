'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ClipboardCheck, Plus, RefreshCw } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { extractErrorMessage } from '@/lib/inventory-errors';
import '../inventory.css';

type StockCount = {
  id: string;
  status: string;
  is_blind: boolean;
  count_date: string;
  notes: string | null;
  created_at: string;
  line_count: number;
};
type CountLine = {
  item_id: string;
  item_name: string;
  unit: string;
  counted_qty: number | null;
  expected_qty: number | null;
  variance_qty: number | null;
  notes: string | null;
};
type CountDetails = {
  count: { id: string; status: string; is_blind: boolean; count_date: string; notes: string | null };
  lines: CountLine[];
};
type Location = { id: string; name: string };

export default function InventoryCountsPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [canAdjust, setCanAdjust] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [counts, setCounts] = useState<StockCount[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [details, setDetails] = useState<CountDetails | null>(null);
  const [draftCounts, setDraftCounts] = useState<Record<string, string>>({});
  const [locationId, setLocationId] = useState('');
  const [blind, setBlind] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const context = await getCurrentRestaurantContext(supabase);
      if (!context.data) throw context.error ?? new Error('Restaurant workspace not found.');
      const branch = context.data.branch;
      setBranchId(branch.id);
      setBranchName(branch.name);
      setIsOwner(context.data.staff.role === 'OWNER');

      const [view, adjust, countRows, locationRows] = await Promise.all([
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_VIEW',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_ADJUST',
        }),
        supabase.rpc('inventory_list_stock_counts', {
          p_branch_id: branch.id,
          p_limit: 100,
          p_offset: 0,
        }),
        supabase.from('inventory_locations').select('id,name').eq('branch_id', branch.id).eq('is_active', true).order('name'),
      ]);
      if (view.error) throw view.error;
      if (!view.data) throw new Error('You do not have inventory view permission for this branch.');
      if (adjust.error) throw adjust.error;
      if (countRows.error) throw countRows.error;
      if (locationRows.error) throw locationRows.error;
      setCanAdjust(Boolean(adjust.data));
      setCounts((countRows.data ?? []) as StockCount[]);
      setLocations((locationRows.data ?? []) as Location[]);
      if (selectedId && !(countRows.data ?? []).some((row: StockCount) => row.id === selectedId)) {
        setSelectedId('');
        setDetails(null);
      }
    } catch (loadError) {
      setError(extractErrorMessage(loadError, 'Could not load stock counts.'));
    } finally {
      setLoading(false);
    }
  }, [supabase, selectedId]);

  const loadDetails = useCallback(async (countId: string) => {
    if (!supabase || !countId) return;
    setError(null);
    try {
      const result = await supabase.rpc('inventory_get_stock_count', { p_count_id: countId });
      if (result.error) throw result.error;
      const next = result.data as CountDetails;
      setDetails(next);
      setDraftCounts(Object.fromEntries(next.lines.map((line) => [
        line.item_id,
        line.counted_qty == null ? '' : String(line.counted_qty),
      ])));
    } catch (detailError) {
      setError(extractErrorMessage(detailError, 'Could not load count details.'));
      setDetails(null);
    }
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selectedId) void loadDetails(selectedId); }, [selectedId, loadDetails]);

  const selectedCount = useMemo(() => counts.find((count) => count.id === selectedId), [counts, selectedId]);

  async function createCount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canAdjust || !branchId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await supabase.rpc('inventory_create_stock_count', {
        p_branch_id: branchId,
        p_location_id: locationId || null,
        p_is_blind: blind,
        p_notes: null,
        p_count_date: new Date().toISOString().slice(0, 10),
      });
      if (result.error) throw result.error;
      setSelectedId(String(result.data.id));
      setNotice('Stock count created. Enter the physical quantities and submit when complete.');
      await load();
    } catch (createError) {
      setError(extractErrorMessage(createError, 'Could not create stock count.'));
    } finally {
      setBusy(false);
    }
  }

  async function submitCount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !details || !canAdjust) return;
    const lines = details.lines.map((line) => ({
      item_id: line.item_id,
      counted_qty: Number(draftCounts[line.item_id]),
      notes: null,
    }));
    if (lines.some((line) => !Number.isFinite(line.counted_qty) || line.counted_qty < 0)) {
      setError('Enter a non-negative count for each item before submitting.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await supabase.rpc('inventory_submit_count_lines', {
        p_count_id: details.count.id,
        p_lines: lines,
      });
      if (result.error) throw result.error;
      setNotice('Count submitted for approval.');
      await load();
      await loadDetails(details.count.id);
    } catch (submitError) {
      setError(extractErrorMessage(submitError, 'Could not submit count.'));
    } finally {
      setBusy(false);
    }
  }

  async function approveCount() {
    if (!supabase || !details || !canAdjust) return;
    if (!window.confirm('Approve this stock count? The system will create permanent adjustment movements for any variance.')) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await supabase.rpc('inventory_approve_stock_count', { p_count_id: details.count.id });
      if (result.error) throw result.error;
      setNotice('Stock count approved and adjustment movements recorded.');
      await load();
      await loadDetails(details.count.id);
    } catch (approveError) {
      setError(extractErrorMessage(approveError, 'Could not approve stock count.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Stock counts"
          description={`${branchName || 'Your branch'} · Physical counts and audited adjustments`}
          action={
            <div className="inventory-actions">
              <Link className="button button-light" href="/inventory">Inventory</Link>
              <Link className="button button-light" href="/inventory/purchases">Purchasing</Link>
              <button type="button" className="button button-light" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
            </div>
          }
        />
        {error && <div className="inventory-error" role="alert">{error}</div>}
        {notice && <div className="inventory-alert-strip" role="status">{notice}</div>}

        {canAdjust && <form className="inventory-card inventory-count-create" onSubmit={(event) => void createCount(event)}>
          <div><span className="inventory-kicker">NEW COUNT</span><h2><ClipboardCheck size={17} /> Start a stock count</h2></div>
          <label>Location
            <select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
              <option value="">All locations</option>
              {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
            </select>
          </label>
          <label className="inventory-count-blind"><input type="checkbox" checked={blind} onChange={(event) => setBlind(event.target.checked)} /> Blind count (hide expected quantities)</label>
          <button type="submit" className="button button-primary" disabled={busy}><Plus size={15} /> Create count</button>
        </form>}

        <div className="inventory-count-layout">
          <section className="inventory-card">
            <div className="inventory-list-heading"><div><span className="inventory-kicker">COUNT HISTORY</span><h2>Sessions <span>{counts.length}</span></h2></div></div>
            <div className="inventory-count-list">
              {loading ? <p className="inventory-list-footnote">Loading counts…</p>
                : counts.length === 0 ? <p className="inventory-list-footnote">No stock counts yet.</p>
                  : counts.map((count) => <button type="button" key={count.id} className={`inventory-count-row${selectedId === count.id ? ' is-selected' : ''}`} onClick={() => setSelectedId(count.id)}>
                    <span><strong>{new Date(`${count.count_date}T00:00:00`).toLocaleDateString('en-IN')}</strong><small>{count.line_count} items · {count.is_blind ? 'blind' : 'visible'} count</small></span>
                    <span className="inventory-status inventory-status-healthy">{count.status.replaceAll('_', ' ')}</span>
                  </button>)}
            </div>
          </section>

          <section className="inventory-card">
            <div className="inventory-list-heading"><div><span className="inventory-kicker">COUNT DETAILS</span><h2>{selectedCount ? new Date(`${selectedCount.count_date}T00:00:00`).toLocaleDateString('en-IN') : 'Select a session'}</h2></div></div>
            {!details ? <p className="inventory-list-footnote">Choose a session to view or enter its item counts.</p> : (
              <>
                <p className="inventory-list-footnote">{details.count.is_blind ? 'Blind count' : 'Expected quantities visible'} · {details.count.status.replaceAll('_', ' ')}</p>
                <form onSubmit={(event) => void submitCount(event)}>
                  <div className="inventory-table-wrap">
                    <table className="inventory-table">
                      <thead><tr><th>Ingredient</th><th>Counted</th>{details.lines.some((line) => line.expected_qty !== null) && <><th>Expected</th><th>Variance</th></>}</tr></thead>
                      <tbody>{details.lines.map((line) => <tr key={line.item_id}>
                        <td><strong>{line.item_name}</strong><small>{line.unit}</small></td>
                        <td>{['OPEN', 'IN_PROGRESS'].includes(details.count.status) && canAdjust
                          ? <input className="inventory-count-qty" type="number" min="0" step="0.0001" value={draftCounts[line.item_id] ?? ''} onChange={(event) => setDraftCounts((current) => ({ ...current, [line.item_id]: event.target.value }))} aria-label={`Counted quantity for ${line.item_name}`} required />
                          : line.counted_qty == null ? '—' : Number(line.counted_qty).toLocaleString('en-IN')}</td>
                        {details.lines.some((entry) => entry.expected_qty !== null) && <>
                          <td>{line.expected_qty == null ? 'Hidden' : Number(line.expected_qty).toLocaleString('en-IN')}</td>
                          <td>{line.variance_qty == null ? '—' : Number(line.variance_qty).toLocaleString('en-IN')}</td>
                        </>}
                      </tr>)}</tbody>
                    </table>
                  </div>
                  {['OPEN', 'IN_PROGRESS'].includes(details.count.status) && canAdjust && <div className="inventory-form-footer"><span>Count each listed item. Blind expected stock remains hidden until approval or owner review.</span><button className="button button-primary" disabled={busy}>Submit count</button></div>}
                </form>
                {details.count.status === 'PENDING_APPROVAL' && canAdjust
                  && (isOwner || details.lines.every((line) => line.expected_qty !== null))
                  && <div className="inventory-form-footer"><span>Approval writes immutable adjustment movements to the stock ledger.</span><button type="button" className="button button-primary" onClick={() => void approveCount()} disabled={busy}>Approve adjustments</button></div>}
              </>
            )}
          </section>
        </div>
      </main>
    </StudioShell>
  );
}
