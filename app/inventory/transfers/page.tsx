'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeftRight, Check, Plus, RefreshCw, Send, Truck } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import '../inventory.css';

type Branch = { id: string; name: string };
type Batch = { id: string; batch_number: string | null; current_qty: number; expires_at: string | null };
type TransferItem = {
  id: string;
  name: string;
  base_unit: string;
  available_qty: number;
  track_batches: boolean;
  batches: Batch[];
};
type TransferRow = {
  id: string;
  transfer_number: string;
  status: string;
  from_branch_id: string;
  from_branch_name: string;
  to_branch_id: string;
  to_branch_name: string;
  requested_at: string;
  line_count: number;
};
type TransferLine = {
  id: string;
  item_id: string;
  item_name: string;
  requested_qty: number;
  dispatched_qty: number | null;
  received_qty: number | null;
  damaged_in_transit_qty: number;
  unit: string;
  unit_cost_paise: number | null;
  from_location_id: string | null;
  to_location_id: string | null;
  from_batch_id: string | null;
};
type TransferDetails = {
  id: string;
  transfer_number: string;
  status: string;
  from_branch_id: string;
  to_branch_id: string;
  notes: string | null;
  requested_at: string;
  lines: TransferLine[];
};
type DraftLine = { itemId: string; qty: string; batchId: string; fromLocationId: string; toLocationId: string };
type Location = { id: string; name: string };
type ReceiptDraft = { accepted: string; damaged: string; locationId: string };

const blankLine = (): DraftLine => ({ itemId: '', qty: '', batchId: '', fromLocationId: '', toLocationId: '' });
const hasInventoryPrecision = (quantity: number) =>
  Math.abs(quantity * 10000 - Math.round(quantity * 10000)) < 0.000001;

