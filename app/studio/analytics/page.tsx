'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabase';

type AnalyticsLevel = 'basic' | 'standard' | 'advanced';

type IntegrationRow = {
  provider: 'google_analytics' | 'meta_pixel' | 'tiktok_pixel';
  measurement_id: string | null;
  enabled: boolean;
};

type RangeOption = { value: string; label: string };

type LinkMetric = {
  label: string;
  clicks: number;
  ctr: number;
  checkouts: number;
  purchases: number;
  revenue: number;
};

type UTMMetric = {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  visits: number;
  clicks: number;
  checkouts: number;
  purchases: number;
  revenue: number;
  conversion: number;
};

type AnalyticsData = {
  level: AnalyticsLevel;
  events: Array<Record<string, unknown>>;
  orders: Array<Record<string, unknown>>;
  summary: {
    pageViews: number;
    linkClicks: number;
    ctr: number | null;
    productsSold: number;
    revenue: number;
    conversionRate: number | null;
    aov: number | null;
    uniqueVisitors: number;
    devices: Array<[string, number]>;
    countries: Array<[string, number]>;
    sources: Array<[string, number]>;
    referrers: Array<[string, number]>;
    trend: Array<{ date: string; visits: number; clicks: number; checkouts: number; purchases: number; revenue: number }>;
    topLinks: Array<{ label: string; clicks: number; ctr: number; checkouts: number; purchases: number; revenue: number }>;
    utmReport: UTMMetric[];
    linkPerformance: LinkMetric[];
    revenueBreakdown: {
      bySource: Array<{ source: string; revenue: number; share: number; orders: number }>;
      byLink: Array<{ label: string; revenue: number; share: number; purchases: number }>;
      byCampaign: Array<{ campaign: string; revenue: number; share: number; purchases: number }>;
      byProduct: Array<{ title: string; revenue: number; share: number; units: number }>;
      unattributed: number;
    };
    attribution: { model: string; notes: string };
  };
};

const ranges: RangeOption[] = [{ value: '1', label: 'Today' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }];
const providerLabels: Record<IntegrationRow['provider'], string> = {
  google_analytics: 'Google Analytics',
  meta_pixel: 'Meta Pixel',
  tiktok_pixel: 'TikTok Pixel',
};

