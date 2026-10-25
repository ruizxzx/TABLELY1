'use client';

import { useEffect, useMemo, useState } from 'react';

type Protocol = 'openai' | 'gemini' | 'anthropic';
type Provider = {
  id: string;
  name: string;
  slug: string;
  provider_type: string;
  protocol: Protocol;
  base_url: string;
  api_version: string | null;
  organization_id: string | null;
  credential_masked: string | null;
  has_credential: boolean;
  credential_status: string;
  enabled: boolean;
  priority: number;
  timeout_ms: number;
  retry_limit: number;
  max_requests_per_minute: number;
  last_test_status?: string | null;
};
type Model = {
  id: string;
  provider_id: string;
  model_key: string;
  display_name: string;
  capabilities: Record<string, boolean>;
  context_window: number | null;
  max_output_tokens: number | null;
  input_price_per_million: number | null;
  output_price_per_million: number | null;
  enabled: boolean;
  approved: boolean;
};
type Route = {
  feature_key: string;
  display_name: string;
  primary_model_id: string | null;
  fallback_model_ids: string[];
  enabled: boolean;
  max_tokens: number;
  daily_request_limit: number | null;
  max_file_bytes: number;
};
type Usage = {
  id: string;
  feature_key: string;
  provider_id: string | null;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number | null;
  latency_ms: number | null;
  succeeded: boolean;
  error_category: string | null;
  created_at: string;
  fallback_index: number;
};
type Data = {
  providers: Provider[];
  models: Model[];
  routes: Route[];
  settings: {
    monthly_budget: number | null;
    max_daily_requests: number | null;
    max_tokens_per_request: number;
    max_file_bytes: number;
  } | null;
  usage: Usage[];
  legacyEnvironmentConfigured: boolean;
};
type ProviderForm = Omit<Provider, 'id' | 'credential_masked' | 'has_credential' | 'credential_status' | 'last_test_status'> & {
  id?: string;
  api_key: string;
  has_credential?: boolean;
};
type ModelForm = {
  provider_id: string;
  model_key: string;
  display_name: string;
  capabilities: Record<string, boolean>;
  context_window: string;
  max_output_tokens: string;
  input_price_per_million: string;
  output_price_per_million: string;
  enabled: boolean;
  approved: boolean;
  id?: string;
};
type SettingsForm = {
  monthly_budget: string;
  max_daily_requests: string;
  max_tokens_per_request: string;
  max_file_bytes: string;
};
type DiscoveryModel = {
  id: string;
  display_name?: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  capabilities?: Record<string, boolean>;
};