export default function InventoryTransfersPage() {
  const supabase = getSupabaseBrowserClient();
  const [activeBranchId, setActiveBranchId] = useState('');
  const [activeBranchName, setActiveBranchName] = useState('');
  const [branches, setBranches] = useState<Branch[]>([]);
  const [items, setItems] = useState<TransferItem[]>([]);
  const [sourceLocations, setSourceLocations] = useState<Location[]>([]);
  const [destinationLocations, setDestinationLocations] = useState<Location[]>([]);
  const [sourceBranchId, setSourceBranchId] = useState('');
  const [destinationBranchId, setDestinationBranchId] = useState('');
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [details, setDetails] = useState<TransferDetails | null>(null);
  const [receiptDrafts, setReceiptDrafts] = useState<Record<string, ReceiptDraft>>({});
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [notes, setNotes] = useState('');
  const [canTransfer, setCanTransfer] = useState(false);
  const [canActFrom, setCanActFrom] = useState(false);
  const [canActTo, setCanActTo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedItemIds = useMemo(() => lines.map((line) => line.itemId).filter(Boolean), [lines]);

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
      const active = context.data.branch;
      setActiveBranchId(active.id);
      setActiveBranchName(active.name);
      setSourceBranchId((current) => current || active.id);
      const [permission, branchesResult, transfersResult] = await Promise.all([
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: active.id,
          p_permission: 'INVENTORY_TRANSFER',
        }),
        supabase.rpc('inventory_list_transfer_branches', { p_branch_id: active.id }),
        supabase.rpc('inventory_list_transfers', { p_branch_id: active.id, p_limit: 100 }),
      ]);
      if (permission.error) throw permission.error;
      if (branchesResult.error) throw branchesResult.error;
      if (transfersResult.error) throw transfersResult.error;
      setCanTransfer(Boolean(permission.data));
      const nextBranches = (branchesResult.data ?? []) as Branch[];
      setBranches(nextBranches);
      setDestinationBranchId((current) => current || nextBranches.find((branch) => branch.id !== active.id)?.id || '');
      setTransfers((transfersResult.data ?? []) as TransferRow[]);
      if (selectedId && !(transfersResult.data ?? []).some((row: TransferRow) => row.id === selectedId)) {
        setSelectedId('');
        setDetails(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load branch transfers.');
    } finally {
      setLoading(false);
    }
  }, [supabase, selectedId]);

  const loadSourceData = useCallback(async () => {
    if (!supabase || !sourceBranchId || !destinationBranchId) return;
    try {
      const [itemResult, sourceLocationResult, destinationLocationResult] = await Promise.all([
        supabase.rpc('inventory_list_transfer_items', { p_branch_id: sourceBranchId }),
        supabase.rpc('inventory_list_transfer_locations', { p_branch_id: sourceBranchId }),
        supabase.rpc('inventory_list_transfer_locations', { p_branch_id: destinationBranchId }),
      ]);
      if (itemResult.error) throw itemResult.error;
      if (sourceLocationResult.error) throw sourceLocationResult.error;
      if (destinationLocationResult.error) throw destinationLocationResult.error;
      setItems((itemResult.data ?? []) as TransferItem[]);
      setSourceLocations((sourceLocationResult.data ?? []) as Location[]);
      setDestinationLocations((destinationLocationResult.data ?? []) as Location[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load transfer stock and locations.');
    }
  }, [supabase, sourceBranchId, destinationBranchId]);

  const loadDetails = useCallback(async (transferId: string) => {
    if (!supabase || !transferId) return;
    try {
      const result = await supabase.rpc('inventory_get_transfer', { p_transfer_id: transferId });
      if (result.error) throw result.error;
      const next = result.data as TransferDetails;
      setDetails(next);
      const [fromPermission, toPermission] = await Promise.all([
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: next.from_branch_id,
          p_permission: 'INVENTORY_TRANSFER',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: next.to_branch_id,
          p_permission: 'INVENTORY_TRANSFER',
        }),
      ]);
      if (fromPermission.error) throw fromPermission.error;
      if (toPermission.error) throw toPermission.error;
      setCanActFrom(Boolean(fromPermission.data));
      setCanActTo(Boolean(toPermission.data));
      setReceiptDrafts(Object.fromEntries(next.lines.map((line) => [line.id, {
        accepted: String(line.dispatched_qty ?? line.requested_qty),
        damaged: '0',
        locationId: line.to_location_id ?? '',
      }])));
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : 'Could not load transfer details.');
      setDetails(null);
    }
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadSourceData(); }, [loadSourceData]);
  useEffect(() => { if (selectedId) void loadDetails(selectedId); }, [selectedId, loadDetails]);

  function updateLine(index: number, key: keyof DraftLine, value: string) {
    setLines((current) => current.map((line, lineIndex) => lineIndex === index
      ? { ...line, [key]: value, ...(key === 'itemId' ? { batchId: '' } : {}) }
      : line));
  }

  async function createTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canTransfer || !sourceBranchId || !destinationBranchId) return;
    if (sourceBranchId === destinationBranchId) {
      setError('Choose two different branches.');
      return;
    }
    const payloadLines = lines.map((line) => {
      const item = items.find((entry) => entry.id === line.itemId);
      return {
        item_id: line.itemId,
        requested_qty: Number(line.qty),
        from_batch_id: line.batchId || null,
        from_location_id: line.fromLocationId || null,
        to_location_id: line.toLocationId || null,
        item,
      };
    });
    if (payloadLines.some((line) => !line.item || !Number.isFinite(line.requested_qty)
      || line.requested_qty <= 0 || !hasInventoryPrecision(line.requested_qty))) {
      setError('Choose an ingredient and enter a positive quantity for every line.');
      return;
    }
    if (new Set(payloadLines.map((line) => line.item_id)).size !== payloadLines.length) {
      setError('Each ingredient can appear only once in a transfer.');
      return;
    }
    if (payloadLines.some((line) => line.item?.track_batches && !line.from_batch_id)) {
      setError('Select a source batch for every batch-tracked ingredient.');
      return;
    }
    if (payloadLines.some((line) => line.requested_qty > Number(line.item?.available_qty ?? 0))) {
      setError('A quantity exceeds available source-branch stock.');
      return;
    }
    for (const line of payloadLines) {
      const batch = line.item?.batches.find((entry) => entry.id === line.from_batch_id);
      if (batch && line.requested_qty > Number(batch.current_qty)) {
        setError(`Quantity exceeds the selected batch stock for ${line.item?.name}.`);
        return;
      }
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await supabase.rpc('inventory_create_transfer', {
        p_from_branch_id: sourceBranchId,
        p_to_branch_id: destinationBranchId,
        p_lines: payloadLines.map(({ item: _item, ...line }) => line),
        p_notes: notes.trim() || null,
      });
      if (result.error) throw result.error;
      setLines([blankLine()]);
      setNotes('');
      setNotice('Transfer requested. The destination branch must approve it before dispatch.');
      setSelectedId(String(result.data.id));
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not request the transfer.');
    } finally {
      setBusy(false);
    }
  }

  async function transition(action: 'APPROVE' | 'DISPATCH' | 'MARK_IN_TRANSIT' | 'RECEIVE' | 'CANCEL') {
    if (!supabase || !details) return;
    if (action === 'DISPATCH'
      && !window.confirm('Dispatch this transfer? Source stock will be deducted and cannot be restored by cancelling.')) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const receipts = action === 'RECEIVE' ? details.lines.map((line) => ({
        line_id: line.id,
        accepted_qty: Number(receiptDrafts[line.id]?.accepted),
        damaged_qty: Number(receiptDrafts[line.id]?.damaged),
        to_location_id: receiptDrafts[line.id]?.locationId || null,
      })) : null;
      if (action === 'RECEIVE' && receipts?.some((receipt, index) =>
        !Number.isFinite(receipt.accepted_qty) || !Number.isFinite(receipt.damaged_qty)
        || receipt.accepted_qty < 0 || receipt.damaged_qty < 0
        || !hasInventoryPrecision(receipt.accepted_qty) || !hasInventoryPrecision(receipt.damaged_qty)
        || Math.round((receipt.accepted_qty + receipt.damaged_qty) * 10000)
          !== Math.round(Number(details.lines[index].dispatched_qty) * 10000))) {
        setError('For each item, accepted plus damaged quantity must equal the dispatched quantity.');
        setBusy(false);
        return;
      }
      const result = await supabase.rpc('inventory_transition_transfer', {
        p_transfer_id: details.id,
        p_action: action,
        p_receipts: receipts,
      });
      if (result.error) throw result.error;
      setNotice(action === 'RECEIVE'
        ? 'Transfer received. Accepted quantities were added to destination stock.'
        : `Transfer ${action.toLowerCase().replaceAll('_', ' ')} successfully.`);
      await load();
      await loadDetails(details.id);
    } catch (transitionError) {
      setError(transitionError instanceof Error ? transitionError.message : 'Could not update the transfer.');
    } finally {
      setBusy(false);
    }
  }

  function itemOptionsFor(line: DraftLine) {
    return items.filter((item) => !selectedItemIds.includes(item.id) || item.id === line.itemId);
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Branch transfers"
          description={`${activeBranchName || 'Your branch'} · Move stock between authorized branches`}
          action={<div className="inventory-actions">
            <Link className="button button-light" href="/inventory">Inventory</Link>
            <Link className="button button-light" href="/inventory/purchases">Purchasing</Link>
            <button type="button" className="button button-light" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
          </div>}
        />
        {error && <div className="inventory-error" role="alert">{error}</div>}
        {notice && <div className="inventory-alert-strip" role="status">{notice}</div>}
        {!canTransfer && !loading && <div className="inventory-error" role="alert">Inventory transfer permission is required on this branch.</div>}

        {canTransfer && branches.length > 1 && <form className="inventory-create" onSubmit={(event) => void createTransfer(event)}>
          <div className="inventory-create-heading">
            <div><span className="inventory-kicker">NEW TRANSFER</span><h2><ArrowLeftRight size={17} /> Request stock movement</h2></div>
          </div>
          <div className="inventory-form-grid">
            <label>From branch
              <select value={sourceBranchId} onChange={(event) => {
                const nextSource = event.target.value;
                setSourceBranchId(nextSource);
                if (destinationBranchId === nextSource) {
                  setDestinationBranchId(branches.find((branch) => branch.id !== nextSource)?.id ?? '');
                }
              }} required>
                {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </label>
            <label>To branch
              <select value={destinationBranchId} onChange={(event) => setDestinationBranchId(event.target.value)} required>
                {branches.filter((branch) => branch.id !== sourceBranchId).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
              </select>
            </label>
            <label className="inventory-recipe-description">Notes <span className="inventory-optional">OPTIONAL</span>
              <input maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Reason or handling instructions" />
            </label>
          </div>
          <div className="inventory-recipe-lines">
            {lines.map((line, index) => {
              const item = items.find((entry) => entry.id === line.itemId);
              const batch = item?.batches.find((entry) => entry.id === line.batchId);
              return <div className="inventory-transfer-line" key={`transfer-line-${index}`}>
                <label>Ingredient
                  <select value={line.itemId} onChange={(event) => updateLine(index, 'itemId', event.target.value)} required>
                    <option value="">Select ingredient</option>
                    {itemOptionsFor(line).map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.available_qty} {entry.base_unit} available</option>)}
                  </select>
                </label>
                <label>Quantity
                  <input type="number" min="0.0001" step="0.0001" max={batch?.current_qty ?? item?.available_qty} value={line.qty} onChange={(event) => updateLine(index, 'qty', event.target.value)} required />
                  <small>{item ? `Available ${batch ? batch.current_qty : item.available_qty} ${item.base_unit}` : 'In stock units'}</small>
                </label>
                {item?.track_batches && <label>Source batch
                  <select value={line.batchId} onChange={(event) => updateLine(index, 'batchId', event.target.value)} required>
                    <option value="">Select batch</option>
                    {item.batches.map((entry) => <option key={entry.id} value={entry.id}>
                      {entry.batch_number || entry.id.slice(0, 8)} · {entry.current_qty} {item.base_unit}{entry.expires_at ? ` · expires ${entry.expires_at}` : ''}
                    </option>)}
                  </select>
                </label>}
                <label>Source location
                  <select value={line.fromLocationId} onChange={(event) => updateLine(index, 'fromLocationId', event.target.value)}>
                    <option value="">Unspecified</option>{sourceLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                  </select>
                </label>
                <label>Destination location
                  <select value={line.toLocationId} onChange={(event) => updateLine(index, 'toLocationId', event.target.value)}>
                    <option value="">Unspecified</option>{destinationLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                  </select>
                </label>
                <button type="button" className="button button-light" onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} disabled={lines.length === 1}>Remove</button>
              </div>;
            })}
          </div>
          <div className="inventory-form-footer">
            <button type="button" className="button button-light" onClick={() => setLines((current) => [...current, blankLine()])} disabled={lines.length >= 100}><Plus size={15} /> Add item</button>
            <span>Stock is deducted only on dispatch. Destination stock is added only when received.</span>
            <button className="button button-primary" disabled={busy || !destinationBranchId || sourceBranchId === destinationBranchId || items.length === 0}>
              <ArrowLeftRight size={15} /> {busy ? 'Requesting…' : 'Request transfer'}
            </button>
          </div>
        </form>}

        <div className="inventory-count-layout">
          <section className="inventory-card">
            <div className="inventory-list-heading"><div><span className="inventory-kicker">TRANSFER HISTORY</span><h2>Requests <span>{transfers.length}</span></h2></div></div>
            <div className="inventory-count-list">
              {loading ? <p className="inventory-list-footnote">Loading transfers…</p>
                : transfers.length === 0 ? <p className="inventory-list-footnote">No branch transfers yet.</p>
                  : transfers.map((transfer) => <button type="button" key={transfer.id} className={`inventory-count-row${selectedId === transfer.id ? ' is-selected' : ''}`} onClick={() => setSelectedId(transfer.id)}>
                    <span><strong>{transfer.transfer_number}</strong><small>{transfer.from_branch_name} → {transfer.to_branch_name} · {transfer.line_count} items</small></span>
                    <span className="inventory-status inventory-status-healthy">{transfer.status.replaceAll('_', ' ')}</span>
                  </button>)}
            </div>
          </section>
          <section className="inventory-card">
            <div className="inventory-list-heading"><div><span className="inventory-kicker">TRANSFER DETAILS</span><h2>{details?.transfer_number ?? 'Select a request'}</h2></div></div>
            {!details ? <p className="inventory-list-footnote">Select a transfer to review its items and available actions.</p> : <>
              <p className="inventory-list-footnote">Status: {details.status.replaceAll('_', ' ')}{details.notes ? ` · ${details.notes}` : ''}</p>
              <div className="inventory-table-wrap"><table className="inventory-table">
                <thead><tr><th>Ingredient</th><th>Requested</th><th>Dispatched</th><th>Accepted</th><th>Damaged</th>{details.status === 'IN_TRANSIT' && canActTo && destinationLocations.length > 0 && <th>Destination location</th>}</tr></thead>
                <tbody>{details.lines.map((line) => <tr key={line.id}>
                  <td><strong>{line.item_name}</strong><small>{line.unit}{line.unit_cost_paise !== null ? ` · ₹${(line.unit_cost_paise / 100).toFixed(2)}/unit` : ''}</small></td>
                  <td>{line.requested_qty}</td><td>{line.dispatched_qty ?? '—'}</td>
                  {details.status === 'IN_TRANSIT' && canActTo
                    ? <td><input className="inventory-count-qty" type="number" min="0" step="0.0001" value={receiptDrafts[line.id]?.accepted ?? ''} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], accepted: event.target.value } }))} /></td>
                    : <td>{line.received_qty ?? '—'}</td>}
                  {details.status === 'IN_TRANSIT' && canActTo
                    ? <td><input className="inventory-count-qty" type="number" min="0" step="0.0001" value={receiptDrafts[line.id]?.damaged ?? '0'} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], damaged: event.target.value } }))} /></td>
                    : <td>{line.damaged_in_transit_qty}</td>}
                  {details.status === 'IN_TRANSIT' && canActTo && destinationLocations.length > 0 && <td>
                    <select value={receiptDrafts[line.id]?.locationId ?? ''} onChange={(event) => setReceiptDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], locationId: event.target.value } }))}>
                      <option value="">Keep requested location</option>{destinationLocations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                    </select>
                  </td>}
                </tr>)}</tbody>
              </table></div>
              <div className="inventory-form-footer">
                <span>{details.status === 'REQUESTED' ? 'The destination branch reviews this request.' : details.status === 'APPROVED' ? 'Dispatch deducts available source stock.' : details.status === 'IN_TRANSIT' ? 'Reconcile every dispatched quantity as accepted or damaged.' : 'Transfer history is retained for audit.'}</span>
                <div className="inventory-actions">
                  {details.status === 'REQUESTED' && canActTo && <button type="button" className="button button-primary" onClick={() => void transition('APPROVE')} disabled={busy}><Check size={15} /> Approve</button>}
                  {details.status === 'REQUESTED' && canActFrom && <button type="button" className="button button-light" onClick={() => void transition('CANCEL')} disabled={busy}>Cancel</button>}
                  {details.status === 'APPROVED' && canActFrom && <button type="button" className="button button-primary" onClick={() => void transition('DISPATCH')} disabled={busy}><Send size={15} /> Dispatch</button>}
                  {details.status === 'DISPATCHED' && canActFrom && <button type="button" className="button button-primary" onClick={() => void transition('MARK_IN_TRANSIT')} disabled={busy}><Truck size={15} /> Mark in transit</button>}
                  {details.status === 'IN_TRANSIT' && canActTo && <button type="button" className="button button-primary" onClick={() => void transition('RECEIVE')} disabled={busy}><Check size={15} /> Confirm receipt</button>}
                </div>
              </div>
            </>}
          </section>
        </div>
      </main>
    </StudioShell>
  );
}