const emptyAnalytics: AnalyticsData = {
  level: 'basic',
  events: [],
  orders: [],
  summary: {
    pageViews: 0,
    linkClicks: 0,
    ctr: null,
    productsSold: 0,
    revenue: 0,
    conversionRate: null,
    aov: null,
    uniqueVisitors: 0,
    devices: [],
    countries: [],
    sources: [],
    referrers: [],
    trend: [],
    topLinks: [],
    utmReport: [],
    linkPerformance: [],
    revenueBreakdown: { bySource: [], byLink: [], byCampaign: [], byProduct: [], unattributed: 0 },
    attribution: { model: 'visitor/session → source/link → checkout → purchase', notes: 'No attribution data is available yet.' },
  },
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(value || 0);
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(1)}%`;
}

export default function AnalyticsPage() {
  const [range, setRange] = useState('30');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [analytics, setAnalytics] = useState<AnalyticsData & { planKey?: string }>(emptyAnalytics as AnalyticsData & { planKey?: string });
  const [integrations, setIntegrations] = useState<IntegrationRow[]>([]);
  const [integrationDrafts, setIntegrationDrafts] = useState<Record<IntegrationRow['provider'], string>>({
    google_analytics: '',
    meta_pixel: '',
    tiktok_pixel: '',
  });
  const [savingIntegration, setSavingIntegration] = useState(false);

  const hasAccess = analytics.level === 'basic' || analytics.level === 'standard' || analytics.level === 'advanced';
  const hasAdvanced = analytics.level === 'advanced';
  const hasMaxIntegrations = (analytics as AnalyticsData & { planKey?: string }).planKey === 'max';
  const hasData = analytics.events.length > 0 || analytics.orders.length > 0;

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setMessage('');
      if (!supabase) {
        setLoading(false);
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setLoading(false);
        setMessage('Please sign in again to view analytics.');
        return;
      }

      const headers = { Authorization: `Bearer ${session.access_token}` };
      try {
        const [analyticsResponse, integrationsResponse] = await Promise.all([
          fetch(`/api/studio/analytics?days=${encodeURIComponent(range)}`, { headers, cache: 'no-store' }),
          fetch('/api/studio/integrations', { headers, cache: 'no-store' }),
        ]);

        const analyticsPayload = await analyticsResponse.json();
        const integrationsPayload = await integrationsResponse.json();
        if (!active) return;

        if (!analyticsResponse.ok || !analyticsPayload.ok) {
          setMessage(analyticsPayload?.error || 'Could not load analytics.');
          setLoading(false);
          return;
        }

        setAnalytics(analyticsPayload.data || emptyAnalytics);
        if (integrationsResponse.ok && integrationsPayload?.ok) {
          const nextIntegrations = integrationsPayload.data || [];
          setIntegrations(nextIntegrations);
          setIntegrationDrafts((current) => ({
            google_analytics: nextIntegrations.find((entry: IntegrationRow) => entry.provider === 'google_analytics')?.measurement_id || current.google_analytics,
            meta_pixel: nextIntegrations.find((entry: IntegrationRow) => entry.provider === 'meta_pixel')?.measurement_id || current.meta_pixel,
            tiktok_pixel: nextIntegrations.find((entry: IntegrationRow) => entry.provider === 'tiktok_pixel')?.measurement_id || current.tiktok_pixel,
          }));
        }
      } catch (error) {
        if (!active) return;
        console.error('[analytics-page]', error);
        setMessage('The analytics dashboard could not be loaded right now.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => { active = false; };
  }, [range]);

  const planSummary = useMemo(() => ({
    basic: 'Free',
    standard: 'Creator',
    advanced: 'Pro / Max',
  }[analytics.level] || 'Free'), [analytics.level]);

  async function exportCsv() {
    if (!supabase) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setMessage('Please sign in again to export analytics.');
      return;
    }
    const response = await fetch(`/api/studio/analytics/export?days=${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setMessage(payload?.error || 'CSV export is not available on this plan.');
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tablely-analytics-${range}d.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function saveIntegration(provider: IntegrationRow['provider']) {
    if (!supabase) return;
    const measurementId = (integrationDrafts[provider] || '').trim();
    if (!measurementId) {
      setMessage('Add a valid Measurement ID before saving this integration.');
      return;
    }
    if (!/^[A-Za-z0-9_-]{4,120}$/.test(measurementId)) {
      setMessage('Measurement IDs must use a valid public tracking format for this provider.');
      return;
    }

    setSavingIntegration(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setMessage('Please sign in again before saving integrations.');
      setSavingIntegration(false);
      return;
    }

    const response = await fetch('/api/studio/integrations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ provider, measurementId, enabled: true }),
    });

    const payload = await response.json().catch(() => null);
    setSavingIntegration(false);
    if (!response.ok || !payload?.ok) {
      setMessage(payload?.error || 'The integration could not be saved.');
      return;
    }
    const next = integrations.filter((entry) => entry.provider !== provider);
    const saved = {
      provider,
      measurement_id: payload.data?.measurement_id || measurementId,
      enabled: payload.data?.enabled ?? true,
    };
    next.push(saved);
    setIntegrations(next);
    setIntegrationDrafts((current) => ({ ...current, [provider]: saved.measurement_id || '' }));
    setMessage('');
  }

  return (
    <div className="studio-content">
      <div className="page-title">
        <div>
          <div className="eyebrow">CREATOR INTELLIGENCE</div>
          <h1>Advanced Analytics</h1>
          <p>Use the existing creator analytics backend for traffic, sales, conversion, and attribution insights.</p>
        </div>
        <div className="row-actions">
          <select className="input" value={range} onChange={(event) => setRange(event.target.value)} aria-label="Analytics date range" style={{ maxWidth: 150 }}>
            {ranges.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
          <button className="btn" onClick={() => void exportCsv()}>Export CSV</button>
        </div>
      </div>

      {message && <div className="error-box">{message}</div>}

      {loading ? (
        <div className="loading-card card">Loading analytics…</div>
      ) : !hasAccess ? (
        <div className="card panel">
          <b>Analytics not available on your current plan</b>
          <p className="muted">Upgrade to the Creator plan for standard metrics or Pro/Max for advanced analytics.</p>
          <a className="btn btn-primary" href="/studio/billing">View plans</a>
        </div>
      ) : !hasData ? (
        <div className="card panel empty-state">
          <b>No analytics data yet</b>
          <span>Share your Link Hub, collect visits, and complete a checkout to populate the reports below.</span>
        </div>
      ) : (
        <>
          <div className="stats">
            <div className="card stat"><div className="label2">Page views</div><div className="value">{analytics.summary.pageViews}</div></div>
            <div className="card stat"><div className="label2">Link clicks</div><div className="value">{analytics.summary.linkClicks}</div></div>
            <div className="card stat"><div className="label2">CTR</div><div className="value">{formatPercent(analytics.summary.ctr)}</div></div>
            <div className="card stat"><div className="label2">Products sold</div><div className="value">{analytics.summary.productsSold}</div></div>
            <div className="card stat"><div className="label2">Revenue</div><div className="value">{formatCurrency(analytics.summary.revenue)}</div></div>
            <div className="card stat"><div className="label2">Conversion rate</div><div className="value">{formatPercent(analytics.summary.conversionRate)}</div></div>
            <div className="card stat"><div className="label2">AOV</div><div className="value">{analytics.summary.aov === null ? '—' : formatCurrency(analytics.summary.aov)}</div></div>
            <div className="card stat"><div className="label2">Unique visitors</div><div className="value">{analytics.summary.uniqueVisitors}</div></div>
          </div>

          <div className="dashboard-grid" style={{ marginTop: 14 }}>
            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">TRENDS</div><h3>Over time</h3></div></div>
              {analytics.summary.trend.length ? (
                <div className="mini-list">
                  {analytics.summary.trend.slice(-7).map((item) => (
                    <div className="mini-list-row" key={item.date}>
                      <span>{new Date(item.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })}</span>
                      <b>{item.visits} visits · {item.clicks} clicks</b>
                    </div>
                  ))}
                </div>
              ) : <div className="empty-state"><b>No trend data</b><span>Daily traffic appears as soon as visitors arrive.</span></div>}
            </div>

            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">TRAFFIC</div><h3>Sources</h3></div></div>
              {analytics.summary.sources.length ? (
                <div className="mini-list">
                  {analytics.summary.sources.slice(0, 8).map(([source, total]) => <div className="mini-list-row" key={source}><span>{source || 'Direct'}</span><b>{total}</b></div>)}
                </div>
              ) : <div className="empty-state"><b>No source data</b><span>UTM and referrer data appears once traffic is captured.</span></div>}
            </div>

            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">REFERRERS</div><h3>Top referrers</h3></div></div>
              {analytics.summary.referrers.length ? (
                <div className="mini-list">
                  {analytics.summary.referrers.slice(0, 8).map(([referrer, total]) => <div className="mini-list-row" key={referrer}><span>{referrer === 'Direct / unknown' ? 'Direct / unknown' : referrer}</span><b>{total}</b></div>)}
                </div>
              ) : <div className="empty-state"><b>No referrers</b><span>Visitor referrers appear after a visit from another source.</span></div>}
            </div>
          </div>

          <div className="dashboard-grid" style={{ marginTop: 14 }}>
            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">LINKS</div><h3>Link performance</h3></div></div>
              {analytics.summary.linkPerformance.length ? (
                <div className="mini-list">
                  {analytics.summary.linkPerformance.slice(0, 8).map((row) => (
                    <div className="mini-list-row" key={row.label}>
                      <span>{row.label}</span>
                      <b>{row.clicks} clicks · {formatCurrency(row.revenue)}</b>
                    </div>
                  ))}
                </div>
              ) : <div className="empty-state"><b>No link clicks</b><span>Link performance appears as visitors click your published links.</span></div>}
            </div>

            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">DEVICES</div><h3>Device breakdown</h3></div></div>
              {analytics.summary.devices.length ? (
                <div className="mini-list">
                  {analytics.summary.devices.map(([device, total]) => <div className="mini-list-row" key={device}><span>{device}</span><b>{total}</b></div>)}
                </div>
              ) : <div className="empty-state"><b>No device data</b><span>Device metadata is recorded automatically from visitor sessions.</span></div>}
            </div>

            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">COUNTRY</div><h3>Locations</h3></div></div>
              {analytics.summary.countries.length ? (
                <div className="mini-list">
                  {analytics.summary.countries.slice(0, 8).map(([country, total]) => <div className="mini-list-row" key={country}><span>{country}</span><b>{total}</b></div>)}
                </div>
              ) : <div className="empty-state"><b>No country data</b><span>Country is recorded when the request includes a reliable geolocation signal.</span></div>}
            </div>
          </div>

          {hasAdvanced && (
            <>
              <div className="dashboard-grid" style={{ marginTop: 14 }}>
                <div className="card panel">
                  <div className="panel-head"><div><div className="eyebrow">UTM</div><h3>Campaign / UTM report</h3></div></div>
                  {analytics.summary.utmReport.length ? (
                    <div className="mini-list">
                      {analytics.summary.utmReport.slice(0, 8).map((row) => (
                        <div className="mini-list-row" key={`${row.utm_source}-${row.utm_medium}-${row.utm_campaign}-${row.utm_content}-${row.utm_term}`}>
                          <span>{row.utm_campaign || 'Untitled campaign'} · {row.utm_source || 'unknown'} / {row.utm_medium || 'unknown'}</span>
                          <b>{row.visits} visits · {row.clicks} clicks · {row.purchases} purchases</b>
                        </div>
                      ))}
                    </div>
                  ) : <div className="empty-state"><b>No campaign data</b><span>UTM tracking appears once a campaign URL includes source and campaign parameters.</span></div>}
                  <div className="info-note" style={{ marginTop: 12 }}>Includes utm_content and utm_term when available in tracking URLs.</div>
                </div>

                <div className="card panel">
                  <div className="panel-head"><div><div className="eyebrow">REVENUE</div><h3>Revenue analytics</h3></div></div>
                  <div className="mini-list">
                    <div className="mini-list-row"><span>Revenue by source</span><b>{analytics.summary.revenueBreakdown.bySource.length ? formatCurrency(analytics.summary.revenueBreakdown.bySource[0].revenue) : '—'}</b></div>
                    <div className="mini-list-row"><span>Revenue by link</span><b>{analytics.summary.revenueBreakdown.byLink.length ? formatCurrency(analytics.summary.revenueBreakdown.byLink[0].revenue) : '—'}</b></div>
                    <div className="mini-list-row"><span>Revenue by campaign</span><b>{analytics.summary.revenueBreakdown.byCampaign.length ? formatCurrency(analytics.summary.revenueBreakdown.byCampaign[0].revenue) : '—'}</b></div>
                    <div className="mini-list-row"><span>Revenue by product</span><b>{analytics.summary.revenueBreakdown.byProduct.length ? formatCurrency(analytics.summary.revenueBreakdown.byProduct[0].revenue) : '—'}</b></div>
                    <div className="mini-list-row"><span>Unattributed revenue</span><b>{formatCurrency(analytics.summary.revenueBreakdown.unattributed)}</b></div>
                  </div>
                </div>

                <div className="card panel">
                  <div className="panel-head"><div><div className="eyebrow">BEST</div><h3>Top performers</h3></div></div>
                  <div className="mini-list">
                    <div className="mini-list-row"><span>Top link</span><b>{analytics.summary.topLinks[0]?.label || '—'}</b></div>
                    <div className="mini-list-row"><span>Top source</span><b>{analytics.summary.revenueBreakdown.bySource[0]?.source || '—'}</b></div>
                    <div className="mini-list-row"><span>Top campaign</span><b>{analytics.summary.revenueBreakdown.byCampaign[0]?.campaign || '—'}</b></div>
                    <div className="mini-list-row"><span>Top product</span><b>{analytics.summary.revenueBreakdown.byProduct[0]?.title || '—'}</b></div>
                  </div>
                </div>
              </div>

              <div className="dashboard-grid" style={{ marginTop: 14 }}>
                <div className="card panel">
                  <div className="panel-head"><div><div className="eyebrow">DETAILS</div><h3>Top link performance</h3></div></div>
                  {analytics.summary.topLinks.length ? (
                    <div className="mini-list">
                      {analytics.summary.topLinks.map((row) => (
                        <div className="mini-list-row" key={row.label}>
                          <span>{row.label}</span>
                          <b>{row.clicks} clicks · {formatPercent(row.ctr)} · {row.checkouts} checkouts · {row.purchases} purchases · {formatCurrency(row.revenue)}</b>
                        </div>
                      ))}
                    </div>
                  ) : <div className="empty-state"><b>No link data</b><span>Track real clicks and conversions to see top-performing links here.</span></div>}
                </div>

                <div className="card panel">
                  <div className="panel-head"><div><div className="eyebrow">PRODUCTS</div><h3>Product revenue</h3></div></div>
                  {analytics.summary.revenueBreakdown.byProduct.length ? (
                    <div className="mini-list">
                      {analytics.summary.revenueBreakdown.byProduct.slice(0, 6).map((row) => (
                        <div className="mini-list-row" key={row.title}>
                          <span>{row.title}</span>
                          <b>{formatCurrency(row.revenue)} · {row.units} units</b>
                        </div>
                      ))}
                    </div>
                  ) : <div className="empty-state"><b>No product revenue</b><span>Completed paid orders add product-level revenue here.</span></div>}
                </div>

                <div className="card panel">
                  <div className="panel-head"><div><div className="eyebrow">PLAN</div><h3>Plan access</h3></div></div>
                  <div className="mini-list">
                    <div className="mini-list-row"><span>Free</span><b>Basic</b></div>
                    <div className="mini-list-row"><span>Creator</span><b>Standard</b></div>
                    <div className="mini-list-row"><span>Pro</span><b>Advanced</b></div>
                    <div className="mini-list-row"><span>Max</span><b>Advanced + Pixel</b></div>
                  </div>
                  <div className="info-note" style={{ marginTop: 12 }}>Current plan visibility: {planSummary} · Free → Basic, Creator → Standard, Pro → Advanced, Max → Advanced + integrations</div>
                </div>
              </div>
            </>
          )}

          <div className="dashboard-grid" style={{ marginTop: 14 }}>
            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">EXPORT</div><h3>CSV export</h3></div></div>
              <p className="muted" style={{ margin: 0 }}>Export the active creator-scoped analytics window with the existing studio export backend. The file respects the selected date range and creator permissions.</p>
            </div>

            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">INTEGRATIONS</div><h3>Pixels & analytics</h3></div></div>
              {hasMaxIntegrations ? (
                <div style={{ display: 'grid', gap: 12 }}>
                  {(['google_analytics', 'meta_pixel', 'tiktok_pixel'] as const).map((provider) => {
                    const item = integrations.find((entry) => entry.provider === provider);
                    const currentId = integrationDrafts[provider] || item?.measurement_id || '';
                    const configured = Boolean(item?.enabled && currentId);
                    return (
                      <div key={provider} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <b>{providerLabels[provider]}</b>
                          <span className="muted">{configured ? 'Saved' : 'Not configured'}</span>
                        </div>
                        <input
                          className="input"
                          value={currentId}
                          onChange={(event) => setIntegrationDrafts((current) => ({ ...current, [provider]: event.target.value }))}
                          placeholder={provider === 'google_analytics' ? 'G-XXXXXXXXXX' : provider === 'meta_pixel' ? '123456789012345' : 'C-XXXXXXXX'}
                        />
                        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm" onClick={() => void saveIntegration(provider)} disabled={savingIntegration}>
                            {savingIntegration ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : <div className="empty-state"><b>Upgrade required</b><span>Analytics pixels are available on the Max plan only.</span></div>}
            </div>

            <div className="card panel">
              <div className="panel-head"><div><div className="eyebrow">EVENTS</div><h3>Custom conversion events</h3></div></div>
              <p className="muted" style={{ margin: 0 }}>This workspace only exposes the supported system events already recorded by the backend. No arbitrary scripts or SQL-backed custom events are exposed here.</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
