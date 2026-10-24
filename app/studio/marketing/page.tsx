'use client';

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { supabase } from '../../lib/supabase';

type Subscriber = {
  id: string;
  email: string;
  status?: string;
  source?: string;
  created_at?: string;
};

type Segment = {
  id: string;
  name: string;
  definition?: Record<string, unknown>;
};

type Campaign = {
  id: string;
  name: string;
  subject: string;
  status: string;
  scheduled_at?: string | null;
  sent_at?: string | null;
};

type MarketingData = {
  subscribers: Subscriber[];
  segments: Segment[];
  campaigns: Campaign[];
  tags: Array<{ id: string; name: string }>;
};

type CampaignMetric = {
  id: string;
  name: string;
  subject: string;
  status: string;
  recipients: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  failed: number;
  bounced: number;
  openRate: number;
  clickRate: number;
  unsubscribeRate: number;
  bounceRate: number;
  sentAt?: string | null;
};

type Condition = {
  field: string;
  operator: string;
  value: string;
};

const SEGMENT_FIELDS = [
  { value: 'status', label: 'Status' },
  { value: 'tags', label: 'Tag' },
  { value: 'source', label: 'Source' },
  { value: 'product_purchased', label: 'Purchased product' },
  { value: 'has_purchased', label: 'Has purchased' },
  { value: 'purchase_count', label: 'Purchase count' },
  { value: 'total_spent', label: 'Total spent' },
  { value: 'last_purchase_date', label: 'Last purchase date' },
  { value: 'signup_date', label: 'Signup date' },
  { value: 'email_engagement', label: 'Email engagement' },
] as const;

const OPERATOR_MAP: Record<string, readonly string[]> = {
  status: ['equals', 'not_equals'],
  tags: ['contains', 'not_contains', 'in', 'not_in'],
  source: ['equals', 'not_equals', 'contains'],
  product_purchased: ['contains', 'not_contains', 'in', 'not_in'],
  has_purchased: ['equals', 'not_equals'],
  purchase_count: ['gt', 'gte', 'lt', 'lte', 'equals'],
  total_spent: ['gt', 'gte', 'lt', 'lte', 'equals'],
  last_purchase_date: ['after', 'before', 'equals'],
  signup_date: ['after', 'before', 'equals'],
  email_engagement: ['equals', 'not_equals'],
};

const TRIGGER_OPTIONS = [
  { value: 'new_subscriber', label: 'New subscriber' },
  { value: 'day_after_signup', label: 'Day after signup' },
  { value: 'customer_purchase', label: 'Customer purchase' },
  { value: 'segment_match', label: 'Segment match' },
] as const;

function defaultCondition(): Condition {
  return { field: 'status', operator: 'equals', value: 'active' };
}

function formatDate(value?: string | null) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return value;
  }
}

async function getAuthToken() {
  if (!supabase) return null;
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

async function callMarketingAction(action: string, payload: Record<string, unknown>) {
  const token = await getAuthToken();
  if (!token) throw new Error('Please sign in again.');

  const response = await fetch('/api/studio/marketing', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ action, ...payload }),
    cache: 'no-store',
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data?.error || 'Request failed.');
  }

  return data.data;
}

