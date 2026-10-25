'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowDownToLine, Boxes, CircleDollarSign, PackagePlus, RefreshCw, Search, Settings2 } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import './inventory.css';
import { extractErrorMessage } from '@/lib/inventory-errors';

type InventoryItem = {
  id: string;
  name: string;
  sku: string | null;
  category_id: string | null;
  category_name: string | null;
  base_unit: string;
  purchase_unit: string;
  purchase_unit_conversion: number;
  reorder_level: number | null;
  target_stock_level: number | null;
  is_active: boolean;
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
  avg_unit_cost_paise: number | null;
  stock_value_paise: number | null;
  stock_status: 'OUT' | 'LOW' | 'HEALTHY';
  expiring_batch_count: number;
};

type Overview = {
  total_items: number;
  total_stock_value_paise: number | null;
  low_stock_count: number;
  out_of_stock_count: number;
  expiring_soon_count: number;
  expired_count: number;
  pending_po_count: number;
  wastage_value_paise_this_month: number | null;
};

type Category = { id: string; name: string };
type ProcessingError = {
  id: string;
  order_id: string;
  order_status: string;
  error_message: string;
  occurrences: number;
  last_seen_at: string;
};

type ReorderSuggestion = {
  item_id: string;
  item_name: string;
  base_unit: string;
  purchase_unit: string;
  on_hand_qty: number;
  available_qty: number;
  reorder_level: number;
  suggested_order_qty: number;
  preferred_supplier_id: string | null;
  preferred_supplier_name: string | null;
  unit_price_paise: number | null;
  estimated_cost_paise: number | null;
  urgency: 'CRITICAL' | 'LOW' | 'REORDER';
};
type InventoryAlert = {
  id: string;
  alert_type: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  created_at: string;
  item_id: string | null;
};

const emptyOverview: Overview = {
  total_items: 0,
  total_stock_value_paise: null,
  low_stock_count: 0,
  out_of_stock_count: 0,
  expiring_soon_count: 0,
  expired_count: 0,
  pending_po_count: 0,
  wastage_value_paise_this_month: null,
};

