'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw, ShoppingCart, X } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { extractErrorMessage } from '@/lib/inventory-errors';
import '../inventory.css';

type Supplier = {
  id: string;
  company_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean;
};
type Item = { id: string; name: string; purchase_unit: string };
type PurchaseOrder = {
  id: string;
  po_number: string;
  status: string;
  supplier_name: string;
  expected_delivery_date: string | null;
  total_paise: number;
  created_at: string;
};
type LineDraft = { itemId: string; quantity: string; price: string };

function parsePaise(value: string): number | null {
  const match = value.trim().match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(paise) ? paise : null;
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InventoryPurchasesPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  const [canPurchase, setCanPurchase] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supplierForm, setSupplierForm] = useState({ name: '', contact: '', phone: '', email: '' });
  const [orderForm, setOrderForm] = useState({ supplierId: '', deliveryDate: '' });
  const [lines, setLines] = useState<LineDraft[]>([{ itemId: '', quantity: '', price: '' }]);

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
      setOrganizationId(context.data.organization.id);
      setBranchName(branch.name);
      setIsOwner(context.data.staff.role === 'OWNER');

      const [purchasePermission, viewPermission, suppliersResult, ordersResult] = await Promise.all([
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_PURCHASE',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_VIEW',
        }),
        supabase.rpc('inventory_list_suppliers', {
          p_organization_id: context.data.organization.id,
        }),
        supabase.rpc('inventory_list_purchase_orders', {
          p_branch_id: branch.id,
          p_status: null,
          p_limit: 100,
          p_offset: 0,
        }),
      ]);
      if (purchasePermission.error) throw purchasePermission.error;
      if (viewPermission.error) throw viewPermission.error;
      if (!purchasePermission.data) throw new Error('You do not have purchase permission for this branch.');
      if (suppliersResult.error) throw suppliersResult.error;
      if (ordersResult.error) throw ordersResult.error;
      const itemsResult = viewPermission.data
        ? await supabase.rpc('inventory_list_items', {
          p_branch_id: branch.id,
          p_search: null,
          p_status: 'ALL',
          p_limit: 500,
          p_offset: 0,
        })
        : { data: [], error: null };
      if (itemsResult.error) throw itemsResult.error;
      setCanPurchase(true);
      setSuppliers(((suppliersResult.data ?? []) as Supplier[]).filter((supplier) => supplier.is_active));
      setOrders((ordersResult.data ?? []) as PurchaseOrder[]);
      setItems(((itemsResult.data ?? []) as Item[]).filter((item) => item.purchase_unit));
    } catch (loadError) {
      setError(extractErrorMessage(loadError, 'Could not load purchasing.'));
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canPurchase || !organizationId) return;
    const name = supplierForm.name.trim();
    if (!name) {
      setError('Supplier name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await supabase.rpc('inventory_upsert_supplier', {
        p_organization_id: organizationId,
        p_id: null,
        p_company_name: name,
        p_contact_name: supplierForm.contact.trim() || null,
        p_phone: supplierForm.phone.trim() || null,
        p_email: supplierForm.email.trim() || null,
        p_is_active: true,
      });
      if (result.error) throw result.error;
      setSupplierForm({ name: '', contact: '', phone: '', email: '' });
      setShowSupplierForm(false);
      await load();
    } catch (saveError) {
      setError(extractErrorMessage(saveError, 'Could not save supplier.'));
    } finally {
      setSaving(false);
    }
  }

  async function createOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canPurchase || !branchId || !orderForm.supplierId) return;
    const parsedLines = lines.map((line) => ({
      item_id: line.itemId,
      ordered_qty: Number(line.quantity),
      purchase_unit: items.find((item) => item.id === line.itemId)?.purchase_unit ?? '',
      agreed_unit_price_paise: parsePaise(line.price),
      discount_pct: 0,
      tax_pct: 0,
    }));
    if (parsedLines.length === 0
      || parsedLines.some((line) => !line.item_id || !Number.isFinite(line.ordered_qty)
        || line.ordered_qty <= 0 || line.agreed_unit_price_paise === null)) {
      setError('Select an item and enter a positive quantity and a price with up to two decimal places.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await supabase.rpc('inventory_upsert_purchase_order', {
        p_branch_id: branchId,
        p_supplier_id: orderForm.supplierId,
        p_id: null,
        p_expected_delivery_date: orderForm.deliveryDate || null,
        p_notes: null,
        p_lines: parsedLines,
      });
      if (result.error) throw result.error;
      setShowOrderForm(false);
      setOrderForm({ supplierId: '', deliveryDate: '' });
      setLines([{ itemId: '', quantity: '', price: '' }]);
      await load();
    } catch (saveError) {
      setError(extractErrorMessage(saveError, 'Could not create purchase order.'));
    } finally {
      setSaving(false);
    }
  }

  async function advanceOrder(order: PurchaseOrder, status: string) {
    if (!supabase) return;
    setError(null);
    const { error: statusError } = await supabase.rpc('inventory_advance_po_status', {
      p_po_id: order.id,
      p_new_status: status,
    });
    if (statusError) {
      setError(statusError.message);
      return;
    }
    await load();
  }

  async function cancelOrder(order: PurchaseOrder) {
    if (!supabase || !window.confirm(`Cancel purchase order ${order.po_number}?`)) return;
    setError(null);
    const { error: cancelError } = await supabase.rpc('inventory_upsert_purchase_order', {
      p_branch_id: branchId,
      p_supplier_id: null,
      p_id: order.id,
      p_status: 'CANCELLED',
      p_cancellation_reason: 'Cancelled by authorized staff',
      p_lines: [],
    });
    if (cancelError) {
      setError(cancelError.message);
      return;
    }
    await load();
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Purchasing"
          description={`${branchName || 'Your branch'} · Suppliers and purchase orders`}
          action={
            <div className="inventory-actions">
              <Link className="button button-light" href="/inventory">Inventory</Link>
              <Link className="button button-light" href="/inventory/receiving">Goods receiving</Link>
              <button type="button" className="button button-light" onClick={() => void load()} disabled={loading}>
                <RefreshCw size={15} /> Refresh
              </button>
              {canPurchase && <button type="button" className="button button-light" onClick={() => setShowSupplierForm((open) => !open)}>
                <Plus size={15} /> Supplier
              </button>}
              {canPurchase && <button type="button" className="button button-primary" onClick={() => setShowOrderForm((open) => !open)} disabled={suppliers.length === 0 || items.length === 0}>
                <ShoppingCart size={15} /> Create PO
              </button>}
            </div>
          }
        />

        {error && <div className="inventory-error" role="alert">{error}</div>}
        {canPurchase && items.length === 0 && <p className="inventory-list-footnote">Purchase-order item selection requires active ingredients and inventory view permission.</p>}

        {showSupplierForm && canPurchase && (
          <section className="inventory-create">
            <div className="inventory-create-heading">
              <div><span className="inventory-kicker">SUPPLIER DIRECTORY</span><h2>Add supplier</h2></div>
              <button type="button" className="button button-light" aria-label="Close supplier form" onClick={() => setShowSupplierForm(false)}><X size={16} /></button>
            </div>
            <form onSubmit={(event) => void createSupplier(event)}>
              <div className="inventory-form-grid">
                <label>Company name<input value={supplierForm.name} onChange={(event) => setSupplierForm({ ...supplierForm, name: event.target.value })} required maxLength={160} /></label>
                <label>Contact name<input value={supplierForm.contact} onChange={(event) => setSupplierForm({ ...supplierForm, contact: event.target.value })} maxLength={120} /></label>
                <label>Phone<input value={supplierForm.phone} onChange={(event) => setSupplierForm({ ...supplierForm, phone: event.target.value })} maxLength={40} /></label>
                <label>Email<input type="email" value={supplierForm.email} onChange={(event) => setSupplierForm({ ...supplierForm, email: event.target.value })} maxLength={254} /></label>
              </div>
              <div className="inventory-form-footer"><span>Supplier details are restricted to staff with purchase permission.</span><button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save supplier'}</button></div>
            </form>
          </section>
        )}

        {showOrderForm && canPurchase && (
          <section className="inventory-create">
            <div className="inventory-create-heading">
              <div><span className="inventory-kicker">PURCHASE ORDER</span><h2>New draft</h2></div>
              <button type="button" className="button button-light" aria-label="Close purchase order form" onClick={() => setShowOrderForm(false)}><X size={16} /></button>
            </div>
            <form onSubmit={(event) => void createOrder(event)}>
              <div className="inventory-form-grid">
                <label>Supplier
                  <select value={orderForm.supplierId} onChange={(event) => setOrderForm({ ...orderForm, supplierId: event.target.value })} required>
                    <option value="">Select supplier</option>
                    {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.company_name}</option>)}
                  </select>
                </label>
                <label>Expected delivery<input type="date" value={orderForm.deliveryDate} onChange={(event) => setOrderForm({ ...orderForm, deliveryDate: event.target.value })} /></label>
              </div>
              <div className="inventory-recipe-lines">
                <div className="inventory-create-heading">
                  <div><span className="inventory-kicker">ORDER LINES</span><h2>Items and agreed prices</h2></div>
                  <button type="button" className="button button-light" onClick={() => setLines((current) => [...current, { itemId: '', quantity: '', price: '' }])}><Plus size={15} /> Add item</button>
                </div>
                {lines.map((line, index) => {
                  const item = items.find((candidate) => candidate.id === line.itemId);
                  return <div className="inventory-recipe-line" key={`po-line-${index}`}>
                    <label>Ingredient
                      <select value={line.itemId} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, itemId: event.target.value } : row))} required>
                        <option value="">Select item</option>
                        {items.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.purchase_unit}</option>)}
                      </select>
                    </label>
                    <label>Quantity ({item?.purchase_unit ?? 'unit'})
                      <input type="number" min="0.0001" step="0.0001" value={line.quantity} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, quantity: event.target.value } : row))} required />
                    </label>
                    <label>Unit price (₹)
                      <input inputMode="decimal" value={line.price} onChange={(event) => setLines((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, price: event.target.value } : row))} placeholder="0.00" required />
                    </label>
                    <button type="button" className="button button-light inventory-recipe-remove" aria-label={`Remove PO line ${index + 1}`} disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, rowIndex) => rowIndex !== index))}><X size={15} /></button>
                  </div>;
                })}
              </div>
              <div className="inventory-form-footer"><span>Totals are calculated and stored by the server in paise.</span><button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save draft PO'}</button></div>
            </form>
          </section>
        )}

        <section className="inventory-card">
          <div className="inventory-list-heading">
            <div><span className="inventory-kicker">PROCUREMENT</span><h2>Purchase orders <span>{orders.length}</span></h2></div>
          </div>
          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <thead><tr><th>Order</th><th>Supplier</th><th>Expected</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead>
              <tbody>
                {loading ? <tr><td className="inventory-empty" colSpan={6}>Loading purchase orders…</td></tr>
                  : orders.length === 0 ? <tr><td className="inventory-empty" colSpan={6}>No purchase orders yet.</td></tr>
                    : orders.map((order) => <tr key={order.id}>
                      <td><strong>{order.po_number}</strong><small>{new Date(order.created_at).toLocaleDateString('en-IN')}</small></td>
                      <td>{order.supplier_name}</td>
                      <td>{order.expected_delivery_date ? new Date(`${order.expected_delivery_date}T00:00:00`).toLocaleDateString('en-IN') : '—'}</td>
                      <td><span className="inventory-status inventory-status-healthy">{order.status.replaceAll('_', ' ')}</span></td>
                      <td>{inr(Number(order.total_paise))}</td>
                      <td><div className="inventory-actions">
                        {order.status === 'DRAFT' && <button type="button" className="button button-light" onClick={() => void advanceOrder(order, 'PENDING_APPROVAL')}>Submit</button>}
                        {order.status === 'PENDING_APPROVAL' && <button type="button" className="button button-light" onClick={() => void advanceOrder(order, 'APPROVED')}>Approve</button>}
                        {order.status === 'DRAFT' && isOwner && <button type="button" className="button button-light" onClick={() => void advanceOrder(order, 'APPROVED')}>Approve</button>}
                        {order.status === 'APPROVED' && <button type="button" className="button button-light" onClick={() => void advanceOrder(order, 'SENT')}>Mark sent</button>}
                        {['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(order.status) && <button type="button" className="button button-light" onClick={() => void cancelOrder(order)}>Cancel</button>}
                      </div></td>
                    </tr>)}
              </tbody>
            </table>
          </div>
          <p className="inventory-list-footnote">Purchase-order entry, supplier management, and status transitions are server-authorized. Goods-receipt entry is not yet available in this screen.</p>
        </section>
      </main>
    </StudioShell>
  );
}
