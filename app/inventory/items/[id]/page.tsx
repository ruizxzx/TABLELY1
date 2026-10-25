'use client';

import { use, useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowLeft, Pencil, RefreshCw, Save, X } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { extractErrorMessage } from '@/lib/inventory-errors';
import '../../inventory.css';

type Props = { params: Promise<{ id: string }> };
type InventoryItem = {
  id: string;
  organization_id: string;
  name: string;
  sku: string | null;
  description: string | null;
  category_id: string | null;
  base_unit: string;
  purchase_unit: string;
  purchase_unit_conversion: number;
  reorder_level: number | null;
  target_stock_level: number | null;
  track_expiry: boolean;
  track_batches: boolean;
  preferred_supplier_id: string | null;
  tax_rate_pct: number | null;
  hsn_code: string | null;
  is_active: boolean;
};
type Balance = {
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
  avg_unit_cost_paise?: number;
  stock_value_paise?: number;
};
type ItemDetails = { item: InventoryItem; category_name: string | null; balance: Balance | null };
type Batch = {
  id: string;
  batch_number: string | null;
  manufactured_at: string | null;
  expires_at: string | null;
  received_qty: number;
  current_qty: number;
  unit_cost_paise: number | null;
  location_name: string | null;
  received_at: string;
  is_active: boolean;
};
type Movement = {
  id: string;
  movement_type: string;
  qty: number;
  unit: string;
  unit_cost_paise: number | null;
  total_cost_paise: number | null;
  source_event_type: string | null;
  notes: string | null;
  created_at: string;
};
type Supplier = {
  supplier_id: string;
  company_name: string;
  supplier_item_code: string | null;
  price_unit: string;
  unit_price_paise: number | null;
  is_preferred: boolean;
  updated_at: string;
};

type PriceHistory = {
  id: string;
  supplier_id: string;
  supplier_name: string;
  price_paise: number;
  price_unit: string;
  effective_date: string;
  created_at: string;
};
type RecipeUsage = {
  recipe_id: string;
  recipe_name: string;
  menu_item_name: string | null;
  version_number: number;
  qty_per_serving: number;
  unit: string;
  yield_pct: number;
};
type Tab = 'overview' | 'batches' | 'movements' | 'suppliers' | 'recipes';
type EditForm = {
  name: string;
  sku: string;
  description: string;
  categoryId: string;
  baseUnit: string;
  purchaseUnit: string;
  conversion: string;
  reorderLevel: string;
  targetStock: string;
  trackExpiry: boolean;
  trackBatches: boolean;
  preferredSupplierId: string;
  taxRate: string;
  hsnCode: string;
};
type Category = { id: string; name: string };
type SupplierOption = { id: string; company_name: string };

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'batches', label: 'Batches' },
  { id: 'movements', label: 'Movements' },
  { id: 'suppliers', label: 'Suppliers' },
  { id: 'recipes', label: 'Recipe usage' },
];

const currency = (paise: number | null | undefined) => paise == null
  ? '—'
  : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const emptyForm: EditForm = {
  name: '',
  sku: '',
  description: '',
  categoryId: '',
  baseUnit: '',
  purchaseUnit: '',
  conversion: '1',
  reorderLevel: '',
  targetStock: '',
  trackExpiry: false,
  trackBatches: false,
  preferredSupplierId: '',
  taxRate: '',
  hsnCode: '',
};

