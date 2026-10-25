'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ClipboardPlus, PackageCheck, RefreshCw } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import '../inventory.css';

type PurchaseOrder = { id: string; po_number: string; status: string; supplier_id: string; supplier_name: string };
type PurchaseOrderLine = {
  id: string;
  item_id: string;
  ordered_qty: number;
  received_qty: number;
  purchase_unit: string;
  agreed_unit_price_paise: number | null;
};
type ReceiptDraft = {
  lineId: string;
  receivedQty: string;
  damagedQty: string;
  unitPrice: string;
  locationId: string;
  batchNumber: string;
  expiresAt: string;
};
type GrnLineInput = {
  item_id: string;
  po_line_id: string;
  location_id: string | null;
  ordered_qty: number;
  received_qty: number;
  damaged_qty: number;
  accepted_qty: number;
  purchase_unit: string;
  actual_unit_price_paise: number;
  batch_number: string | null;
  manufactured_at: null;
  expires_at: string | null;
  notes: null;
};
type Receipt = {
  id: string;
  grn_number: string;
  status: string;
  received_date: string;
  total_accepted_value_paise: number | null;
  supplier_invoice_number: string | null;
  supplier_id: string;
};
type Location = { id: string; name: string };

function toPaise(input: string): number | null {
  const value = input.trim().match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!value) return null;
  const paise = Number(value[1]) * 100 + Number((value[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

const money = (paise: number | null) => paise == null
  ? 'Restricted'
  : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InventoryReceivingPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [canReceive, setCanReceive] = useState(false);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedPoId, setSelectedPoId] = useState('');
  const [selectedPoData, setSelectedPoData] = useState<PurchaseOrder | null>(null);
  const [poLines, setPoLines] = useState<PurchaseOrderLine[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ReceiptDraft>>({});
  const [loading, setLoading] = useState(true);
  const [loadingLines, setLoadingLines] = useState(false);
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
      const permission = await supabase.rpc('current_user_has_permission_for_branch', {
        p_branch_id: branch.id,
        p_permission: 'INVENTORY_RECEIVE',
      });
      if (permission.error) throw permission.error;
      if (!permission.data) throw new Error('You do not have goods-receiving permission for this branch.');
      setCanReceive(true);

      const [poResult, grnResult, locationResult] = await Promise.all([
        supabase.rpc('inventory_list_receivable_purchase_orders', { p_branch_id: branch.id }),
        supabase.rpc('inventory_list_pending_grns', { p_branch_id: branch.id }),
        supabase.rpc('inventory_list_receiving_locations', { p_branch_id: branch.id }),
      ]);
      if (poResult.error) throw poResult.error;
      if (grnResult.error) throw grnResult.error;
      if (locationResult.error) throw locationResult.error;
      setPurchaseOrders((poResult.data ?? []) as PurchaseOrder[]);
      setReceipts((grnResult.data ?? []) as Receipt[]);
      setLocations((locationResult.data ?? []) as Location[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load goods receiving.');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => { void load(); }, [load]);

  async function selectPurchaseOrder(poId: string) {
    if (!supabase) return;
    setSelectedPoId(poId);
    setSelectedPoData(null);
    setPoLines([]);
    setDrafts({});
    if (!poId) return;
    const purchaseOrder = purchaseOrders.find((po) => po.id === poId);
    if (!purchaseOrder) {
      setError('Selected purchase order is no longer available.');
      return;
    }
    setSelectedPoData(purchaseOrder);
    setLoadingLines(true);
    setError(null);
    try {
      const lineResult = await supabase.rpc('inventory_list_receivable_po_lines', { p_po_id: poId });
      if (lineResult.error) throw lineResult.error;
      const remaining = (lineResult.data ?? []) as PurchaseOrderLine[];
      setPoLines(remaining);
      setDrafts(Object.fromEntries(remaining.map((line) => [line.id, {
        lineId: line.id,
        receivedQty: '',
        damagedQty: '0',
        unitPrice: line.agreed_unit_price_paise == null ? '' : (Number(line.agreed_unit_price_paise) / 100).toFixed(2),
        locationId: '',
        batchNumber: '',
        expiresAt: '',
      }])));
      if (remaining.length === 0) setNotice('This purchase order has no remaining quantities.');
    } catch (lineError) {
      setError(lineError instanceof Error ? lineError.message : 'Could not load purchase order lines.');
    } finally {
      setLoadingLines(false);
    }
  }

  async function createReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canReceive || !selectedPoId || !selectedPoData) return;
    const lines = poLines.flatMap((line): Array<GrnLineInput | { invalid: true }> => {
      const draft = drafts[line.id];
      const received = Number(draft?.receivedQty ?? 0);
      if (!Number.isFinite(received) || received === 0) return [];
      const damaged = Number(draft.damagedQty);
      const price = toPaise(draft.unitPrice);
      if (!Number.isFinite(damaged) || damaged < 0 || damaged > received || price === null
        || received > Number(line.ordered_qty) - Number(line.received_qty)) {
        return [{ invalid: true }];
      }
      return [{
        item_id: line.item_id,
        po_line_id: line.id,
        location_id: draft.locationId || null,
        ordered_qty: Number(line.ordered_qty),
        received_qty: received,
        damaged_qty: damaged,
        accepted_qty: received - damaged,
        purchase_unit: line.purchase_unit,
        actual_unit_price_paise: price,
        batch_number: draft.batchNumber.trim() || null,
        manufactured_at: null,
        expires_at: draft.expiresAt || null,
        notes: null,
      }];
    });
    if (lines.length === 0 || lines.some((line) => 'invalid' in line)) {
      setError('Enter valid received quantities up to the remaining PO amount, damaged quantity, and unit price.');
      return;
    }
    const validLines = lines.filter((line): line is GrnLineInput => !('invalid' in line));
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await supabase.rpc('inventory_create_grn', {
        p_branch_id: branchId,
        p_supplier_id: selectedPoData.supplier_id,
        p_purchase_order_id: selectedPoId,
        p_received_date: new Date().toISOString().slice(0, 10),
        p_supplier_invoice_number: null,
        p_supplier_invoice_date: null,
        p_notes: null,
        p_lines: validLines,
      });
      if (result.error) throw result.error;
      setSelectedPoId('');
      setSelectedPoId('');
      setPoLines([]);
      setDrafts({});
      setNotice('Goods receipt saved as a draft. Approve it below to add accepted stock to inventory.');
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not save goods receipt.');
    } finally {
      setBusy(false);
    }
  }

  async function approveReceipt(receipt: Receipt) {
    if (!supabase || !window.confirm(`Approve ${receipt.grn_number}? Accepted quantities will be posted to the stock ledger.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await supabase.rpc('inventory_approve_grn', { p_grn_id: receipt.id });
      if (result.error) throw result.error;
      setNotice(`${receipt.grn_number} approved and received stock posted.`);
      await load();
    } catch (approveError) {
      setError(approveError instanceof Error ? approveError.message : 'Could not approve goods receipt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Goods receiving"
          description={`${branchName || 'Your branch'} · Receive approved purchase orders into stock`}
          action={<div className="inventory-actions">
            <Link className="button button-light" href="/inventory">Inventory</Link>
            <Link className="button button-light" href="/inventory/purchases">Purchasing</Link>
            <button type="button" className="button button-light" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
          </div>}
        />
        {error && <div className="inventory-error" role="alert">{error}</div>}
        {notice && <div className="inventory-alert-strip" role="status">{notice}</div>}

        {canReceive && <section className="inventory-create">
          <div className="inventory-create-heading">
            <div><span className="inventory-kicker">RECEIVE STOCK</span><h2><ClipboardPlus size={17} /> New goods receipt</h2></div>
          </div>
          {purchaseOrders.length === 0
            ? <p className="inventory-list-footnote">No approved or sent purchase orders are available for receiving.</p>
            : <form onSubmit={(event) => void createReceipt(event)}>
              <div className="inventory-form-grid">
                <label>Purchase order
                  <select value={selectedPoId} onChange={(event) => void selectPurchaseOrder(event.target.value)} required>
                    <option value="">Select a purchase order</option>
                    {purchaseOrders.map((po) => <option key={po.id} value={po.id}>{po.po_number} · {po.supplier_name} · {po.status.replaceAll('_', ' ')}</option>)}
                  </select>
                </label>
              </div>
              {loadingLines && <p className="inventory-list-footnote">Loading remaining order lines…</p>}
              {selectedPoData && poLines.length > 0 && <>
                <div className="inventory-recipe-lines">
                  {poLines.map((line) => {
                    const draft = drafts[line.id];
                    return <div className="inventory-recipe-line inventory-receipt-line" key={line.id}>
                      <div><strong>Item {line.item_id.slice(0, 8)}</strong><small>{Number(line.ordered_qty) - Number(line.received_qty)} {line.purchase_unit} remaining</small></div>
                      <label>Received ({line.purchase_unit})
                        <input type="number" min="0" max={Number(line.ordered_qty) - Number(line.received_qty)} step="0.0001" value={draft?.receivedQty ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], receivedQty: event.target.value } }))} />
                      </label>
                      <label>Damaged
                        <input type="number" min="0" step="0.0001" value={draft?.damagedQty ?? '0'} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], damagedQty: event.target.value } }))} />
                      </label>
                      <label>Unit price (₹)
                        <input inputMode="decimal" value={draft?.unitPrice ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], unitPrice: event.target.value } }))} />
                      </label>
                      <label>Location
                        <select value={draft?.locationId ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], locationId: event.target.value } }))}>
                          <option value="">No location</option>
                          {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                        </select>
                      </label>
                      <label>Batch
                        <input value={draft?.batchNumber ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], batchNumber: event.target.value } }))} maxLength={80} />
                      </label>
                      <label>Expiry
                        <input type="date" value={draft?.expiresAt ?? ''} onChange={(event) => setDrafts((current) => ({ ...current, [line.id]: { ...current[line.id], expiresAt: event.target.value } }))} />
                      </label>
                    </div>;
                  })}
                </div>
                <div className="inventory-form-footer"><span>Only approving a draft posts accepted goods and stock movements.</span><button className="button button-primary" disabled={busy}>{busy ? 'Saving…' : 'Save receipt draft'}</button></div>
              </>}
            </form>}
        </section>}

        <section className="inventory-card">
          <div className="inventory-list-heading"><div><span className="inventory-kicker">PENDING POSTING</span><h2>Draft goods receipts <span>{receipts.length}</span></h2></div></div>
          <div className="inventory-table-wrap"><table className="inventory-table">
            <thead><tr><th>GRN</th><th>Received</th><th>Invoice</th><th>Accepted value</th><th>Action</th></tr></thead>
            <tbody>{loading ? <tr><td className="inventory-empty" colSpan={5}>Loading receipts…</td></tr>
              : receipts.length === 0 ? <tr><td className="inventory-empty" colSpan={5}>No pending goods receipts.</td></tr>
                : receipts.map((receipt) => <tr key={receipt.id}>
                  <td><strong>{receipt.grn_number}</strong><small>{receipt.status}</small></td>
                  <td>{new Date(`${receipt.received_date}T00:00:00`).toLocaleDateString('en-IN')}</td>
                  <td>{receipt.supplier_invoice_number || '—'}</td>
                  <td>{money(Number(receipt.total_accepted_value_paise))}</td>
                  <td><button type="button" className="button button-primary" onClick={() => void approveReceipt(receipt)} disabled={busy}><PackageCheck size={15} /> Approve & receive</button></td>
                </tr>)}</tbody>
          </table></div>
          <p className="inventory-list-footnote">Approval is the only action that adds received stock to the ledger.</p>
        </section>
      </main>
    </StudioShell>
  );
}
