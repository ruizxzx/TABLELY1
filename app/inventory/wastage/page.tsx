'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AlertTriangle, Plus, RefreshCw } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import '../inventory.css';

type WastageItem = {
  id: string;
  name: string;
  base_unit: string;
  available_qty: number;
};

type WastageRecord = {
  id: string;
  item_id: string;
  item_name: string;
  qty: number;
  unit: string;
  reason: string;
  notes: string | null;
  wastage_date: string;
  created_at: string;
  cost_paise: number | null;
};

const reasons = ['EXPIRED', 'SPOILED', 'BURNT', 'SPILLED', 'DAMAGED', 'STAFF_MEAL', 'OTHER'];

const formatCost = (paise: number | null) => paise === null
  ? '—'
  : `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export default function InventoryWastagePage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [canRecord, setCanRecord] = useState(false);
  const [canViewCost, setCanViewCost] = useState(false);
  const [items, setItems] = useState<WastageItem[]>([]);
  const [records, setRecords] = useState<WastageRecord[]>([]);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState(reasons[0]);
  const [notes, setNotes] = useState('');
  const [wastageDate, setWastageDate] = useState(new Date().toISOString().slice(0, 10));
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
      const [wastagePermission, costPermission] = await Promise.all([
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_WASTAGE',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_COST_VIEW',
        }),
      ]);
      if (wastagePermission.error) throw wastagePermission.error;
      if (costPermission.error) throw costPermission.error;
      setCanRecord(Boolean(wastagePermission.data));
      setCanViewCost(Boolean(costPermission.data));

      const [itemRows, wastageRows] = await Promise.all([
        wastagePermission.data
          ? supabase.rpc('inventory_list_wastage_items', { p_branch_id: branch.id })
          : Promise.resolve({ data: [], error: null }),
        wastagePermission.data || costPermission.data
          ? supabase.rpc('inventory_list_wastage', {
            p_branch_id: branch.id,
            p_limit: 100,
            p_offset: 0,
          })
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (itemRows.error) throw itemRows.error;
      if (wastageRows.error) throw wastageRows.error;
      const nextItems = (itemRows.data ?? []) as WastageItem[];
      setItems(nextItems);
      setRecords((wastageRows.data ?? []) as WastageRecord[]);
      setItemId((current) => nextItems.some((item) => item.id === current) ? current : nextItems[0]?.id ?? '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load wastage records.');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  const selectedItem = items.find((item) => item.id === itemId);
  const parsedQty = Number(qty);
  const quantityValid = Number.isFinite(parsedQty) && parsedQty > 0
    && Boolean(selectedItem) && parsedQty <= Number(selectedItem?.available_qty ?? 0);

  async function recordWastage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canRecord || !selectedItem || !quantityValid || !branchId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const requestPayload = {
        branchId,
        itemId: selectedItem.id,
        qty: parsedQty,
        unit: selectedItem.base_unit,
        reason,
        notes: notes.trim() || null,
        wastageDate,
      };
      const storageKey = `tablely-wastage-request:${branchId}`;
      const fingerprint = JSON.stringify(requestPayload);
      const storedRequest = sessionStorage.getItem(storageKey);
      let idempotencyKey: string;
      if (storedRequest) {
        const previous = JSON.parse(storedRequest) as { fingerprint?: string; idempotencyKey?: string };
        idempotencyKey = previous.fingerprint === fingerprint && previous.idempotencyKey
          ? previous.idempotencyKey
          : crypto.randomUUID();
      } else {
        idempotencyKey = crypto.randomUUID();
      }
      sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, idempotencyKey }));
      const result = await supabase.rpc('inventory_record_wastage', {
        p_idempotency_key: idempotencyKey,
        p_branch_id: branchId,
        p_item_id: selectedItem.id,
        p_qty: parsedQty,
        p_unit: selectedItem.base_unit,
        p_reason: reason,
        p_notes: notes.trim() || null,
        p_wastage_date: wastageDate,
      });
      if (result.error) throw result.error;
      sessionStorage.removeItem(storageKey);
      setQty('');
      setNotes('');
      setNotice('Wastage recorded and stock adjusted.');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not record wastage.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Wastage"
          description={`${branchName || 'Your branch'} · Record spoilage and stock loss`}
          action={
            <div className="inventory-actions">
              <Link className="button button-light" href="/inventory">Inventory</Link>
              <Link className="button button-light" href="/inventory/counts">Stock counts</Link>
              <button type="button" className="button button-light" onClick={() => void load()} disabled={loading}>
                <RefreshCw size={15} /> Refresh
              </button>
            </div>
          }
        />
        {error && <div className="inventory-error" role="alert">{error}</div>}
        {notice && <div className="inventory-alert-strip" role="status">{notice}</div>}

        {canRecord && <form className="inventory-create" onSubmit={(event) => void recordWastage(event)}>
          <div className="inventory-create-heading">
            <div><span className="inventory-kicker">NEW RECORD</span><h2><AlertTriangle size={17} /> Record wastage</h2></div>
          </div>
          <div className="inventory-form-grid">
            <label>Ingredient
              <select value={itemId} onChange={(event) => setItemId(event.target.value)} required>
                {items.length === 0 && <option value="">No active ingredients</option>}
                {items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.available_qty} {item.base_unit} available</option>)}
              </select>
            </label>
            <label>Quantity
              <input type="number" min="0.0001" step="0.0001" max={selectedItem?.available_qty ?? undefined} value={qty} onChange={(event) => setQty(event.target.value)} required />
              {selectedItem && <small>Available: {selectedItem.available_qty} {selectedItem.base_unit}</small>}
            </label>
            <label>Reason
              <select value={reason} onChange={(event) => setReason(event.target.value)}>
                {reasons.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
              </select>
            </label>
            <label>Date
              <input type="date" value={wastageDate} onChange={(event) => setWastageDate(event.target.value)} required />
            </label>
            <label className="inventory-recipe-description">Notes <span className="inventory-optional">OPTIONAL</span>
              <input type="text" maxLength={500} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add context for the stock record" />
            </label>
          </div>
          <div className="inventory-form-footer">
            <span>Stock will be deducted immediately. This action is recorded in the stock ledger.</span>
            <button className="button button-primary" disabled={busy || !quantityValid || items.length === 0}>
              <Plus size={15} /> {busy ? 'Recording…' : 'Record wastage'}
            </button>
          </div>
        </form>}

        {!canRecord && !canViewCost && !loading && (
          <div className="inventory-error" role="alert">You need inventory wastage or cost-view permission to access this page.</div>
        )}

        <section className="inventory-card">
          <div className="inventory-list-heading">
            <div><span className="inventory-kicker">AUDIT LOG</span><h2>Recent wastage <span>{records.length}</span></h2></div>
          </div>
          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <thead><tr><th>Date</th><th>Ingredient</th><th>Quantity</th><th>Reason</th>{canViewCost && <th>Cost</th>}<th>Notes</th></tr></thead>
              <tbody>
                {loading ? <tr><td className="inventory-empty" colSpan={canViewCost ? 6 : 5}>Loading wastage…</td></tr>
                  : records.length === 0 ? <tr><td className="inventory-empty" colSpan={canViewCost ? 6 : 5}>No wastage records found.</td></tr>
                    : records.map((record) => <tr key={record.id}>
                      <td>{new Date(`${record.wastage_date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                      <td><strong>{record.item_name}</strong></td>
                      <td>{Number(record.qty).toLocaleString('en-IN')} {record.unit}</td>
                      <td>{record.reason.replaceAll('_', ' ')}</td>
                      {canViewCost && <td>{formatCost(record.cost_paise)}</td>}
                      <td>{record.notes || '—'}</td>
                    </tr>)}
              </tbody>
            </table>
          </div>
          <p className="inventory-list-footnote">{records.length === 100 ? 'Showing the latest 100 records.' : `${records.length} record${records.length === 1 ? '' : 's'} shown.`}</p>
        </section>
      </main>
    </StudioShell>
  );
}
