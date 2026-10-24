import { createHmac, timingSafeEqual } from 'node:crypto';

const API_BASE = 'https://api.razorpay.com/v1';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} server environment variable.`);
  return value;
}

export type BillingEnvironment = 'test' | 'live';

export function getBillingEnvironment(): BillingEnvironment {
  const raw = String(process.env.SELLORA_BILLING_RAZORPAY_MODE || (process.env.PAYMENTS_LIVE_ENABLED === 'true' ? 'live' : 'test')).toLowerCase();
  return raw === 'live' ? 'live' : 'test';
}

export function getBillingAuth() {
  const environment = getBillingEnvironment();
  const keyId = (process.env.SELLORA_BILLING_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.SELLORA_BILLING_RAZORPAY_KEY_SECRET || process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId) required('SELLORA_BILLING_RAZORPAY_KEY_ID');
  if (!keySecret) required('SELLORA_BILLING_RAZORPAY_KEY_SECRET');
  if (environment === 'live' && !keyId.startsWith('rzp_live_')) throw new Error(`Billing mode is live but the configured Razorpay key is ${keyId.startsWith('rzp_test_') ? 'a test key' : 'invalid'}. Restart the server after correcting SELLORA_BILLING_RAZORPAY_MODE and the matching key.`);
  if (environment === 'test' && !keyId.startsWith('rzp_test_')) throw new Error(`Billing mode is test but the configured Razorpay key is ${keyId.startsWith('rzp_live_') ? 'a live key' : 'invalid'}. Restart the server after correcting SELLORA_BILLING_RAZORPAY_MODE and the matching key.`);
  return { environment, keyId, keySecret };
}

export function getBillingPublicKey() {
  return getBillingAuth().keyId;
}

async function razorpayFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { keyId, keySecret } = getBillingAuth();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
    ...(init?.headers as Record<string, string> | undefined || {}),
  };
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: 'no-store' });
  const raw = await response.text();
  let body: any = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) throw new Error(`Razorpay API error: ${body?.error?.description || response.statusText}`);
  return body as T;
}

export type RazorpayPlan = {
  id: string;
  entity: 'plan';
  period: string;
  interval: number;
  item?: { id?: string; name?: string; amount?: number; currency?: string; description?: string };
  created_at?: number;
};

export type RazorpaySubscription = {
  id: string;
  entity: 'subscription';
  plan_id: string;
  customer_id?: string | null;
  status: string;
  current_start?: number | null;
  current_end?: number | null;
  charge_at?: number | null;
  start_at?: number | null;
  end_at?: number | null;
  total_count?: number | null;
  paid_count?: number | null;
  remaining_count?: number | null;
  quantity?: number | null;
  customer_notify?: boolean;
  customer_email?: string | null;
  customer_contact?: string | null;
  short_url?: string | null;
  has_scheduled_changes?: boolean;
  change_scheduled_at?: number | null;
  schedule_change_at?: 'now' | 'cycle_end' | null;
  created_at?: number;
  notes?: Record<string, string>;
};

export type RazorpayPayment = {
  id: string;
  entity: 'payment';
  amount: number;
  currency: string;
  status: string;
  invoice_id?: string | null;
  method?: string | null;
  created_at?: number;
  captured?: boolean;
};

export async function createBillingPlan(input: { name: string; amountMinor: number; currency: string; description: string; billingPeriod?: 'monthly' | 'yearly'; notes?: Record<string, string> }) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error('Paid Razorpay plans require a positive whole-unit amount in minor currency units.');
  return razorpayFetch<RazorpayPlan>('/plans', {
    method: 'POST',
    body: JSON.stringify({
      period: input.billingPeriod === 'yearly' ? 'yearly' : 'monthly',
      interval: 1,
      item: { name: input.name, amount: input.amountMinor, currency: input.currency, description: input.description },
      notes: input.notes || {},
    }),
  });
}

export async function ensureBillingPlanProvisioned(input: {
  planKey: string;
  planName: string;
  amountMinor: number;
  currency: string;
  billingPeriod: 'monthly' | 'yearly';
  environment: BillingEnvironment;
  versionId: string;
  updateVersion: (payload: Record<string, unknown>) => Promise<void> | void;
}) {
  const amount = Number(input.amountMinor);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Plan amount is invalid.');

  const providerPlan = await createBillingPlan({
    name: `TABLELY ${input.planName}`,
    amountMinor: amount,
    currency: String(input.currency || 'INR').toUpperCase(),
    description: `${input.planName} subscription`,
    billingPeriod: input.billingPeriod,
    notes: {
      sellora_plan_key: input.planKey,
      sellora_plan_version_id: input.versionId,
      environment: input.environment,
    },
  });

  await input.updateVersion({
    provider_plan_id: providerPlan.id,
    status: 'current',
    is_current: true,
    provisioned_at: new Date().toISOString(),
    provisioning_error: null,
  });

  return providerPlan;
}

export async function createBillingSubscription(input: { planId: string; totalCount?: number; notes?: Record<string, string>; startAt?: number }) {
  const body: Record<string, unknown> = {
    plan_id: input.planId,
    total_count: input.totalCount ?? 100,
    quantity: 1,
    customer_notify: true,
    notes: input.notes || {},
  };
  if (input.startAt) body.start_at = input.startAt;
  return razorpayFetch<RazorpaySubscription>('/subscriptions', { method: 'POST', body: JSON.stringify(body) });
}

export async function fetchBillingSubscription(subscriptionId: string) {
  return razorpayFetch<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

export async function fetchBillingPayment(paymentId: string) {
  return razorpayFetch<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`);
}

