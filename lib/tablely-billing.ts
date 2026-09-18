import crypto from 'node:crypto';

type RazorpaySubscription = {
  id: string;
  plan_id: string;
  status?: string;
  current_start?: number;
  current_end?: number;
  start_at?: number;
  end_at?: number;
  charge_at?: number;
  total_count?: number;
  paid_count?: number;
  remaining_count?: number;
  short_url?: string;
};

type RazorpayPlan = { id: string; period: string; interval: number; item?: { id?: string; name?: string; amount?: number; currency?: string }; notes?: Record<string, string>; created_at?: number };
type RazorpayInvoice = { id: string; status?: string; amount?: number; amount_paid?: number; currency?: string; date?: number; issued_at?: number; billing_start?: number; billing_end?: number; short_url?: string; description?: string };
type InvoiceCollection = { count: number; items: RazorpayInvoice[] };
type RazorpayPlanCollection = { count: number; items: RazorpayPlan[] };

type BillingConfig = { keyId: string; secret: string; webhookSecret: string; environment: string };

function getConfig(): BillingConfig | null {
  const keyId = process.env.TABLELY_RAZORPAY_KEY_ID?.trim();
  const secret = process.env.TABLELY_RAZORPAY_KEY_SECRET?.trim();
  const webhookSecret = process.env.TABLELY_RAZORPAY_WEBHOOK_SECRET?.trim() || '';
  const environment = process.env.TABLELY_RAZORPAY_ENVIRONMENT?.trim().toLowerCase() || 'test';
  if (!keyId || !secret) return null;
  return { keyId, secret, webhookSecret, environment };
}

function authHeader(config: BillingConfig) {
  return `Basic ${Buffer.from(`${config.keyId}:${config.secret}`).toString('base64')}`;
}

async function razorpayRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = getConfig();
  if (!config) throw new Error('TABLELY_RAZORPAY_NOT_CONFIGURED');
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(config),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const description = body && typeof body === 'object' && 'error' in body
      ? String((body as { error?: { description?: unknown } }).error?.description || '')
      : '';
    throw new Error(description || `RAZORPAY_HTTP_${response.status}`);
  }
  return body as T;
}

export function getTablelyBillingConfigStatus() {
  const config = getConfig();
  return {
    configured: Boolean(config),
    environment: config?.environment || 'not-configured',
    webhookConfigured: Boolean(config?.webhookSecret),
    publicKey: config?.keyId || null,
  };
}

export async function createTablelyPlan(input: { name: string; description?: string; amountRupees: number; currency?: string; period?: 'monthly' | 'yearly'; provisioningId?: string }) {
  return razorpayRequest<RazorpayPlan>('/plans', {
    method: 'POST',
    body: JSON.stringify({
      period: input.period ?? 'monthly',
      interval: 1,
      item: {
        name: input.name,
        description: input.description || `TABLELY ${input.name} subscription`,
        amount: Math.round(input.amountRupees * 100),
        currency: input.currency || 'INR',
      },
      notes: {
        tablely_plan: input.name.toUpperCase(),
        ...(input.provisioningId ? { tablely_provisioning_id: input.provisioningId } : {}),
      },
    }),
  });
}

export async function fetchTablelyPlan(providerPlanId: string) {
  return razorpayRequest<RazorpayPlan>(`/plans/${encodeURIComponent(providerPlanId)}`);
}

export async function findTablelyPlanByProvisioningId(input: { provisioningId: string; createdAt?: string | null }) {
  const from = input.createdAt ? Math.max(0, Math.floor(new Date(input.createdAt).getTime() / 1000) - 3600) : Math.floor(Date.now() / 1000) - 86400;
  const to = Math.floor(Date.now() / 1000) + 60;
  for (let skip = 0; skip <= 1000; skip += 100) {
    const result = await razorpayRequest<RazorpayPlanCollection>(`/plans?from=${from}&to=${to}&count=100&skip=${skip}`);
    const match = (result.items ?? []).find((plan) => plan.notes?.tablely_provisioning_id === input.provisioningId);
    if (match) return match;
    if (!result.items || result.items.length < 100) return null;
  }
  return null;
}

// Razorpay caps total_count per plan period, and the cap for a yearly plan is far
// below the monthly one, so a single hardcoded 1200 is rejected for annual plans.
// Both values below are ten years of billing cycles.
const SUBSCRIPTION_TOTAL_COUNT: Record<'month' | 'year', number> = { month: 120, year: 10 };

export async function createTablelySubscription(input: { providerPlanId: string; organizationId: string; planId: string; interval?: 'month' | 'year'; customerNotify?: boolean }) {
  const interval = input.interval ?? 'month';
  return razorpayRequest<RazorpaySubscription>('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      plan_id: input.providerPlanId,
      total_count: SUBSCRIPTION_TOTAL_COUNT[interval],
      quantity: 1,
      customer_notify: input.customerNotify ?? false,
      notes: {
        tablely_organization_id: input.organizationId,
        tablely_plan_id: input.planId,
        tablely_billing_interval: interval,
      },
    }),
  });
}

export async function fetchTablelySubscription(providerSubscriptionId: string) {
  return razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
}

export async function fetchTablelySubscriptionInvoices(providerSubscriptionId: string) {
  return razorpayRequest<InvoiceCollection>(`/invoices?subscription_id=${encodeURIComponent(providerSubscriptionId)}`);
}

export async function updateTablelySubscription(providerSubscriptionId: string, input: { planId?: string; scheduleChangeAt?: 'now' | 'cycle_end'; quantity?: number }) {
  const body: Record<string, unknown> = {};
  if (input.planId) body.plan_id = input.planId;
  if (input.quantity) body.quantity = input.quantity;
  if (input.scheduleChangeAt) body.schedule_change_at = input.scheduleChangeAt;
  return razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function cancelTablelySubscription(providerSubscriptionId: string, cancelAtCycleEnd = true) {
  return razorpayRequest<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(providerSubscriptionId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancel_at_cycle_end: cancelAtCycleEnd }),
  });
}

export function verifyTablelySubscriptionSignature(input: { paymentId: string; subscriptionId: string; signature: string }) {
  const config = getConfig();
  if (!config) return false;
  const digest = crypto.createHmac('sha256', config.secret).update(`${input.paymentId}|${input.subscriptionId}`).digest('hex');
  const expected = Buffer.from(digest);
  const provided = Buffer.from(input.signature);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

export function verifyTablelyWebhookSignature(rawBody: string, signature: string) {
  const config = getConfig();
  if (!config?.webhookSecret || !signature) return false;
  const digest = crypto.createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');
  const expected = Buffer.from(digest);
  const provided = Buffer.from(signature);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

export function unixToIso(value?: number | null) {
  return value ? new Date(value * 1000).toISOString() : null;
}