const inr = (paise: number | null) =>
  paise === null ? '—' : `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export default function InventoryPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [processingErrors, setProcessingErrors] = useState<ProcessingError[]>([]);
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
  const [overview, setOverview] = useState<Overview>(emptyOverview);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generatingAlerts, setGeneratingAlerts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canViewCost, setCanViewCost] = useState(false);
  const [canTransfer, setCanTransfer] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    sku: '',
    categoryId: '',
    baseUnit: 'g',
    purchaseUnit: 'kg',
    conversion: '1000',
    reorderLevel: '',
  });

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

      const [viewPermission, managePermission, costPermission, transferPermission] = await Promise.all([
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_VIEW',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_MANAGEMENT',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_COST_VIEW',
        }),
        supabase.rpc('current_user_has_permission_for_branch', {
          p_branch_id: branch.id,
          p_permission: 'INVENTORY_TRANSFER',
        }),
      ]);
      if (viewPermission.error) throw viewPermission.error;
      if (managePermission.error) throw managePermission.error;
      if (costPermission.error) throw costPermission.error;
      if (transferPermission.error) throw transferPermission.error;
      if (!viewPermission.data) throw new Error('You do not have inventory view permission for this branch.');
      setCanManage(Boolean(managePermission.data));
      setCanViewCost(Boolean(costPermission.data));
      setCanTransfer(Boolean(transferPermission.data));

      void Promise.allSettled([
        supabase.rpc('inventory_ensure_default_categories', { p_organization_id: context.data.organization.id }),
        supabase.rpc('inventory_ensure_default_locations', { p_branch_id: branch.id }),
        supabase.rpc('inventory_ensure_branch_settings', { p_branch_id: branch.id }),
      ]);

      const [overviewResult, itemsResult, categoriesResult, errorsResult, alertsResult, suggestionsResult] = await Promise.all([
        supabase.rpc('inventory_get_overview', { p_branch_id: branch.id }),
        supabase.rpc('inventory_list_items', {
          p_branch_id: branch.id,
          p_search: search.trim() || null,
          p_status: status,
          p_limit: 100,
          p_offset: 0,
        }),
        supabase.from('inventory_categories').select('id,name').order('sort_order').order('name'),
        supabase.from('inventory_processing_errors')
          .select('id,order_id,order_status,error_message,occurrences,last_seen_at')
          .eq('branch_id', branch.id)
          .is('resolved_at', null)
          .order('last_seen_at', { ascending: false })
          .limit(5),
        supabase.from('inventory_alerts')
          .select('id,alert_type,severity,message,created_at,item_id')
          .eq('branch_id', branch.id)
          .eq('is_dismissed', false)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase.rpc('inventory_get_reorder_suggestions', { p_branch_id: branch.id }).then(r => r, () => ({ data: [], error: null })),
      ]);
      if (overviewResult.error) throw overviewResult.error;
      if (itemsResult.error) throw itemsResult.error;
      setOverview({ ...emptyOverview, ...(overviewResult.data as Partial<Overview> | null) });
      setItems((itemsResult.data ?? []) as InventoryItem[]);
      if (categoriesResult.data) setCategories(categoriesResult.data as Category[]);
      if (errorsResult.data) setProcessingErrors(errorsResult.data as ProcessingError[]);
      if (alertsResult.data) setAlerts(alertsResult.data as InventoryAlert[]);
      if (suggestionsResult && 'data' in suggestionsResult && suggestionsResult.data) setSuggestions(suggestionsResult.data as ReorderSuggestion[]);
    } catch (loadError) {
      setError(extractErrorMessage(loadError, 'Could not load inventory.'));
    } finally {
      setLoading(false);
    }
  }, [supabase, search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => [
    { label: 'Active ingredients', value: overview.total_items.toLocaleString('en-IN'), icon: Boxes },
    { label: 'Low stock', value: overview.low_stock_count.toLocaleString('en-IN'), icon: AlertTriangle },
    { label: 'Out of stock', value: overview.out_of_stock_count.toLocaleString('en-IN'), icon: PackagePlus },
    { label: 'Stock value', value: canViewCost ? inr(overview.total_stock_value_paise) : 'Restricted', icon: CircleDollarSign },
  ], [overview, canViewCost]);

  async function createItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !branchId || !canManage) return;
    const conversion = Number(form.conversion);
    const reorderLevel = form.reorderLevel.trim() ? Number(form.reorderLevel) : null;
    if (!form.name.trim() || !form.baseUnit.trim() || !form.purchaseUnit.trim()
      || !Number.isFinite(conversion) || conversion <= 0
      || (reorderLevel !== null && (!Number.isFinite(reorderLevel) || reorderLevel < 0))) {
      setError('Enter a name, valid units, a positive conversion, and a non-negative reorder level.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const context = await getCurrentRestaurantContext(supabase);
      if (!context.data) throw context.error ?? new Error('Restaurant workspace not found.');
      const { error: saveError } = await supabase.rpc('inventory_upsert_item', {
        p_organization_id: context.data.organization.id,
        p_name: form.name.trim(),
        p_sku: form.sku.trim() || null,
        p_category_id: form.categoryId || null,
        p_base_unit: form.baseUnit.trim(),
        p_purchase_unit: form.purchaseUnit.trim(),
        p_purchase_unit_conversion: conversion,
        p_reorder_level: reorderLevel,
      });
      if (saveError) throw saveError;
      setShowCreate(false);
      setForm({
        name: '',
        sku: '',
        categoryId: '',
        baseUnit: 'g',
        purchaseUnit: 'kg',
        conversion: '1000',
        reorderLevel: '',
      });
      await load();
    } catch (saveError) {
      setError(extractErrorMessage(saveError, 'Could not save the ingredient.'));
    } finally {
      setSaving(false);
    }
  }

  async function resolveProcessingError(errorId: string, action: 'RETRY' | 'RESOLVE' = 'RETRY') {
    if (!supabase || !canManage) return;
    setError(null);
    const { error: resolveError } = await supabase.rpc('inventory_resolve_processing_error', {
      p_error_id: errorId,
      p_action: action,
    });
    if (resolveError) {
      setError(extractErrorMessage(resolveError, 'Could not process error resolution.'));
      return;
    }
    setNotice(action === 'RETRY' ? 'Operation replayed and reconciled successfully.' : 'Issue marked resolved.');
    await load();
  }

  async function generateAlerts() {
    if (!supabase || !branchId || !canManage) return;
    setGeneratingAlerts(true);
    setError(null);
    setNotice(null);
    try {
      const result = await supabase.rpc('inventory_generate_alerts', { p_branch_id: branchId });
      if (result.error) throw result.error;
      setNotice(`${Number(result.data ?? 0)} new stock alert${Number(result.data ?? 0) === 1 ? '' : 's'} generated.`);
      await load();
    } catch (alertError) {
      setError(extractErrorMessage(alertError, 'Could not generate inventory alerts.'));
    } finally {
      setGeneratingAlerts(false);
    }
  }

  async function dismissAlert(alertId: string) {
    if (!supabase) return;
    setError(null);
    try {
      const result = await supabase.rpc('inventory_dismiss_alert', { p_alert_id: alertId });
      if (result.error) throw result.error;
      await load();
    } catch (dismissError) {
      setError(extractErrorMessage(dismissError, 'Could not dismiss the alert.'));
    }
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Inventory"
          description={`${branchName || 'Your branch'} · Stock, ingredients and upcoming alerts`}
          action={
            <div className="inventory-actions">
              <button type="button" className="button button-light" onClick={() => void load()} disabled={loading}>
                <RefreshCw size={15} /> Refresh
              </button>
              {canManage && <button type="button" className="button button-light" onClick={() => void generateAlerts()} disabled={generatingAlerts}>
                <AlertTriangle size={15} /> {generatingAlerts ? 'Checking…' : 'Check alerts'}
              </button>}
              {canManage && (
                <button type="button" className="button button-primary" onClick={() => setShowCreate((open) => !open)}>
                  <PackagePlus size={15} /> Add ingredient
                </button>
              )}
              <Link className="button button-light" href="/inventory/recipes">Recipes</Link>
              <Link className="button button-light" href="/inventory/purchases">Purchasing</Link>
              <Link className="button button-light" href="/inventory/counts">Stock counts</Link>
              <Link className="button button-light" href="/inventory/wastage">Wastage</Link>
              {canViewCost && <Link className="button button-light" href="/inventory/reports">Reports</Link>}
              {canTransfer && <Link className="button button-light" href="/inventory/transfers">Transfers</Link>}
              <Link className="button button-light" href="/inventory/settings"><Settings2 size={15} /> Settings</Link>
            </div>
          }
        />

        {error && <div className="inventory-error" role="alert">{error}</div>}
        {notice && <div className="inventory-alert-strip" role="status">{notice}</div>}
        {alerts.length > 0 && <section className="inventory-errors" aria-label="Active inventory alerts">
          <div><AlertTriangle size={17} /><strong>Active stock alerts</strong><span>{alerts.length} shown</span></div>
          <ul>{alerts.map((alert) => (
            <li key={alert.id}>
              <span><strong>{alert.severity} · {alert.alert_type.replaceAll('_', ' ')}</strong> · {alert.message}<small>{new Date(alert.created_at).toLocaleString('en-IN')}</small></span>
              <button type="button" className="button button-light" onClick={() => void dismissAlert(alert.id)}>Dismiss</button>
            </li>
          ))}</ul>
        </section>}
        {processingErrors.length > 0 && (
          <section className="inventory-errors" aria-label="Inventory processing issues">
            <div><AlertTriangle size={17} /><strong>Inventory needs attention</strong><span>Orders continued in warning mode; review the affected inventory events.</span></div>
            <ul>{processingErrors.map((issue) => (
              <li key={issue.id}>
                <span><strong>{issue.order_status}</strong> · order {issue.order_id.slice(0, 8)} · {issue.error_message} <small>{issue.occurrences > 1 ? `${issue.occurrences} occurrences` : '1 occurrence'}</small></span>
                {canManage && (
                  <div className="inventory-actions">
                    <button type="button" className="button button-primary" onClick={() => void resolveProcessingError(issue.id, 'RETRY')}>Retry & Reconcile</button>
                    <button type="button" className="button button-light" onClick={() => void resolveProcessingError(issue.id, 'RESOLVE')}>Dismiss</button>
                  </div>
                )}
              </li>
            ))}</ul>
          </section>
        )}

        <section className="inventory-metrics" aria-label="Inventory summary">
          {counts.map(({ label, value, icon: Icon }) => (
            <article className="inventory-metric" key={label}>
              <span className="inventory-metric-icon"><Icon size={17} /></span>
              <span className="inventory-metric-label">{label}</span>
              <strong>{loading ? '—' : value}</strong>
            </article>
          ))}
        </section>

        <section className="inventory-alert-strip" aria-label="Inventory alerts">
          <div><AlertTriangle size={17} /><span><strong>{overview.expired_count}</strong> expired batches</span></div>
          <div><ArrowDownToLine size={17} /><span><strong>{overview.expiring_soon_count}</strong> items expiring soon</span></div>
          <div><Boxes size={17} /><span><strong>{overview.pending_po_count}</strong> open purchase orders</span></div>
          {canViewCost && <div><CircleDollarSign size={17} /><span><strong>{inr(overview.wastage_value_paise_this_month)}</strong> wastage this month</span></div>}
        </section>

        {showCreate && canManage && (
          <form className="inventory-create" onSubmit={createItem}>
            <div className="inventory-create-heading">
              <div><span className="inventory-kicker">INGREDIENT MASTER</span><h2>Add ingredient</h2></div>
              <button type="button" className="button button-light" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
            <div className="inventory-form-grid">
              <label>Name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={120} /></label>
              <label>SKU <span className="inventory-optional">Optional</span><input value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} maxLength={80} /></label>
              <label>Category<select value={form.categoryId} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}><option value="">Uncategorized</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <label>Stock unit<input required value={form.baseUnit} onChange={(event) => setForm({ ...form, baseUnit: event.target.value })} maxLength={20} /></label>
              <label>Purchase unit<input required value={form.purchaseUnit} onChange={(event) => setForm({ ...form, purchaseUnit: event.target.value })} maxLength={20} /></label>
              <label>Purchase unit equals<input required type="number" min="0.0001" step="0.0001" value={form.conversion} onChange={(event) => setForm({ ...form, conversion: event.target.value })} /><small>Stock units</small></label>
              <label>Reorder at <span className="inventory-optional">Optional</span><input type="number" min="0" step="0.0001" value={form.reorderLevel} onChange={(event) => setForm({ ...form, reorderLevel: event.target.value })} /></label>
            </div>
            <div className="inventory-form-footer"><span>Quantities are stored in the stock unit; prices are managed separately.</span><button type="submit" className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save ingredient'}</button></div>
          </form>
        )}

        {suggestions.length > 0 && (
          <section className="inventory-card" aria-label="Smart Reorder Suggestions">
            <div className="inventory-list-heading">
              <div>
                <span className="inventory-kicker">SMART REORDER</span>
                <h2>Purchase suggestions <span>{suggestions.length} items below threshold</span></h2>
              </div>
              <Link className="button button-primary" href="/inventory/purchases">
                <PackagePlus size={15} /> Create purchase order
              </Link>
            </div>
            <div className="inventory-table-wrap">
              <table className="inventory-table">
                <thead>
                  <tr>
                    <th>Urgency</th>
                    <th>Ingredient</th>
                    <th>Available Stock</th>
                    <th>Reorder Point</th>
                    <th>Suggested Order</th>
                    <th>Supplier</th>
                    {canViewCost && <th>Est. Cost</th>}
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((s) => (
                    <tr key={s.item_id}>
                      <td>
                        <span className={`inventory-status ${s.urgency === 'CRITICAL' ? 'inventory-status-out' : 'inventory-status-low'}`}>
                          {s.urgency}
                        </span>
                      </td>
                      <td><strong>{s.item_name}</strong></td>
                      <td>{s.available_qty} {s.base_unit}</td>
                      <td>{s.reorder_level} {s.base_unit}</td>
                      <td><strong>{s.suggested_order_qty} {s.base_unit}</strong></td>
                      <td>{s.preferred_supplier_name || 'No preferred vendor'}</td>
                      {canViewCost && <td>{s.estimated_cost_paise ? inr(s.estimated_cost_paise) : '—'}</td>}
                      <td>
                        <Link className="button button-light" href={`/inventory/purchases?item=${s.item_id}`}>
                          Order
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="inventory-card">
          <div className="inventory-list-heading">
            <div><span className="inventory-kicker">STOCK OVERVIEW</span><h2>Ingredients</h2></div>
            <div className="inventory-filters">
              <label className="inventory-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search ingredients" aria-label="Search ingredients" /></label>
              <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter stock status">
                <option value="ALL">All stock</option><option value="LOW">Low</option><option value="OUT">Out of stock</option><option value="HEALTHY">Healthy</option>
              </select>
            </div>
          </div>
          <div className="inventory-table-wrap">
            <table className="inventory-table">
              <thead><tr><th>Ingredient</th><th>Category</th><th>On hand</th><th>Reserved</th><th>Available</th>{canViewCost && <th>Unit cost</th>}<th>Status</th></tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={canViewCost ? 7 : 6} className="inventory-empty">Loading ingredients…</td></tr>
                  : items.length === 0 ? <tr><td colSpan={canViewCost ? 7 : 6} className="inventory-empty">No ingredients match this view. Add an ingredient to start tracking stock.</td></tr>
                    : items.map((item) => (
                      <tr key={item.id}>
                        <td><Link className="inventory-item-link" href={`/inventory/items/${item.id}`}><strong>{item.name}</strong><small>{item.sku || item.purchase_unit}</small></Link></td>
                        <td>{item.category_name || '—'}</td>
                        <td>{item.on_hand_qty.toLocaleString('en-IN')} <span>{item.base_unit}</span></td>
                        <td>{item.reserved_qty.toLocaleString('en-IN')} <span>{item.base_unit}</span></td>
                        <td>{item.available_qty.toLocaleString('en-IN')} <span>{item.base_unit}</span></td>
                        {canViewCost && <td>{inr(item.avg_unit_cost_paise)}</td>}
                        <td><span className={`inventory-status inventory-status-${item.stock_status.toLowerCase()}`}>{item.stock_status === 'OUT' ? 'Out of stock' : item.stock_status === 'LOW' ? 'Low stock' : 'Healthy'}</span></td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
          <p className="inventory-list-footnote">Showing up to 100 ingredients. Stock values and unit costs require the cost-view permission.</p>
        </section>
      </main>
    </StudioShell>
  );
}