export default function InventoryItemDetailPage({ params }: Props) {
  const { id: itemId } = use(params);
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canViewCost, setCanViewCost] = useState(false);
  const [canViewSuppliers, setCanViewSuppliers] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [supplierOptions, setSupplierOptions] = useState<SupplierOption[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [priceHistory, setPriceHistory] = useState<PriceHistory[]>([]);
  const [recipeUsage, setRecipeUsage] = useState<RecipeUsage[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm>(emptyForm);
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadItem = useCallback(async () => {
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    const client = supabase as NonNullable<typeof supabase>;
    setLoading(true);
    setError(null);
    try {
      const context = await getCurrentRestaurantContext(client);
      if (!context.data) throw context.error ?? new Error('Restaurant workspace not found.');
      const branch = context.data.branch;
      setBranchId(branch.id);
      setBranchName(branch.name);
      const [view, manage, cost, purchase] = await Promise.all([
        client.rpc('current_user_has_permission_for_branch', { p_branch_id: branch.id, p_permission: 'INVENTORY_VIEW' }),
        client.rpc('current_user_has_permission_for_branch', { p_branch_id: branch.id, p_permission: 'INVENTORY_MANAGEMENT' }),
        client.rpc('current_user_has_permission_for_branch', { p_branch_id: branch.id, p_permission: 'INVENTORY_COST_VIEW' }),
        client.rpc('current_user_has_permission_for_branch', { p_branch_id: branch.id, p_permission: 'INVENTORY_PURCHASE' }),
      ]);
      for (const response of [view, manage, cost, purchase]) {
        if (response.error) throw response.error;
      }
      if (!view.data) throw new Error('You do not have inventory view permission for this branch.');
      const [detail, categoryRows, supplierRows] = await Promise.all([
        client.rpc('inventory_get_item_detail', { p_item_id: itemId, p_branch_id: branch.id }),
        client.from('inventory_categories').select('id,name').eq('organization_id', context.data.organization.id).order('sort_order').order('name'),
        purchase.data || cost.data
          ? client.rpc('inventory_list_suppliers', { p_organization_id: context.data.organization.id })
          : Promise.resolve({ data: [], error: null }),
      ]);
      for (const response of [detail, categoryRows, supplierRows]) {
        if (response.error) throw response.error;
      }
      setCanManage(Boolean(manage.data));
      setCanViewCost(Boolean(cost.data));
      setCanViewSuppliers(Boolean(purchase.data || cost.data));
      const next = detail.data as ItemDetails;
      setDetails(next);
      setForm({
        name: next.item.name,
        sku: next.item.sku ?? '',
        description: next.item.description ?? '',
        categoryId: next.item.category_id ?? '',
        baseUnit: next.item.base_unit,
        purchaseUnit: next.item.purchase_unit,
        conversion: String(next.item.purchase_unit_conversion),
        reorderLevel: next.item.reorder_level == null ? '' : String(next.item.reorder_level),
        targetStock: next.item.target_stock_level == null ? '' : String(next.item.target_stock_level),
        trackExpiry: next.item.track_expiry,
        trackBatches: next.item.track_batches,
        preferredSupplierId: next.item.preferred_supplier_id ?? '',
        taxRate: next.item.tax_rate_pct == null ? '' : String(next.item.tax_rate_pct),
        hsnCode: next.item.hsn_code ?? '',
      });
      setCategories((categoryRows.data ?? []) as Category[]);
      setSupplierOptions(((supplierRows.data ?? []) as SupplierOption[]).filter((supplier) =>
        Boolean((supplier as SupplierOption & { is_active?: boolean }).is_active)));
    } catch (loadError) {
      setError(extractErrorMessage(loadError, 'Could not load ingredient details.'));
      setDetails(null);
    } finally {
      setLoading(false);
    }
  }, [supabase, itemId]);

  useEffect(() => { void loadItem(); }, [loadItem]);

  useEffect(() => {
    if (!supabase || !branchId || !details || tab === 'overview') return;
    const client = supabase as NonNullable<typeof supabase>;
    let active = true;
    setTabLoading(true);
    setError(null);
    async function loadTab() {
      try {
        if (tab === 'batches') {
          const result = await client.rpc('inventory_list_item_batches', {
            p_item_id: itemId, p_branch_id: branchId, p_limit: 100,
          });
          if (result.error) throw result.error;
          if (active) setBatches((result.data ?? []) as Batch[]);
        } else if (tab === 'movements') {
          const result = await client.rpc('inventory_get_item_movements', {
            p_item_id: itemId, p_branch_id: branchId, p_limit: 100, p_offset: 0,
          });
          if (result.error) throw result.error;
          if (active) setMovements((result.data ?? []) as Movement[]);
        } else if (tab === 'suppliers') {
          if (!canViewSuppliers) throw new Error('Purchase or cost-view permission is required to view supplier details.');
          const [result, historyResult] = await Promise.all([
            client.rpc('inventory_list_item_suppliers', { p_item_id: itemId, p_branch_id: branchId }),
            client.rpc('inventory_get_supplier_price_history', { p_item_id: itemId, p_branch_id: branchId }),
          ]);
          if (result.error) throw result.error;
          if (active) {
            setSuppliers((result.data ?? []) as Supplier[]);
            setPriceHistory((historyResult?.data ?? []) as PriceHistory[]);
          }
        } else if (tab === 'recipes') {
          const result = await client.rpc('inventory_list_item_recipe_usage', {
            p_item_id: itemId, p_branch_id: branchId,
          });
          if (result.error) throw result.error;
          if (active) setRecipeUsage((result.data ?? []) as RecipeUsage[]);
        }
      } catch (tabError) {
        if (active) setError(extractErrorMessage(tabError, 'Could not load this ingredient view.'));
      } finally {
        if (active) setTabLoading(false);
      }
    }
    void loadTab();
    return () => { active = false; };
  }, [supabase, itemId, branchId, details, tab, canViewSuppliers]);

  async function saveItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !details || !canManage) return;
    const client = supabase as NonNullable<typeof supabase>;
    const conversion = Number(form.conversion);
    const reorder = form.reorderLevel.trim() ? Number(form.reorderLevel) : null;
    const target = form.targetStock.trim() ? Number(form.targetStock) : null;
    const tax = form.taxRate.trim() ? Number(form.taxRate) : null;
    if (!form.name.trim() || !form.baseUnit.trim() || !form.purchaseUnit.trim()
      || !Number.isFinite(conversion) || conversion <= 0
      || (reorder != null && (!Number.isFinite(reorder) || reorder < 0))
      || (target != null && (!Number.isFinite(target) || target < 0))
      || (tax != null && (!Number.isFinite(tax) || tax < 0 || tax > 100))) {
      setError('Check the name, units, conversion, stock thresholds, and tax rate.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await client.rpc('inventory_upsert_item', {
        p_organization_id: details.item.organization_id,
        p_id: itemId,
        p_name: form.name.trim(),
        p_sku: form.sku.trim() || null,
        p_description: form.description.trim() || null,
        p_category_id: form.categoryId || null,
        p_base_unit: details.item.base_unit,
        p_purchase_unit: form.purchaseUnit.trim(),
        p_purchase_unit_conversion: conversion,
        p_reorder_level: reorder,
        p_target_stock_level: target,
        p_track_expiry: form.trackExpiry,
        p_track_batches: form.trackBatches,
        p_preferred_supplier_id: form.preferredSupplierId || null,
        p_tax_rate_pct: tax,
        p_hsn_code: form.hsnCode.trim() || null,
        p_is_active: details.item.is_active,
      });
      if (result.error) throw result.error;
      setEditing(false);
      setNotice('Ingredient details saved.');
      await loadItem();
    } catch (saveError) {
      setError(extractErrorMessage(saveError, 'Could not save ingredient details.'));
    } finally {
      setSaving(false);
    }
  }

  const balance = details?.balance;

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title={details?.item.name ?? 'Ingredient'}
          description={`${branchName || 'Your branch'} · Ingredient detail, stock and audit history`}
          action={<div className="inventory-actions">
            <Link className="button button-light" href="/inventory"><ArrowLeft size={15} /> Inventory</Link>
            <button type="button" className="button button-light" onClick={() => void loadItem()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
            {canManage && details && !editing && <button type="button" className="button button-primary" onClick={() => setEditing(true)}><Pencil size={15} /> Edit ingredient</button>}
          </div>}
        />
        {error && <div className="inventory-error" role="alert">{error}</div>}
        {notice && <div className="inventory-alert-strip" role="status">{notice}</div>}
        {loading && <section className="inventory-card"><p className="inventory-list-footnote">Loading ingredient…</p></section>}
        {!loading && !details && <section className="inventory-card"><p className="inventory-list-footnote">Ingredient not found or unavailable to this branch.</p></section>}

        {details && <>
          {editing && <form className="inventory-create" onSubmit={(event) => void saveItem(event)}>
            <div className="inventory-create-heading"><div><span className="inventory-kicker">INGREDIENT MASTER</span><h2>Edit ingredient</h2></div>
              <button type="button" className="button button-light" onClick={() => { setEditing(false); setError(null); void loadItem(); }} aria-label="Cancel editing"><X size={15} /> Cancel</button>
            </div>
            <div className="inventory-form-grid">
              <label>Name<input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label>SKU<input maxLength={80} value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} /></label>
              <label>Category<select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}><option value="">Uncategorized</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <label>Stock unit<input value={details.item.base_unit} readOnly aria-describedby="base-unit-note" /><small id="base-unit-note">Changing stock units requires a controlled stock conversion.</small></label>
              <label>Purchase unit<input required maxLength={20} value={form.purchaseUnit} onChange={(event) => setForm({ ...form, purchaseUnit: event.target.value })} /></label>
              <label>Purchase unit equals<input required type="number" min="0.0001" step="0.0001" value={form.conversion} onChange={(event) => setForm({ ...form, conversion: event.target.value })} /></label>
              <label>Reorder at<input type="number" min="0" step="0.0001" value={form.reorderLevel} onChange={(event) => setForm({ ...form, reorderLevel: event.target.value })} /></label>
              <label>Target stock<input type="number" min="0" step="0.0001" value={form.targetStock} onChange={(event) => setForm({ ...form, targetStock: event.target.value })} /></label>
              <label>Preferred supplier<select value={form.preferredSupplierId} onChange={(event) => setForm({ ...form, preferredSupplierId: event.target.value })}><option value="">None</option>{supplierOptions.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.company_name}</option>)}</select></label>
              <label>Tax rate %<input type="number" min="0" max="100" step="0.01" value={form.taxRate} onChange={(event) => setForm({ ...form, taxRate: event.target.value })} /></label>
              <label>HSN code<input maxLength={20} value={form.hsnCode} onChange={(event) => setForm({ ...form, hsnCode: event.target.value })} /></label>
              <label className="inventory-recipe-description">Description<input maxLength={500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
              <label className="inventory-count-blind"><input type="checkbox" checked={form.trackExpiry} onChange={(event) => setForm({ ...form, trackExpiry: event.target.checked })} /> Track expiry dates</label>
              <label className="inventory-count-blind"><input type="checkbox" checked={form.trackBatches} onChange={(event) => setForm({ ...form, trackBatches: event.target.checked })} /> Require batches</label>
            </div>
            <div className="inventory-form-footer"><span>Unit changes do not rewrite historical stock movements; review recipe units before changing.</span><button className="button button-primary" disabled={saving}><Save size={15} /> {saving ? 'Saving…' : 'Save changes'}</button></div>
          </form>}

          <nav className="inventory-detail-tabs" aria-label="Ingredient details">
            {tabs.filter((entry) => entry.id !== 'suppliers' || canViewSuppliers).map((entry) => (
              <button key={entry.id} type="button" aria-pressed={tab === entry.id} className={tab === entry.id ? 'is-active' : ''} onClick={() => setTab(entry.id)}>{entry.label}</button>
            ))}
          </nav>

          {tab === 'overview' && <section className="inventory-metrics" aria-label="Stock summary">
            <article className="inventory-metric"><span className="inventory-metric-label">On hand</span><strong>{balance ? `${Number(balance.on_hand_qty).toLocaleString('en-IN')} ${details.item.base_unit}` : `0 ${details.item.base_unit}`}</strong></article>
            <article className="inventory-metric"><span className="inventory-metric-label">Reserved</span><strong>{balance ? `${Number(balance.reserved_qty).toLocaleString('en-IN')} ${details.item.base_unit}` : `0 ${details.item.base_unit}`}</strong></article>
            <article className="inventory-metric"><span className="inventory-metric-label">Available</span><strong>{balance ? `${Number(balance.available_qty).toLocaleString('en-IN')} ${details.item.base_unit}` : `0 ${details.item.base_unit}`}</strong></article>
            {canViewCost && <article className="inventory-metric"><span className="inventory-metric-label">Average unit cost</span><strong>{currency(balance?.avg_unit_cost_paise)}</strong></article>}
            <section className="inventory-card inventory-detail-summary">
              <div className="inventory-list-heading"><div><span className="inventory-kicker">INGREDIENT PROFILE</span><h2>{details.item.name}</h2></div></div>
              <dl className="inventory-detail-grid">
                <div><dt>SKU</dt><dd>{details.item.sku || '—'}</dd></div>
                <div><dt>Category</dt><dd>{details.category_name || 'Uncategorized'}</dd></div>
                <div><dt>Stock unit</dt><dd>{details.item.base_unit}</dd></div>
                <div><dt>Purchase unit</dt><dd>1 {details.item.purchase_unit} = {details.item.purchase_unit_conversion} {details.item.base_unit}</dd></div>
                <div><dt>Reorder level</dt><dd>{details.item.reorder_level ?? '—'} {details.item.reorder_level == null ? '' : details.item.base_unit}</dd></div>
                <div><dt>Target stock</dt><dd>{details.item.target_stock_level ?? '—'} {details.item.target_stock_level == null ? '' : details.item.base_unit}</dd></div>
                <div><dt>Expiry tracking</dt><dd>{details.item.track_expiry ? 'Enabled' : 'Off'}</dd></div>
                <div><dt>Batch tracking</dt><dd>{details.item.track_batches ? 'Enabled' : 'Off'}</dd></div>
                <div><dt>Status</dt><dd>{details.item.is_active ? 'Active' : 'Inactive'}</dd></div>
                <div className="inventory-detail-description"><dt>Description</dt><dd>{details.item.description || 'No description'}</dd></div>
              </dl>
            </section>
          </section>}

          {tab !== 'overview' && <section className="inventory-card">
            <div className="inventory-list-heading"><div><span className="inventory-kicker">{tabs.find((entry) => entry.id === tab)?.label.toUpperCase()}</span><h2>{details.item.name}</h2></div></div>
            {tabLoading ? <p className="inventory-list-footnote">Loading details…</p> : <>
              {tab === 'batches' && <div className="inventory-table-wrap"><table className="inventory-table">
                <thead><tr><th>Batch</th><th>Received</th><th>Current</th><th>Expiry</th><th>Location</th>{canViewCost && <th>Unit cost</th>}</tr></thead>
                <tbody>{batches.length === 0 ? <tr><td className="inventory-empty" colSpan={canViewCost ? 6 : 5}>No batches recorded.</td></tr>
                  : batches.map((batch) => <tr key={batch.id}><td><strong>{batch.batch_number || batch.id.slice(0, 8)}</strong></td><td>{batch.received_qty}</td><td>{batch.current_qty}</td><td>{batch.expires_at || '—'}</td><td>{batch.location_name || '—'}</td>{canViewCost && <td>{currency(batch.unit_cost_paise)}</td>}</tr>)}</tbody>
              </table></div>}
              {tab === 'movements' && <div className="inventory-table-wrap"><table className="inventory-table">
                <thead><tr><th>Date</th><th>Type</th><th>Quantity</th><th>Source</th><th>Notes</th>{canViewCost && <th>Cost</th>}</tr></thead>
                <tbody>{movements.length === 0 ? <tr><td className="inventory-empty" colSpan={canViewCost ? 6 : 5}>No stock movements recorded.</td></tr>
                  : movements.map((movement) => <tr key={movement.id}><td>{new Date(movement.created_at).toLocaleString('en-IN')}</td><td>{movement.movement_type.replaceAll('_', ' ')}</td><td>{movement.qty} {movement.unit}</td><td>{movement.source_event_type || '—'}</td><td>{movement.notes || '—'}</td>{canViewCost && <td>{currency(movement.total_cost_paise)}</td>}</tr>)}</tbody>
              </table></div>}
              {tab === 'suppliers' && <>
                <div className="inventory-table-wrap"><table className="inventory-table">
                  <thead><tr><th>Supplier</th><th>Supplier code</th><th>Price unit</th><th>Preferred</th>{canViewCost && <th>Unit price</th>}</tr></thead>
                  <tbody>{suppliers.length === 0 ? <tr><td className="inventory-empty" colSpan={canViewCost ? 5 : 4}>No supplier pricing linked.</td></tr>
                    : suppliers.map((supplier) => <tr key={supplier.supplier_id}><td><strong>{supplier.company_name}</strong></td><td>{supplier.supplier_item_code || '—'}</td><td>{supplier.price_unit}</td><td>{supplier.is_preferred ? 'Yes' : 'No'}</td>{canViewCost && <td>{currency(supplier.unit_price_paise)}</td>}</tr>)}</tbody>
                </table></div>
                {canViewCost && priceHistory.length > 0 && (
                  <div style={{ marginTop: '2rem' }}>
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>Price History &amp; Trends</h3>
                    <div className="inventory-table-wrap"><table className="inventory-table">
                      <thead><tr><th>Effective Date</th><th>Supplier</th><th>Price Unit</th><th>Historical Price</th></tr></thead>
                      <tbody>{priceHistory.map((h) => (
                        <tr key={h.id}>
                          <td>{new Date(h.effective_date).toLocaleDateString('en-IN')}</td>
                          <td><strong>{h.supplier_name}</strong></td>
                          <td>{h.price_unit}</td>
                          <td><strong>{currency(h.price_paise)}</strong></td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  </div>
                )}
              </>}
              {tab === 'recipes' && <div className="inventory-table-wrap"><table className="inventory-table">
                <thead><tr><th>Recipe</th><th>Menu dish</th><th>Version</th><th>Quantity per serving</th><th>Yield</th></tr></thead>
                <tbody>{recipeUsage.length === 0 ? <tr><td className="inventory-empty" colSpan={5}>This ingredient is not used in an active recipe.</td></tr>
                  : recipeUsage.map((usage) => <tr key={`${usage.recipe_id}-${usage.version_number}`}><td><strong>{usage.recipe_name}</strong></td><td>{usage.menu_item_name || '—'}</td><td>v{usage.version_number}</td><td>{usage.qty_per_serving} {usage.unit}</td><td>{usage.yield_pct}%</td></tr>)}</tbody>
              </table></div>}
            </>}
          </section>}
        </>}
      </main>
    </StudioShell>
  );
}