export default function MarketingPage() {
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState<'overview' | 'segments' | 'automations' | 'campaigns' | 'analytics'>('overview');
  const [data, setData] = useState<MarketingData>({ subscribers: [], segments: [], campaigns: [], tags: [] });
  const [campaignAnalytics, setCampaignAnalytics] = useState<CampaignMetric[]>([]);
  const [segmentName, setSegmentName] = useState('');
  const [segmentConnector, setSegmentConnector] = useState<'AND' | 'OR'>('AND');
  const [segmentConditions, setSegmentConditions] = useState<Condition[]>([defaultCondition()]);
  const [segmentPreview, setSegmentPreview] = useState<{ count: number; preview: Array<{ id: string; email: string; status?: string }> }>({ count: 0, preview: [] });
  const [campaignDraft, setCampaignDraft] = useState({
    name: '',
    subject: '',
    previewText: '',
    contentHtml: '<p>Hi there,</p><p>Thanks for being part of this community.</p>',
  });
  const [automation, setAutomation] = useState({
    triggerType: 'new_subscriber',
    campaignId: '',
    segmentId: '',
    enabled: true,
    delaySeconds: 86400,
    nextRunAt: '',
  });

  const stats = useMemo(() => ({
    subscribers: data.subscribers.length,
    segments: data.segments.length,
    campaigns: data.campaigns.length,
    automationRules: data.segments.length + data.campaigns.length,
  }), [data]);

  const load = async () => {
    setLoading(true);
    setMessage('');

    if (!supabase) {
      setLoading(false);
      return;
    }

    try {
      const token = await getAuthToken();
      if (!token) {
        setMessage('Please sign in again.');
        setLoading(false);
        return;
      }

      const response = await fetch('/api/studio/marketing', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error || 'Could not load marketing data.');
      }
      setData(payload.data || { subscribers: [], segments: [], campaigns: [], tags: [] });

      const analyticsResponse = await fetch('/api/studio/marketing?mode=campaign-analytics', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const analyticsPayload = await analyticsResponse.json();
      if (analyticsResponse.ok && analyticsPayload.ok) {
        setCampaignAnalytics(analyticsPayload.data || []);
      }
    } catch (error) {
      console.error('[marketing-page:load]', error);
      setMessage(error instanceof Error ? error.message : 'The Studio marketing data could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const updateCondition = (index: number, field: keyof Condition, value: string) => {
    setSegmentConditions((current) => current.map((condition, conditionIndex) => {
      if (conditionIndex !== index) return condition;
      if (field === 'field') {
        const normalized = value;
        return {
          ...condition,
          field: normalized,
          operator: (OPERATOR_MAP[normalized] || ['equals'])[0],
          value: normalized === 'has_purchased' ? 'true' : normalized === 'purchase_count' ? '1' : normalized === 'total_spent' ? '0' : 'active',
        };
      }
      if (field === 'operator') return { ...condition, operator: value };
      return { ...condition, value };
    }));
  };

  const addCondition = () => setSegmentConditions((current) => [...current, defaultCondition()]);

  const removeCondition = (index: number) => {
    setSegmentConditions((current) => (current.length > 1 ? current.filter((_, conditionIndex) => conditionIndex !== index) : [defaultCondition()]));
  };

  const evaluateSegment = async () => {
    try {
      const result = await callMarketingAction('evaluate_segment', {
        definition: { connector: segmentConnector, conditions: segmentConditions },
      });
      setSegmentPreview(result || { count: 0, preview: [] });
      setMessage('Segment preview refreshed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to evaluate the segment.');
    }
  };

  const saveSegment = async () => {
    if (!segmentName.trim()) {
      setMessage('Give the segment a name first.');
      return;
    }
    try {
      await callMarketingAction('save_segment', {
        name: segmentName,
        definition: { connector: segmentConnector, conditions: segmentConditions },
      });
      setMessage('Segment saved.');
      setSegmentName('');
      setSegmentConditions([defaultCondition()]);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the segment.');
    }
  };

  const createCampaign = async () => {
    if (!campaignDraft.name.trim() || !campaignDraft.subject.trim() || !campaignDraft.contentHtml.trim()) {
      setMessage('Campaign name, subject, and content are required.');
      return;
    }
    try {
      await callMarketingAction('create_campaign', {
        name: campaignDraft.name,
        subject: campaignDraft.subject,
        previewText: campaignDraft.previewText,
        contentHtml: campaignDraft.contentHtml,
        audience: { type: 'all' },
      });
      setMessage('Campaign created as a draft.');
      setCampaignDraft({
        name: '',
        subject: '',
        previewText: '',
        contentHtml: '<p>Hi there,</p><p>Thanks for being part of this community.</p>',
      });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create the campaign.');
    }
  };

  const saveAutomationConfig = async () => {
    try {
      await callMarketingAction('configure_automation', {
        triggerType: automation.triggerType,
        campaignId: automation.campaignId,
        segmentId: automation.triggerType === 'segment_match' ? automation.segmentId : '',
        enabled: automation.enabled,
        delaySeconds: Number(automation.delaySeconds || 0),
        nextRunAt: automation.nextRunAt || null,
      });
      setMessage('Automation settings saved.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the automation.');
    }
  };

  const createCoupon = async () => {
    if (!supabase) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setMessage('Please sign in again.');
      return;
    }

    const code = (document.getElementById('coupon-code') as HTMLInputElement | null)?.value || '';
    const discount = (document.getElementById('coupon-value') as HTMLInputElement | null)?.value || '10';
    if (!code.trim()) {
      setMessage('Enter a valid coupon code.');
      return;
    }

    try {
      const response = await fetch('/api/marketing/manage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ action: 'create_coupon', code, discountValue: discount }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error || 'Could not create coupon.');
      setMessage('Coupon created.');
      if (document.getElementById('coupon-code')) (document.getElementById('coupon-code') as HTMLInputElement).value = '';
      if (document.getElementById('coupon-value')) (document.getElementById('coupon-value') as HTMLInputElement).value = '10';
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create coupon.');
    }
  };

  if (loading) {
    return <div style={wrapStyle}><div style={mutedStyle}>Loading marketing studio…</div></div>;
  }

  return (
    <div style={wrapStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 1.4, fontWeight: 700, color: '#7c3aed' }}>EMAIL & GROWTH</div>
          <h1 style={{ margin: '8px 0 0', fontSize: 32 }}>Marketing Studio</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {(['overview', 'segments', 'automations', 'campaigns', 'analytics'] as const).map((name) => (
            <button
              key={name}
              onClick={() => setTab(name)}
              style={{
                ...pillButton,
                background: tab === name ? '#111827' : '#fff',
                color: tab === name ? '#fff' : '#111827',
              }}
            >
              {name === 'campaigns' ? 'Campaigns' : name === 'analytics' ? 'Analytics' : name.charAt(0).toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {message ? <div style={noticeStyle}>{message}</div> : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        <StatCard label="Subscribers" value={stats.subscribers} />
        <StatCard label="Segments" value={stats.segments} />
        <StatCard label="Campaigns" value={stats.campaigns} />
        <StatCard label="Rules" value={stats.automationRules} />
      </div>

      {tab === 'overview' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20 }}>
          <div style={{ display: 'grid', gap: 20 }}>
            <Panel title="Segments" subtitle="Saved audience filters">
              {data.segments.length ? (
                data.segments.slice(0, 6).map((segment) => (
                  <div key={segment.id} style={rowBox}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{segment.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{(segment.definition?.conditions as Array<Record<string, unknown>> | undefined)?.length || 0} conditions</div>
                    </div>
                    <button
                      onClick={() => {
                        setSegmentName(segment.name);
                        setSegmentConnector(((segment.definition?.connector as 'AND' | 'OR') || 'AND'));
                        const conditions = Array.isArray(segment.definition?.conditions) ? segment.definition?.conditions as Array<Record<string, unknown>> : [];
                        setSegmentConditions(conditions.length ? conditions.map((condition) => ({
                          field: String(condition.field || 'status'),
                          operator: String(condition.operator || 'equals'),
                          value: String(condition.value ?? ''),
                        })) : [defaultCondition()]);
                        setTab('segments');
                      }}
                      style={secondaryButton}
                    >
                      Edit
                    </button>
                  </div>
                ))
              ) : (
                <div style={mutedStyle}>No segments yet.</div>
              )}
            </Panel>

            <Panel title="Campaigns" subtitle="Saved drafts and sends">
              {data.campaigns.length ? (
                data.campaigns.slice(0, 6).map((campaign) => (
                  <div key={campaign.id} style={rowBox}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{campaign.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{campaign.subject} · {campaign.status}</div>
                    </div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{formatDate(campaign.sent_at || campaign.scheduled_at)}</div>
                  </div>
                ))
              ) : (
                <div style={mutedStyle}>No campaigns yet.</div>
              )}
            </Panel>
          </div>

          <Panel title="Subscribers" subtitle="Recent list">
            <div style={{ display: 'grid', gap: 10 }}>
              {data.subscribers.slice(0, 8).map((subscriber) => (
                <div key={subscriber.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{subscriber.email}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{subscriber.source || 'Manual sign-up'}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#0f766e' }}>{subscriber.status || 'active'}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}

      {tab === 'segments' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 0.9fr', gap: 20 }}>
          <Panel title="Segment builder" subtitle="Create precise audience filters">
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12 }}>
                <input value={segmentName} onChange={(event) => setSegmentName(event.target.value)} placeholder="Segment name" style={inputStyle} />
                <select value={segmentConnector} onChange={(event) => setSegmentConnector(event.target.value as 'AND' | 'OR')} style={inputStyle}>
                  <option value="AND">Match all</option>
                  <option value="OR">Match any</option>
                </select>
              </div>

              {segmentConditions.map((condition, index) => (
                <div key={`condition-${index}`} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr auto', gap: 8 }}>
                  <select value={condition.field} onChange={(event) => updateCondition(index, 'field', event.target.value)} style={inputStyle}>
                    {SEGMENT_FIELDS.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
                  </select>
                  <select value={condition.operator} onChange={(event) => updateCondition(index, 'operator', event.target.value)} style={inputStyle}>
                    {(OPERATOR_MAP[condition.field] || ['equals']).map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                  </select>
                  <input value={condition.value} onChange={(event) => updateCondition(index, 'value', event.target.value)} style={inputStyle} placeholder="Value" />
                  <button onClick={() => removeCondition(index)} style={{ ...secondaryButton, borderColor: '#fecaca', color: '#991b1b' }}>Remove</button>
                </div>
              ))}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button onClick={addCondition} style={secondaryButton}>Add condition</button>
                <button onClick={evaluateSegment} style={{ ...primaryButton }}>Evaluate preview</button>
                <button onClick={saveSegment} style={{ ...primaryButton, background: '#7c3aed', color: '#fff', borderColor: '#7c3aed' }}>Save segment</button>
              </div>
            </div>
          </Panel>

          <Panel title="Preview" subtitle="Potential audience">
            <div style={{ display: 'grid', gap: 10 }}>
              <div style={{ fontSize: 30, fontWeight: 800 }}>{segmentPreview.count}</div>
              <div style={{ color: '#6b7280' }}>matching subscribers</div>
              {segmentPreview.preview.length ? (
                segmentPreview.preview.map((subscriber) => (
                  <div key={subscriber.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 10px' }}>
                    <div style={{ fontWeight: 600 }}>{subscriber.email}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{subscriber.status || 'active'}</div>
                  </div>
                ))
              ) : (
                <div style={mutedStyle}>No preview yet.</div>
              )}
            </div>
          </Panel>
        </div>
      )}

      {tab === 'automations' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 20 }}>
          <Panel title="Automation config" subtitle="Trigger emails by lifecycle events">
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <select value={automation.triggerType} onChange={(event) => setAutomation((current) => ({ ...current, triggerType: event.target.value }))} style={inputStyle}>
                  {TRIGGER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <select value={automation.campaignId} onChange={(event) => setAutomation((current) => ({ ...current, campaignId: event.target.value }))} style={inputStyle}>
                  <option value="">Choose campaign</option>
                  {data.campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
                </select>
              </div>

              {automation.triggerType === 'segment_match' && (
                <select value={automation.segmentId} onChange={(event) => setAutomation((current) => ({ ...current, segmentId: event.target.value }))} style={inputStyle}>
                  <option value="">Choose segment</option>
                  {data.segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}
                </select>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <input type="number" value={automation.delaySeconds} onChange={(event) => setAutomation((current) => ({ ...current, delaySeconds: Number(event.target.value) }))} style={inputStyle} placeholder="Delay seconds" />
                <input type="datetime-local" value={automation.nextRunAt} onChange={(event) => setAutomation((current) => ({ ...current, nextRunAt: event.target.value }))} style={inputStyle} />
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={automation.enabled} onChange={(event) => setAutomation((current) => ({ ...current, enabled: event.target.checked }))} />
                Automation enabled
              </label>

              <button onClick={saveAutomationConfig} style={{ ...primaryButton, background: '#7c3aed', color: '#fff', borderColor: '#7c3aed' }}>Save automation</button>
            </div>
          </Panel>

          <Panel title="Saved rules" subtitle="Current automation state">
            {data.segments.length || data.campaigns.length ? (
              <div style={{ display: 'grid', gap: 10 }}>
                {data.segments.slice(0, 4).map((segment) => (
                  <div key={segment.id} style={rowBox}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{segment.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>Segment audience</div>
                    </div>
                  </div>
                ))}
                {data.campaigns.slice(0, 4).map((campaign) => (
                  <div key={campaign.id} style={rowBox}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{campaign.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{campaign.status}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={mutedStyle}>No rules yet.</div>
            )}
          </Panel>
        </div>
      )}

      {tab === 'campaigns' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 20 }}>
          <Panel title="Create campaign" subtitle="Draft a new email send">
            <div style={{ display: 'grid', gap: 12 }}>
              <input value={campaignDraft.name} onChange={(event) => setCampaignDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Campaign name" style={inputStyle} />
              <input value={campaignDraft.subject} onChange={(event) => setCampaignDraft((current) => ({ ...current, subject: event.target.value }))} placeholder="Email subject" style={inputStyle} />
              <input value={campaignDraft.previewText} onChange={(event) => setCampaignDraft((current) => ({ ...current, previewText: event.target.value }))} placeholder="Preview text" style={inputStyle} />
              <textarea value={campaignDraft.contentHtml} onChange={(event) => setCampaignDraft((current) => ({ ...current, contentHtml: event.target.value }))} rows={10} style={{ ...inputStyle, minHeight: 180, resize: 'vertical' }} />
              <button onClick={createCampaign} style={{ ...primaryButton }}>Create draft</button>
            </div>
          </Panel>

          <Panel title="Recent campaigns" subtitle="Saved and scheduled sends">
            {data.campaigns.length ? (
              <div style={{ display: 'grid', gap: 10 }}>
                {data.campaigns.slice(0, 8).map((campaign) => (
                  <div key={campaign.id} style={rowBox}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{campaign.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{campaign.subject}</div>
                    </div>
                    <button
                      onClick={() => {
                        const when = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                        callMarketingAction('schedule_campaign', { campaignId: campaign.id, scheduledAt: when })
                          .then(() => {
                            setMessage('Campaign scheduled.');
                            void load();
                          })
                          .catch((error) => setMessage(error instanceof Error ? error.message : 'Could not schedule campaign.'));
                      }}
                      style={secondaryButton}
                    >
                      Schedule
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div style={mutedStyle}>No campaigns yet.</div>
            )}
          </Panel>
        </div>
      )}

      {tab === 'analytics' && (
        <div style={{ display: 'grid', gap: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
            <StatCard label="Total recipients" value={campaignAnalytics.reduce((sum, item) => sum + item.recipients, 0)} />
            <StatCard label="Open rate" value={Number((campaignAnalytics.length ? campaignAnalytics.reduce((sum, item) => sum + item.openRate, 0) / campaignAnalytics.length : 0).toFixed(1))} suffix="%" />
            <StatCard label="Click rate" value={Number((campaignAnalytics.length ? campaignAnalytics.reduce((sum, item) => sum + item.clickRate, 0) / campaignAnalytics.length : 0).toFixed(1))} suffix="%" />
            <StatCard label="Sent" value={campaignAnalytics.reduce((sum, item) => sum + item.sent, 0)} />
          </div>

          <Panel title="Campaign analytics" subtitle="Delivery, engagement, and funnel metrics">
            {campaignAnalytics.length ? (
              <div style={{ display: 'grid', gap: 12 }}>
                {campaignAnalytics.map((entry) => (
                  <div key={entry.id} style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{entry.name}</div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{entry.subject}</div>
                      </div>
                      <span style={{ fontSize: 12, padding: '6px 8px', borderRadius: 999, background: '#f3f4f6', color: '#374151' }}>{entry.status}</span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, marginTop: 14 }}>
                      <MetricPill label="Recipients" value={entry.recipients} />
                      <MetricPill label="Sent" value={entry.sent} />
                      <MetricPill label="Opened" value={entry.opened} />
                      <MetricPill label="Clicked" value={entry.clicked} />
                      <MetricPill label="Open rate" value={`${entry.openRate.toFixed(1)}%`} />
                      <MetricPill label="Click rate" value={`${entry.clickRate.toFixed(1)}%`} />
                      <MetricPill label="Bounce rate" value={`${entry.bounceRate.toFixed(1)}%`} />
                      <MetricPill label="Unsubscribed" value={`${entry.unsubscribeRate.toFixed(1)}%`} />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={mutedStyle}>No campaign analytics yet.</div>
            )}
          </Panel>
        </div>
      )}

      <Panel title="Growth tools" subtitle="Existing coupons and bundle controls">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20 }}>
          <div style={{ display: 'grid', gap: 12 }}>
            <h3 style={{ margin: 0 }}>Coupon codes</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 8 }}>
              <input id="coupon-code" placeholder="SAVE10" style={inputStyle} />
              <input id="coupon-value" defaultValue="10" type="number" min="1" max="100" style={inputStyle} />
            </div>
            <button onClick={createCoupon} style={{ ...primaryButton }}>Create coupon</button>
          </div>

          <div style={{ display: 'grid', gap: 12 }}>
            <h3 style={{ margin: 0 }}>Bundle</h3>
            <input value={campaignDraft.name} onChange={(event) => setCampaignDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Bundle title" style={inputStyle} />
            <input placeholder="Price" style={inputStyle} />
            <textarea placeholder="Description" rows={3} style={{ ...inputStyle, resize: 'vertical' }} />
            <button style={{ ...primaryButton, background: '#111827', color: '#fff' }}>Create bundle</button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function StatCard({ label, value, suffix = '' }: { label: string; value: number; suffix?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 16, padding: '16px 18px' }}>
      <div style={{ fontSize: 12, color: '#6b7280' }}>{label}</div>
      <div style={{ marginTop: 8, fontSize: 28, fontWeight: 800 }}>{value}{suffix}</div>
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: '8px 10px' }}>
      <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
      <div style={{ marginTop: 4, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 18, padding: 18 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 800 }}>{title}</div>
        <div style={{ marginTop: 4, fontSize: 12, color: '#6b7280' }}>{subtitle}</div>
      </div>
      {children}
    </div>
  );
}

const wrapStyle: CSSProperties = { padding: 24, display: 'grid', gap: 20 };
const inputStyle: CSSProperties = {
  width: '100%',
  background: '#fff',
  border: '1px solid #d0d5dd',
  borderRadius: 10,
  padding: '10px 12px',
  fontSize: 14,
  color: '#111827',
  boxSizing: 'border-box',
};
const primaryButton: CSSProperties = {
  border: '1px solid #111827',
  background: '#111827',
  color: '#fff',
  borderRadius: 10,
  padding: '9px 12px',
  fontWeight: 600,
  cursor: 'pointer',
};
const secondaryButton: CSSProperties = {
  border: '1px solid #d0d5dd',
  background: '#fff',
  color: '#111827',
  borderRadius: 10,
  padding: '9px 12px',
  fontWeight: 600,
  cursor: 'pointer',
};
const noticeStyle: CSSProperties = {
  background: '#f3e8ff',
  border: '1px solid #e9d5ff',
  borderRadius: 12,
  color: '#4c1d95',
  padding: '12px 16px',
};
const mutedStyle: CSSProperties = { color: '#6b7280' };
const rowBox: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 12,
};
const pillButton: CSSProperties = {
  borderRadius: 999,
  padding: '8px 14px',
  cursor: 'pointer',
  fontWeight: 600,
  border: '1px solid #d0d5dd',
};