export async function updateBillingSubscription(subscriptionId: string, input: { planId?: string; scheduleChangeAt?: 'now' | 'cycle_end'; customerNotify?: boolean }) {
  const body: Record<string, unknown> = { customer_notify: input.customerNotify ?? true };
  if (input.planId) body.plan_id = input.planId;
  if (input.scheduleChangeAt) body.schedule_change_at = input.scheduleChangeAt;
  return razorpayFetch<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function cancelBillingSubscription(subscriptionId: string, cancelAtCycleEnd = true) {
  return razorpayFetch<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancel_at_cycle_end: cancelAtCycleEnd }),
  });
}

export async function cancelScheduledBillingUpdate(subscriptionId: string) {
  return razorpayFetch<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel_scheduled_changes`, {
    method: 'POST',
  });
}

export async function fetchScheduledBillingUpdate(subscriptionId: string) {
  return razorpayFetch<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}/retrieve_scheduled_changes`);
}

export async function fetchBillingSubscriptionInvoices(subscriptionId: string) {
  return razorpayFetch<{ count?: number; items?: Array<Record<string, unknown>> }>(`/subscriptions/${encodeURIComponent(subscriptionId)}/invoices`);
}

export async function pauseBillingSubscription(subscriptionId: string, pauseAt: 'now' | number = 'now') {
  return razorpayFetch<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}/pause`, {
    method: 'POST',
    body: JSON.stringify({ pause_at: pauseAt }),
  });
}

export async function resumeBillingSubscription(subscriptionId: string, resumeAt: 'now' | number = 'now') {
  return razorpayFetch<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}/resume`, {
    method: 'POST',
    body: JSON.stringify({ resume_at: resumeAt }),
  });
}

function safeHexEqual(a: string, b: string) {
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function verifySubscriptionCheckoutSignature(paymentId: string, subscriptionId: string, signature: string) {
  const { keySecret } = getBillingAuth();
  const expected = createHmac('sha256', keySecret).update(`${paymentId}|${subscriptionId}`).digest('hex');
  return safeHexEqual(expected, signature);
}

export function validateBillingWebhook(rawBody: string, signature: string | null) {
  if (!signature) return false;
  const secret = (process.env.SELLORA_BILLING_RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
  if (!secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeHexEqual(expected, signature);
}

export function unixToIso(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

export function isPaidSubscriptionStatus(status: string) {
  return ['authenticated', 'active', 'pending', 'paused'].includes(status);
}

export function isTerminalSubscriptionStatus(status: string) {
  return ['cancelled', 'completed', 'expired', 'failed'].includes(status);
}
