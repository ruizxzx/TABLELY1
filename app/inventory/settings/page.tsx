'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, Save, Settings2 } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { extractErrorMessage } from '@/lib/inventory-errors';
import '../inventory.css';

type Location = { id: string; name: string; description: string | null; is_active: boolean };
type Category = { id: string; name: string };

export default function InventorySettingsPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [stockMode, setStockMode] = useState('WARNING');
  const [expiryDays, setExpiryDays] = useState('7');
  const [newLocation, setNewLocation] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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
      setOrganizationId(context.data.organization.id);

      const [feature, view, manage, settings, locationsResult, categoriesResult] = await Promise.all([
        supabase.rpc('organization_has_feature', {
          p_organization_id: context.data.organization.id,
          p_feature: 'INVENTORY',
        }),
        supabase.rpc('current_user_has_permission_for_branch', { p_branch_id: branch.id, p_permission: 'INVENTORY_VIEW' }),
        supabase.rpc('current_user_has_permission_for_branch', { p_branch_id: branch.id, p_permission: 'INVENTORY_MANAGEMENT' }),
        supabase.from('branch_inventory_settings').select('stock_mode,expiry_alert_days_1').eq('branch_id', branch.id).maybeSingle(),
        supabase.from('inventory_locations').select('id,name,description,is_active').eq('branch_id', branch.id).order('sort_order').order('name'),
        supabase.from('inventory_categories').select('id,name').eq('organization_id', context.data.organization.id).order('sort_order').order('name'),
      ]);
      if (feature.error) throw feature.error;
      if (view.error) throw view.error;
      if (manage.error) throw manage.error;
      if (settings.error) throw settings.error;
      if (locationsResult.error) throw locationsResult.error;
      if (categoriesResult.error) throw categoriesResult.error;
      if (!feature.data) throw new Error('Inventory is not enabled for this restaurant plan.');
      if (!view.data) throw new Error('You do not have inventory view permission for this branch.');
      setCanManage(Boolean(manage.data));
      if (settings.data) {
        setStockMode(settings.data.stock_mode);
        setExpiryDays(String(settings.data.expiry_alert_days_1));
      }
      setLocations((locationsResult.data ?? []) as Location[]);
      setCategories((categoriesResult.data ?? []) as Category[]);
    } catch (loadError) {
      setError(extractErrorMessage(loadError, 'Could not load inventory settings.'));
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !branchId || !canManage) return;
    const expiry = Number(expiryDays);
    if (!Number.isInteger(expiry) || expiry < 1 || expiry > 365) {
      setError('Expiry alert window must be a whole number from 1 to 365 days.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { error: saveError } = await supabase.rpc('inventory_upsert_branch_settings', {
        p_branch_id: branchId,
        p_stock_mode: stockMode,
        p_expiry_alert_days_1: expiry,
      });
      if (saveError) throw saveError;
      setNotice('Branch inventory settings saved.');
      await load();
    } catch (saveError) {
      setError(extractErrorMessage(saveError, 'Could not save inventory settings.'));
    } finally {
      setSaving(false);
    }
  }

  async function addLocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !branchId || !canManage) return;
    const name = newLocation.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { error: saveError } = await supabase.rpc('inventory_upsert_location', {
        p_branch_id: branchId,
        p_name: name,
      });
      if (saveError) throw saveError;
      setNewLocation('');
      setNotice('Storage location added.');
      await load();
    } catch (saveError) {
      setError(extractErrorMessage(saveError, 'Could not add the storage location.'));
    } finally {
      setSaving(false);
    }
  }

  async function addCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !organizationId || !canManage) return;
    const name = newCategory.trim();
    if (!name) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { error: saveError } = await supabase.from('inventory_categories').insert({
        organization_id: organizationId,
        name,
        sort_order: categories.length,
      });
      if (saveError) throw saveError;
      setNewCategory('');
      setNotice('Ingredient category added.');
      await load();
    } catch (saveError) {
      setError(extractErrorMessage(saveError, 'Could not add the category.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Inventory settings"
          description={`${branchName || 'Your branch'} · Stock handling and storage setup`}
          action={<Link className="button button-light" href="/inventory"><ArrowLeft size={15} /> Inventory</Link>}
        />
        {error && <div className="inventory-error" role="alert">{error}</div>}
        {notice && <div className="inventory-alert-strip" role="status">{notice}</div>}
        {loading ? <section className="inventory-settings-card">Loading inventory settings…</section> : (
          <div className="inventory-settings-grid">
            <form className="inventory-settings-card" onSubmit={saveSettings}>
              <span className="inventory-kicker">ORDER AVAILABILITY</span>
              <h2><Settings2 size={17} /> Branch stock rules</h2>
              <p>Choose how ingredient shortages affect order acceptance. STRICT stock mode may reject an order that cannot be fulfilled from tracked stock.</p>
              <label>Stock mode
                <select value={stockMode} onChange={(event) => setStockMode(event.target.value)} disabled={!canManage}>
                  <option value="WARNING">Warning — allow orders and record shortages</option>
                  <option value="STRICT">Strict — block acceptance when stock is short</option>
                  <option value="DISABLED">Disabled — skip automatic reservation</option>
                </select>
              </label>
              <label>Expiry alert window
                <input type="number" min="1" max="365" step="1" value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)} disabled={!canManage} />
              </label>
              <div className="inventory-form-footer">
                <span>{canManage ? 'Only managers with inventory management access can change these rules.' : 'Read-only: inventory management permission is required to edit.'}</span>
                {canManage && <button className="button button-primary" type="submit" disabled={saving}><Save size={15} />{saving ? 'Saving…' : 'Save settings'}</button>}
              </div>
            </form>

            <section className="inventory-settings-card">
              <span className="inventory-kicker">STORAGE</span>
              <h2>Locations</h2>
              <p>Keep storage locations branch-specific so counts and receipts map to the right place.</p>
              <ul>{locations.length ? locations.map((location) => <li key={location.id}><span>{location.name}</span><span>{location.is_active ? 'Active' : 'Inactive'}</span></li>) : <li>No storage locations configured.</li>}</ul>
              {canManage && <form className="inventory-inline-form" onSubmit={addLocation}><input aria-label="New location name" value={newLocation} onChange={(event) => setNewLocation(event.target.value)} placeholder="New location name" maxLength={100} required /><button className="button button-light" type="submit" disabled={saving}><Plus size={15} /> Add</button></form>}
            </section>

            <section className="inventory-settings-card">
              <span className="inventory-kicker">INGREDIENT MASTER</span>
              <h2>Categories</h2>
              <p>Categories are shared by branches in this restaurant.</p>
              <ul>{categories.length ? categories.map((category) => <li key={category.id}><span>{category.name}</span></li>) : <li>No categories configured.</li>}</ul>
              {canManage && <form className="inventory-inline-form" onSubmit={addCategory}><input aria-label="New category name" value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="New category name" maxLength={100} required /><button className="button button-light" type="submit" disabled={saving}><Plus size={15} /> Add</button></form>}
            </section>
          </div>
        )}
      </main>
    </StudioShell>
  );
}