const empty: Data = {
  providers: [],
  models: [],
  routes: [],
  settings: null,
  usage: [],
  legacyEnvironmentConfigured: false,
};
const providerPresets: Record<string, { name: string; slug: string; protocol: Protocol; base_url: string }> = {
  openrouter: { name: 'OpenRouter', slug: 'openrouter', protocol: 'openai', base_url: 'https://openrouter.ai/api/v1' },
  openai: { name: 'OpenAI', slug: 'openai', protocol: 'openai', base_url: 'https://api.openai.com/v1' },
  gemini: { name: 'Google Gemini', slug: 'gemini', protocol: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta' },
  anthropic: { name: 'Anthropic', slug: 'anthropic', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1' },
  deepseek: { name: 'DeepSeek', slug: 'deepseek', protocol: 'openai', base_url: 'https://api.deepseek.com' },
  groq: { name: 'Groq', slug: 'groq', protocol: 'openai', base_url: 'https://api.groq.com/openai/v1' },
  mistral: { name: 'Mistral', slug: 'mistral', protocol: 'openai', base_url: 'https://api.mistral.ai/v1' },
  together: { name: 'Together AI', slug: 'together', protocol: 'openai', base_url: 'https://api.together.xyz/v1' },
  fireworks: { name: 'Fireworks AI', slug: 'fireworks', protocol: 'openai', base_url: 'https://api.fireworks.ai/inference/v1' },
  custom: { name: 'Custom provider', slug: 'custom-provider', protocol: 'openai', base_url: '' },
};

function newProvider(type = 'openrouter'): ProviderForm {
  const preset = providerPresets[type];
  return {
    ...preset,
    provider_type: type,
    api_version: '',
    organization_id: '',
    api_key: '',
    enabled: true,
    priority: 100,
    timeout_ms: 45000,
    retry_limit: 1,
    max_requests_per_minute: 60,
  };
}

function newModel(providerId = ''): ModelForm {
  return {
    provider_id: providerId,
    model_key: '',
    display_name: '',
    capabilities: { text: true, image: false, document: false, structured_output: true, streaming: false, tool_calling: false },
    context_window: '',
    max_output_tokens: '',
    input_price_per_million: '',
    output_price_per_million: '',
    enabled: true,
    approved: true,
  };
}

async function post<T extends Record<string, unknown> = Record<string, unknown>>(
  action: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch('/api/admin/ai-management', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body as T;
}

export default function AiManagementPage() {
  const [data, setData] = useState<Data>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderForm>(newProvider());
  const [model, setModel] = useState<ModelForm>(newModel());
  const [settings, setSettings] = useState<SettingsForm>({
    monthly_budget: '',
    max_daily_requests: '',
    max_tokens_per_request: '4096',
    max_file_bytes: '15728640',
  });

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/ai-management', { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load AI management.');
      setData(result as Data);
      if (result.settings) {
        setSettings({
          monthly_budget: result.settings.monthly_budget == null ? '' : String(result.settings.monthly_budget),
          max_daily_requests: result.settings.max_daily_requests == null ? '' : String(result.settings.max_daily_requests),
          max_tokens_per_request: String(result.settings.max_tokens_per_request),
          max_file_bytes: String(result.settings.max_file_bytes),
        });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load AI management.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const modelsById = useMemo(() => new Map(data.models.map((item) => [item.id, item])), [data.models]);
  const enabledProviders = data.providers.filter((item) => item.enabled && item.has_credential).length;
  const successfulRequests = data.usage.filter((item) => item.succeeded).length;
  const failedRequests = data.usage.length - successfulRequests;
  const totalTokens = data.usage.reduce((total, item) => total + item.input_tokens + item.output_tokens, 0);
  const estimatedCost = data.usage.reduce((total, item) => total + Number(item.estimated_cost || 0), 0);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  function editProvider(item: Provider) {
    setProvider({ ...item, api_version: item.api_version || '', organization_id: item.organization_id || '', api_key: '' });
  }

  async function saveProvider() {
    await run(async () => {
      const saved = await post<{ id: string }>('save_provider', { provider });
      setProvider((current) => ({ ...current, id: saved.id, has_credential: true }));
      setModel((current) => ({ ...current, provider_id: saved.id }));
    }, provider.id ? 'Provider updated.' : 'Provider saved. The key is encrypted on the server.');
  }

  async function testProvider(item: Provider) {
    await run(() => post('test', { id: item.id }), `Connection succeeded for ${item.name}.`);
  }

  async function discoverModels(item: Provider) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await post<{ models?: DiscoveryModel[] }>('discover', { id: item.id });
      const discovered = result.models?.[0];
      if (!discovered) {
        setNotice('Connection succeeded. Enter the model ID supplied by your provider.');
        setModel(newModel(item.id));
        return;
      }
      setModel({
        ...newModel(item.id),
        model_key: discovered.id,
        display_name: discovered.display_name || discovered.id,
        context_window: discovered.context_window ? String(discovered.context_window) : '',
        max_output_tokens: discovered.max_output_tokens ? String(discovered.max_output_tokens) : '',
        capabilities: { ...newModel(item.id).capabilities, ...discovered.capabilities },
      });
      setNotice('A model was found. Review it below, then save it to enable routing.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Model discovery failed.');
    } finally {
      setBusy(false);
    }
  }

  async function saveModel() {
    const displayName = model.display_name.trim() || model.model_key.trim();
    await run(async () => {
      await post('save_model', {
        model: {
          ...model,
          display_name: displayName,
          context_window: model.context_window ? Number(model.context_window) : null,
          max_output_tokens: model.max_output_tokens ? Number(model.max_output_tokens) : null,
          input_price_per_million: model.input_price_per_million ? Number(model.input_price_per_million) : null,
          output_price_per_million: model.output_price_per_million ? Number(model.output_price_per_million) : null,
        },
      });
      setModel(newModel(model.provider_id));
    }, 'Model saved and approved for routing.');
  }

  async function saveRoute(route: Route) {
    await run(() => post('save_route', { route }), 'Feature routing updated.');
  }

  async function saveSettings() {
    await run(() => post('save_settings', {
      settings: {
        monthly_budget: settings.monthly_budget ? Number(settings.monthly_budget) : null,
        max_daily_requests: settings.max_daily_requests ? Number(settings.max_daily_requests) : null,
        max_tokens_per_request: Number(settings.max_tokens_per_request),
        max_file_bytes: Number(settings.max_file_bytes),
      },
    }), 'Usage controls saved.');
  }

  if (loading) {
    return <main className="admin-page"><div className="setup-loading">Loading AI management…</div></main>;
  }

  return (
    <main className="admin-page">
      <header className="admin-top">
        <div>
          <span className="eyebrow">TABLELY ADMIN</span>
          <h1>AI management</h1>
          <p>Connect one AI provider, add a model, and choose where TABLELY can use it.</p>
        </div>
        <div className="button-row">
          <a className="button button-light" href="/admin">Admin dashboard</a>
          <button className="button button-light" type="button" onClick={() => void load()}>Refresh</button>
        </div>
      </header>

      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
      {notice ? <div className="notice notice-success" role="status">{notice}</div> : null}
      {data.legacyEnvironmentConfigured ? (
        <div className="notice notice-error">
          Legacy AI environment credentials are present. Move the key to this page, confirm it works, then remove the old environment value.
        </div>
      ) : null}

      <section className="surface-card">
        <div className="card-heading">
          <div>
            <h2>1. Connect an AI provider</h2>
            <p>Choose your provider and paste its API key. TABLELY keeps the key encrypted and server-side.</p>
          </div>
        </div>
        <div className="admin-invite-grid">
          <label>
            Provider
            <select
              value={provider.provider_type}
              onChange={(event) => {
                const next = newProvider(event.target.value);
                setProvider((current) => ({ ...next, id: current.id, api_key: current.api_key }));
              }}
            >
              {Object.entries(providerPresets).map(([key, preset]) => <option key={key} value={key}>{preset.name}</option>)}
            </select>
          </label>
          <label>
            Provider API key
            <input
              type="password"
              autoComplete="new-password"
              placeholder={provider.id && provider.has_credential ? 'Saved; enter only to replace' : 'Paste provider API key'}
              value={provider.api_key}
              onChange={(event) => setProvider((current) => ({ ...current, api_key: event.target.value }))}
            />
          </label>
          <button
            className="button button-primary"
            type="button"
            disabled={busy || !provider.name || !provider.slug || !provider.base_url || (!provider.id && !provider.api_key.trim())}
            onClick={() => void saveProvider()}
          >
            {busy ? 'Saving…' : provider.id ? 'Save provider' : 'Connect provider'}
          </button>
          {provider.id && provider.has_credential ? (
            <button
              className="button button-light"
              type="button"
              disabled={busy}
              onClick={() => {
                const saved = data.providers.find((item) => item.id === provider.id);
                if (saved) void discoverModels(saved);
              }}
            >
              Find a model
            </button>
          ) : null}
        </div>

        <details>
          <summary>Advanced provider settings</summary>
          <div className="admin-invite-grid" style={{ marginTop: 16 }}>
            <label>Display name<input value={provider.name} onChange={(event) => setProvider((current) => ({ ...current, name: event.target.value }))} /></label>
            <label>Provider identifier<input value={provider.slug} onChange={(event) => setProvider((current) => ({ ...current, slug: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') }))} /></label>
            <label>API base URL<input value={provider.base_url} onChange={(event) => setProvider((current) => ({ ...current, base_url: event.target.value }))} /></label>
            <label>Protocol
              <select value={provider.protocol} onChange={(event) => setProvider((current) => ({ ...current, protocol: event.target.value as Protocol }))}>
                <option value="openai">OpenAI-compatible</option>
                <option value="gemini">Gemini</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
            <label>API version<input value={provider.api_version || ''} onChange={(event) => setProvider((current) => ({ ...current, api_version: event.target.value }))} /></label>
            <label>Organization/project ID<input value={provider.organization_id || ''} onChange={(event) => setProvider((current) => ({ ...current, organization_id: event.target.value }))} /></label>
            <label>Timeout (milliseconds)<input type="number" min="1000" max="120000" value={provider.timeout_ms} onChange={(event) => setProvider((current) => ({ ...current, timeout_ms: Number(event.target.value) }))} /></label>
            <label>Retries<input type="number" min="0" max="3" value={provider.retry_limit} onChange={(event) => setProvider((current) => ({ ...current, retry_limit: Number(event.target.value) }))} /></label>
            <label>Requests per minute<input type="number" min="1" value={provider.max_requests_per_minute} onChange={(event) => setProvider((current) => ({ ...current, max_requests_per_minute: Number(event.target.value) }))} /></label>
            <label className="inline-check"><input type="checkbox" checked={provider.enabled} onChange={(event) => setProvider((current) => ({ ...current, enabled: event.target.checked }))} /> Provider enabled</label>
          </div>
        </details>

        <details>
          <summary>Manage saved providers ({data.providers.length})</summary>
          <div className="data-table">
            {data.providers.map((item) => (
              <div className="data-row" key={item.id}>
                <div><strong>{item.name}</strong><span>{item.credential_masked || 'No key saved'} · {item.enabled ? 'Enabled' : 'Disabled'}</span></div>
                <span>{item.last_test_status || 'Not tested'}</span>
                <div className="button-row">
                  <button className="button button-light compact" type="button" disabled={busy || !item.has_credential} onClick={() => void testProvider(item)}>Test</button>
                  <button className="button button-light compact" type="button" onClick={() => editProvider(item)}>Edit</button>
                  <button className="button button-light compact" type="button" disabled={busy || !item.has_credential} onClick={() => void discoverModels(item)}>Find model</button>
                  <button className="button button-light compact" type="button" disabled={busy} onClick={() => void run(() => post('remove_credential', { id: item.id }), 'Provider key removed.')}>Remove key</button>
                </div>
              </div>
            ))}
            {!data.providers.length ? <div className="empty-wide">No providers saved yet.</div> : null}
          </div>
        </details>
      </section>

      <section className="surface-card">
        <div className="card-heading">
          <div>
            <h2>2. Add a model</h2>
            <p>Find a model automatically or enter the model ID from your provider. New models are enabled and approved when you save them here.</p>
          </div>
        </div>
        <div className="admin-invite-grid">
          <label>Provider
            <select value={model.provider_id} onChange={(event) => setModel((current) => ({ ...current, provider_id: event.target.value }))}>
              <option value="">Choose a saved provider</option>
              {data.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>Model ID
            <input value={model.model_key} placeholder="e.g. provider/model-name" onChange={(event) => setModel((current) => ({ ...current, model_key: event.target.value, display_name: current.display_name || event.target.value }))} />
          </label>
          <label>Display name<input value={model.display_name} placeholder="Optional" onChange={(event) => setModel((current) => ({ ...current, display_name: event.target.value }))} /></label>
          <button className="button button-primary" type="button" disabled={busy || !model.provider_id || !model.model_key.trim()} onClick={() => void saveModel()}>
            {busy ? 'Saving…' : model.id ? 'Update model' : 'Save model'}
          </button>
        </div>
        <details>
          <summary>Advanced model settings</summary>
          <div className="admin-invite-grid" style={{ marginTop: 16 }}>
            <label>Context window<input type="number" value={model.context_window} onChange={(event) => setModel((current) => ({ ...current, context_window: event.target.value }))} /></label>
            <label>Maximum output tokens<input type="number" value={model.max_output_tokens} onChange={(event) => setModel((current) => ({ ...current, max_output_tokens: event.target.value }))} /></label>
            <label>Input price per million tokens<input type="number" step="any" value={model.input_price_per_million} onChange={(event) => setModel((current) => ({ ...current, input_price_per_million: event.target.value }))} /></label>
            <label>Output price per million tokens<input type="number" step="any" value={model.output_price_per_million} onChange={(event) => setModel((current) => ({ ...current, output_price_per_million: event.target.value }))} /></label>
            <label>Capabilities (comma separated)
              <input
                value={Object.entries(model.capabilities).filter(([, enabled]) => enabled).map(([key]) => key).join(', ')}
                onChange={(event) => {
                  const selected = event.target.value.split(',').map((value) => value.trim());
                  setModel((current) => ({
                    ...current,
                    capabilities: Object.fromEntries(['text', 'image', 'document', 'structured_output', 'streaming', 'tool_calling'].map((key) => [key, selected.includes(key)])),
                  }));
                }}
              />
            </label>
            <label className="inline-check"><input type="checkbox" checked={model.enabled} onChange={(event) => setModel((current) => ({ ...current, enabled: event.target.checked }))} /> Model enabled</label>
            <label className="inline-check"><input type="checkbox" checked={model.approved} onChange={(event) => setModel((current) => ({ ...current, approved: event.target.checked }))} /> Approved for routing</label>
          </div>
        </details>
        <details>
          <summary>Saved models ({data.models.length})</summary>
          <div className="data-table">
            {data.models.map((item) => (
              <div className="data-row" key={item.id}>
                <div><strong>{item.display_name}</strong><span>{data.providers.find((p) => p.id === item.provider_id)?.name || 'Provider'} · {item.model_key}</span></div>
                <span>{item.enabled && item.approved ? 'Ready for routing' : 'Not active'}</span>
                <button
                  className="button button-light compact"
                  type="button"
                  onClick={() => setModel({
                    id: item.id,
                    provider_id: item.provider_id,
                    model_key: item.model_key,
                    display_name: item.display_name,
                    capabilities: item.capabilities,
                    context_window: item.context_window ? String(item.context_window) : '',
                    max_output_tokens: item.max_output_tokens ? String(item.max_output_tokens) : '',
                    input_price_per_million: item.input_price_per_million == null ? '' : String(item.input_price_per_million),
                    output_price_per_million: item.output_price_per_million == null ? '' : String(item.output_price_per_million),
                    enabled: item.enabled,
                    approved: item.approved,
                  })}
                >
                  Edit
                </button>
              </div>
            ))}
            {!data.models.length ? <div className="empty-wide">No models added yet.</div> : null}
          </div>
        </details>
      </section>

      <section className="surface-card">
        <div className="card-heading">
          <div>
            <h2>3. Choose what AI can do</h2>
            <p>Enable only the features you need and select an approved model. Customer menu translations in Hindi and Bengali use the Menu extraction route.</p>
          </div>
        </div>
        {data.routes.filter((route) => route.feature_key !== 'menu_translation').map((route) => {
          const primary = modelsById.get(route.primary_model_id || '');
          return (
            <RouteEditor
              key={route.feature_key}
              route={route}
              models={data.models}
              primaryLabel={primary?.display_name}
              busy={busy}
              onSave={saveRoute}
            />
          );
        })}
      </section>

      <details className="surface-card">
        <summary>Usage and advanced limits</summary>
        <div className="metric-grid" style={{ marginTop: 16 }}>
          {[
            ['Ready providers', enabledProviders],
            ['Requests recorded', data.usage.length],
            ['Successful', successfulRequests],
            ['Failed', failedRequests],
            ['Tokens', totalTokens.toLocaleString()],
            ['Estimated cost', estimatedCost ? estimatedCost.toFixed(4) : '—'],
          ].map(([label, value]) => (
            <div className="metric-card" key={String(label)}>
              <div className="metric-head"><span>{label}</span></div>
              <strong>{value}</strong>
              <small>{label === 'Estimated cost' ? 'Estimate from configured prices only' : 'Stored usage data'}</small>
            </div>
          ))}
        </div>
        <p>Cost estimates exclude usage without configured prices. These are not provider billing totals.</p>
        <div className="admin-invite-grid">
          <label>Monthly budget<input type="number" step="any" placeholder="No limit" value={settings.monthly_budget} onChange={(event) => setSettings((current) => ({ ...current, monthly_budget: event.target.value }))} /></label>
          <label>Daily request limit<input type="number" placeholder="No limit" value={settings.max_daily_requests} onChange={(event) => setSettings((current) => ({ ...current, max_daily_requests: event.target.value }))} /></label>
          <label>Tokens per request<input type="number" value={settings.max_tokens_per_request} onChange={(event) => setSettings((current) => ({ ...current, max_tokens_per_request: event.target.value }))} /></label>
          <label>Maximum file size (bytes)<input type="number" value={settings.max_file_bytes} onChange={(event) => setSettings((current) => ({ ...current, max_file_bytes: event.target.value }))} /></label>
          <button className="button button-primary" type="button" disabled={busy} onClick={() => void saveSettings()}>Save limits</button>
        </div>
        <details>
          <summary>Recent diagnostics ({data.usage.length})</summary>
          <div className="data-table">
            {data.usage.map((item) => (
              <div className="data-row" key={item.id}>
                <div><strong>{item.feature_key}</strong><span>{new Date(item.created_at).toLocaleString()}</span></div>
                <span>{data.providers.find((p) => p.id === item.provider_id)?.name || 'Provider removed'}</span>
                <span>{modelsById.get(item.model_id || '')?.model_key || 'Model'}</span>
                <span>{item.succeeded ? 'Success' : item.error_category || 'Failed'}</span>
                <span>{item.input_tokens + item.output_tokens} tokens · {item.latency_ms ?? '—'} ms · ${item.estimated_cost ?? '—'}</span>
              </div>
            ))}
            {!data.usage.length ? <div className="empty-wide">No AI usage recorded.</div> : null}
          </div>
        </details>
      </details>
    </main>
  );
}

function RouteEditor({
  route,
  models,
  primaryLabel,
  busy,
  onSave,
}: {
  route: Route;
  models: Model[];
  primaryLabel?: string;
  busy: boolean;
  onSave: (route: Route) => void;
}) {
  const [value, setValue] = useState(route);
  useEffect(() => setValue(route), [route]);
  const eligibleModels = models.filter((model) => model.enabled && model.approved);

  return (
    <div className="admin-invite-grid" style={{ borderBottom: '1px solid #e5e7eb', padding: '12px 0' }}>
      <label>
        {value.display_name}
        <select value={value.primary_model_id || ''} onChange={(event) => setValue((current) => ({ ...current, primary_model_id: event.target.value || null }))}>
          <option value="">Choose a model</option>
          {eligibleModels.map((model) => <option key={model.id} value={model.id}>{model.display_name}</option>)}
        </select>
        <small>{primaryLabel ? `Current model: ${primaryLabel}` : 'No model selected'}</small>
      </label>
      <label className="inline-check">
        <input type="checkbox" checked={value.enabled} onChange={(event) => setValue((current) => ({ ...current, enabled: event.target.checked }))} />
        Feature enabled
      </label>
      <button className="button button-primary" type="button" disabled={busy} onClick={() => onSave(value)}>Save</button>
      <details>
        <summary>Fallbacks and limits</summary>
        <div className="admin-invite-grid" style={{ marginTop: 12 }}>
          <label>Fallback models
            <select multiple value={value.fallback_model_ids} onChange={(event) => setValue((current) => ({ ...current, fallback_model_ids: Array.from(event.target.selectedOptions).map((option) => option.value) }))}>
              {eligibleModels.map((model) => <option key={model.id} value={model.id}>{model.display_name}</option>)}
            </select>
          </label>
          <label>Maximum output tokens<input type="number" value={value.max_tokens} onChange={(event) => setValue((current) => ({ ...current, max_tokens: Number(event.target.value) }))} /></label>
          <label>Daily feature request limit<input type="number" placeholder="No limit" value={value.daily_request_limit ?? ''} onChange={(event) => setValue((current) => ({ ...current, daily_request_limit: event.target.value ? Number(event.target.value) : null }))} /></label>
          <label>Maximum input file size (bytes)<input type="number" value={value.max_file_bytes} onChange={(event) => setValue((current) => ({ ...current, max_file_bytes: Number(event.target.value) }))} /></label>
        </div>
      </details>
    </div>
  );
}
