'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Download, RefreshCw } from 'lucide-react';
import { SectionHeader } from '@/components/SectionHeader';
import { StudioShell } from '@/components/StudioShell';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { extractErrorMessage } from '@/lib/inventory-errors';
import '../inventory.css';

type ConsumedItem = {
  id: string;
  name: string;
  base_unit: string;
  total_qty: number;
  total_cost_paise: number;
};

type FoodCostReport = {
  period_from: string;
  period_to: string;
  total_ingredient_cost_paise: number;
  net_food_sales_paise: number;
  total_wastage_cost_paise: number;
  top_consumed_items: ConsumedItem[];
};

type VarianceRow = {
  item_id: string;
  item_name: string;
  base_unit: string;
  theoretical_qty: number;
  actual_qty: number;
  variance_qty: number;
  variance_pct: number | null;
};

const money = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const csvCell = (value: string | number | null) => `"${String(value ?? '').replaceAll('"', '""')}"`;

function downloadCsv(filename: string, rows: Array<Array<string | number | null>>) {
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function InventoryReportsPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [from, setFrom] = useState(`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [foodReport, setFoodReport] = useState<FoodCostReport | null>(null);
  const [varianceRows, setVarianceRows] = useState<VarianceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (dateFrom: string, dateTo: string) => {
    if (!supabase) {
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    if (!dateFrom || !dateTo || dateFrom > dateTo) {
      setError('Select a valid date range.');
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
        p_permission: 'INVENTORY_COST_VIEW',
      });
      if (permission.error) throw permission.error;
      if (!permission.data) throw new Error('Inventory cost-view permission is required for reports.');

      const [food, variance] = await Promise.all([
        supabase.rpc('inventory_food_cost_report', {
          p_branch_id: branch.id,
          p_from: dateFrom,
          p_to: dateTo,
        }),
        supabase.rpc('inventory_variance_report', {
          p_branch_id: branch.id,
          p_from: dateFrom,
          p_to: dateTo,
        }),
      ]);
      if (food.error) throw food.error;
      if (variance.error) throw variance.error;
      setFoodReport(food.data as FoodCostReport);
      setVarianceRows((variance.data ?? []) as VarianceRow[]);
    } catch (loadError) {
      setError(extractErrorMessage(loadError, 'Could not load inventory reports.'));
      setFoodReport(null);
      setVarianceRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => { void load(from, to); }, [load]);

  function exportCsv() {
    if (!foodReport) return;
    downloadCsv(`inventory-report-${from}-to-${to}.csv`, [
      ['Report', 'Food cost summary'],
      ['Branch', branchName],
      ['From', from],
      ['To', to],
      ['Ingredient cost (paise)', foodReport.total_ingredient_cost_paise],
      ['Paid completed food sales (paise)', foodReport.net_food_sales_paise],
      ['Wastage cost (paise)', foodReport.total_wastage_cost_paise],
      [],
      ['Top consumed ingredient', 'Quantity', 'Unit', 'Cost (paise)'],
      ...foodReport.top_consumed_items.map((item) => [item.name, item.total_qty, item.base_unit, item.total_cost_paise]),
      [],
      ['Variance by ingredient', 'Theoretical quantity', 'Actual quantity', 'Variance quantity', 'Variance %', 'Unit'],
      ...varianceRows.map((row) => [row.item_name, row.theoretical_qty, row.actual_qty, row.variance_qty, row.variance_pct, row.base_unit]),
    ]);
  }

  return (
    <StudioShell>
      <main className="inventory-page">
        <SectionHeader
          eyebrow="OPERATIONS · INVENTORY"
          title="Inventory reports"
          description={`${branchName || 'Your branch'} · Food cost and ingredient variance`}
          action={<div className="inventory-actions">
            <Link className="button button-light" href="/inventory">Inventory</Link>
            <Link className="button button-light" href="/inventory/wastage">Wastage</Link>
            <button type="button" className="button button-light" onClick={() => void load(from, to)} disabled={loading}><RefreshCw size={15} /> Refresh</button>
            <button type="button" className="button button-primary" onClick={exportCsv} disabled={loading || !foodReport}><Download size={15} /> Export CSV</button>
          </div>}
        />
        {error && <div className="inventory-error" role="alert">{error}</div>}
        <section className="inventory-card">
          <form className="inventory-filters inventory-report-filters" onSubmit={(event) => { event.preventDefault(); void load(from, to); }}>
            <label>From <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} required /></label>
            <label>To <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} required /></label>
            <button type="submit" className="button button-primary" disabled={loading}>Apply dates</button>
          </form>
        </section>

        {foodReport && <section className="inventory-metrics" aria-label="Food cost summary">
          <article className="inventory-metric"><span className="inventory-metric-label">Ingredient cost</span><strong>{loading ? '—' : money(foodReport.total_ingredient_cost_paise)}</strong></article>
          <article className="inventory-metric"><span className="inventory-metric-label">Paid food sales</span><strong>{loading ? '—' : money(foodReport.net_food_sales_paise)}</strong></article>
          <article className="inventory-metric"><span className="inventory-metric-label">Wastage cost</span><strong>{loading ? '—' : money(foodReport.total_wastage_cost_paise)}</strong></article>
        </section>}

        <section className="inventory-card">
          <div className="inventory-list-heading"><div><span className="inventory-kicker">COST ANALYSIS</span><h2>Top consumed ingredients</h2></div></div>
          <div className="inventory-table-wrap"><table className="inventory-table">
            <thead><tr><th>Ingredient</th><th>Quantity consumed</th><th>Cost</th></tr></thead>
            <tbody>{loading ? <tr><td className="inventory-empty" colSpan={3}>Loading report…</td></tr>
              : !foodReport?.top_consumed_items.length ? <tr><td className="inventory-empty" colSpan={3}>No consumption data for this period.</td></tr>
                : foodReport.top_consumed_items.map((item) => <tr key={item.id}>
                  <td><strong>{item.name}</strong></td>
                  <td>{Number(item.total_qty).toLocaleString('en-IN')} {item.base_unit}</td>
                  <td>{money(item.total_cost_paise)}</td>
                </tr>)}</tbody>
          </table></div>
        </section>

        <section className="inventory-card">
          <div className="inventory-list-heading"><div><span className="inventory-kicker">THEORETICAL VS ACTUAL</span><h2>Consumption variance</h2></div></div>
          <div className="inventory-table-wrap"><table className="inventory-table">
            <thead><tr><th>Ingredient</th><th>Theoretical</th><th>Actual</th><th>Variance</th><th>Variance %</th></tr></thead>
            <tbody>{loading ? <tr><td className="inventory-empty" colSpan={5}>Loading report…</td></tr>
              : varianceRows.length === 0 ? <tr><td className="inventory-empty" colSpan={5}>No recipe-based consumption data for this period.</td></tr>
                : varianceRows.map((row) => <tr key={row.item_id}>
                  <td><strong>{row.item_name}</strong></td>
                  <td>{Number(row.theoretical_qty).toLocaleString('en-IN')} {row.base_unit}</td>
                  <td>{Number(row.actual_qty).toLocaleString('en-IN')} {row.base_unit}</td>
                  <td>{Number(row.variance_qty).toLocaleString('en-IN')} {row.base_unit}</td>
                  <td>{row.variance_pct == null ? '—' : `${row.variance_pct}%`}</td>
                </tr>)}</tbody>
          </table></div>
          <p className="inventory-list-footnote">The theoretical baseline uses the currently active recipe version; historical recipe snapshots are not yet applied.</p>
        </section>
      </main>
    </StudioShell>
  );
}
