'use client';

import { useEffect, useMemo, useState } from 'react';
import { BarChart3, CalendarDays, Clock3, RefreshCw, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import { Download, Printer } from 'lucide-react';
import { StudioShell } from '@/components/StudioShell';
import { SectionHeader } from '@/components/SectionHeader';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

const money = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function isoStart(days: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days + 1);
  return d.toISOString();
}

type AnalyticsData = {
  revenue: number;
  orders: number;
  cancellation_rate: number;
  average_preparation_minutes: number;
  average_service_response_minutes: number;
  table_utilization_percent: number;
  used_tables: number;
  total_tables: number;
  peak_hours: { hour: number; orders: number; revenue?: number }[];
  top_products: { name: string; revenue: number; quantity?: number }[];
};

type CrossRow = {
  branch_id: string;
  branch_name: string;
  revenue: number;
  orders: number;
  average_order_value: number;
  cancelled: number;
};

const emptyData: AnalyticsData = {
  revenue: 0,
  orders: 0,
  cancellation_rate: 0,
  average_preparation_minutes: 0,
  average_service_response_minutes: 0,
  table_utilization_percent: 0,
  used_tables: 0,
  total_tables: 0,
  peak_hours: [],
  top_products: [],
};

export default function AnalyticsPage() {
  const supabase = getSupabaseBrowserClient();
  const [branchId, setBranchId] = useState('');
  const [branchName, setBranchName] = useState('');
  const [range, setRange] = useState(1);
  const [data, setData] = useState<AnalyticsData>(emptyData);
  const [cross, setCross] = useState<CrossRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [owner, setOwner] = useState(false);

  const from = useMemo(() => isoStart(range), [range]);
  const to = useMemo(() => new Date().toISOString(), [range]);

  async function load() {
    if (!supabase) {
      setError('Supabase is not configured.');
      return;
    }

    const context = await getCurrentRestaurantContext(supabase);
    if (!context.data) {
      setError(context.error?.message ?? 'Workspace not found.');
      return;
    }

    const currentBranch = context.data.branch.id;
    const isOwner = context.data.staff.role === 'OWNER';
    setBranchId(currentBranch);
    setBranchName(context.data.branch.name);
    setOwner(isOwner);
    setError(null);

    const { data: entitlements, error: entitlementError } = await supabase.rpc('get_current_entitlements');
    if (entitlementError) {
      setError(entitlementError.message);
      return;
    }

    const advancedAllowed = Boolean(entitlements?.features?.ADVANCED_ANALYTICS);
    setAdvanced(advancedAllowed);

    if (advancedAllowed) {
      const { data: advancedData, error: analyticsError } = await supabase.rpc('get_build12_analytics', {
        p_branch_id: currentBranch,
        p_from: from,
        p_to: to,
      });
      if (analyticsError) {
        setError(analyticsError.message);
        return;
      }
      setData((advancedData ?? emptyData) as AnalyticsData);

      if (isOwner && Boolean(entitlements?.features?.CROSS_BRANCH_REPORTING)) {
        const { data: crossData, error: crossError } = await supabase.rpc('get_build12_cross_branch_analytics', { p_from: from, p_to: to });
        if (!crossError) setCross((crossData ?? []) as CrossRow[]);
      } else {
        setCross([]);
      }
    } else {
      const { data: basicData, error: analyticsError } = await supabase.rpc('get_branch_analytics', {
        p_branch_id: currentBranch,
        p_from: from,
        p_to: to,
      });
      if (analyticsError) {
        setError(analyticsError.message);
        return;
      }
      setData({
        ...emptyData,
        ...(basicData ?? {}),
      } as AnalyticsData);
      setCross([]);
    }
  }

  useEffect(() => {
    setLoading(true);
    void load().finally(() => setLoading(false));
  }, [range]);

  const peakMax = Math.max(1, ...data.peak_hours.map((x) => Number(x.orders)));
  const productMax = Math.max(1, ...data.top_products.map((x) => Number(x.revenue)));
  const rangeLabel = range === 1 ? 'Today' : `Last ${range} days`;

  function csvCell(value: unknown) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  function exportCsv() {
    const lines: string[] = [
      ['TABLELY ANALYTICS', branchName, rangeLabel].map(csvCell).join(','),
      '',
      ['Metric', 'Value'].map(csvCell).join(','),
      ['Revenue', data.revenue].map(csvCell).join(','),
      ['Orders', data.orders].map(csvCell).join(','),
      ['Cancellation rate', `${Number(data.cancellation_rate).toFixed(1)}%`].map(csvCell).join(','),
      ['Average preparation minutes', Number(data.average_preparation_minutes).toFixed(1)].map(csvCell).join(','),
      ['Average service response minutes', Number(data.average_service_response_minutes).toFixed(1)].map(csvCell).join(','),
      ['Table utilization', `${Number(data.table_utilization_percent).toFixed(1)}%`].map(csvCell).join(','),
      '',
      ['Peak hour', 'Orders', 'Revenue'].map(csvCell).join(','),
      ...data.peak_hours.map((item) => [String(item.hour).padStart(2, '0') + ':00', item.orders, item.revenue ?? ''].map(csvCell).join(',')),
      '',
      ['Top product', 'Revenue', 'Quantity'].map(csvCell).join(','),
      ...data.top_products.map((item) => [item.name, item.revenue, item.quantity ?? ''].map(csvCell).join(',')),
    ];
    if (cross.length) {
      lines.push('', ['Branch', 'Revenue', 'Orders', 'Average order value', 'Cancellations'].map(csvCell).join(','));
      lines.push(...cross.map((item) => [item.branch_name, item.revenue, item.orders, item.average_order_value, item.cancelled].map(csvCell).join(',')));
    }
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tablely-analytics-${branchName.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${range}d.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <StudioShell><div className="setup-loading">Loading analytics…</div></StudioShell>;

  return (
    <StudioShell>
      <SectionHeader
        eyebrow="INSIGHTS"
        title={advanced ? 'Advanced analytics' : 'Analytics'}
        description={`${branchName} · historical operating performance`}
        action={
          <div className="button-row">
            <div className="range-picker">
              <CalendarDays size={14} />
              {[1, 7, 30, 90].map((n) => (
                <button key={n} className={range === n ? 'active' : ''} onClick={() => setRange(n)}>
                  {n === 1 ? 'Today' : `${n}d`}
                </button>
              ))}
            </div>
            <button className="button button-light" onClick={exportCsv}><Download size={15} /> CSV</button>
            <button className="button button-light" onClick={() => window.print()}><Printer size={15} /> PDF / Print</button>
            <button className="button button-light" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button>
            <button className="button button-primary" onClick={() => window.dispatchEvent(new Event('tablely-open-ai-analytics'))}><Sparkles size={15} /> Ask AI</button>
          </div>
        }
      />
      {!advanced ? <div className="notice notice-info">Your plan includes basic analytics. Advanced operational analytics are available on higher plans.</div> : null}
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}

      <div className="metric-grid">
        <div className="metric-card"><div className="metric-head"><span>Revenue</span><TrendingUp size={16} /></div><strong>{money(Number(data.revenue))}</strong><small>{data.orders} orders in range</small></div>
        <div className="metric-card"><div className="metric-head"><span>Cancellation</span><TrendingDown size={16} /></div><strong>{Number(data.cancellation_rate).toFixed(1)}%</strong><small>Cancelled orders</small></div>
        <div className="metric-card"><div className="metric-head"><span>Preparation</span><Clock3 size={16} /></div><strong>{Number(data.average_preparation_minutes).toFixed(1)} min</strong><small>Acceptance → ready/completed</small></div>
        <div className="metric-card"><div className="metric-head"><span>Table utilization</span><BarChart3 size={16} /></div><strong>{Number(data.table_utilization_percent).toFixed(1)}%</strong><small>{data.used_tables}/{data.total_tables} active tables used</small></div>
      </div>

      {advanced ? (
        <div className="analytics-two-col">
          <section className="surface-card">
            <div className="card-heading"><div><h2>Peak hours</h2><p>Order volume by hour of day.</p></div></div>
            <div className="analytics-stack">
              {data.peak_hours.map((x) => <div className="analytics-stack-row" key={x.hour}><span>{String(x.hour).padStart(2, '0')}:00</span><div className="bar"><i style={{ width: `${Math.min(100, Number(x.orders) / peakMax * 100)}%` }} /></div><b>{x.orders}</b></div>)}
            </div>
          </section>
          <section className="surface-card">
            <div className="card-heading"><div><h2>Top products</h2><p>Best-performing menu items in the selected range.</p></div></div>
            <div className="analytics-stack">
              {data.top_products.map((x) => <div className="analytics-stack-row" key={x.name}><span className="product-name">{x.name}</span><div className="bar"><i style={{ width: `${Math.min(100, Number(x.revenue) / productMax * 100)}%` }} /></div><b>{money(Number(x.revenue))}</b></div>)}
            </div>
          </section>
        </div>
      ) : null}

      <section className="surface-card">
        <div className="card-heading"><div><h2>Service performance</h2><p>Operational response indicators from live service and order events.</p></div></div>
        <div className="mini-metrics"><div><span>Avg service response</span><strong>{Number(data.average_service_response_minutes).toFixed(1)} min</strong></div><div><span>Orders analysed</span><strong>{data.orders}</strong></div><div><span>Selected range</span><strong>{rangeLabel}</strong></div></div>
      </section>

      {owner && advanced && cross.length > 0 ? (
        <section className="surface-card">
          <div className="card-heading"><div><h2>Cross-branch comparison</h2><p>Organization-level revenue and order comparison.</p></div></div>
          <div className="data-table analytics-branches">
            <div className="data-row data-head"><span>Branch</span><span>Revenue</span><span>Orders</span><span>AOV</span><span>Cancellations</span></div>
            {cross.map((x) => <div className="data-row" key={x.branch_id}><div><strong>{x.branch_name}</strong>{x.branch_id === branchId ? <span>Current branch</span> : null}</div><span>{money(Number(x.revenue))}</span><span>{x.orders}</span><span>{money(Number(x.average_order_value))}</span><span>{x.cancelled}</span></div>)}
          </div>
        </section>
      ) : null}
    </StudioShell>
  );
}
