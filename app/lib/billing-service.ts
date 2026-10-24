import { getAdminSupabase } from './server-admin';
import { fetchBillingPayment, fetchBillingSubscription, type RazorpayPayment, type RazorpaySubscription, unixToIso } from './billing';

export async function syncSubscriptionFromProvider(subscriptionId: string) {
  const db = getAdminSupabase();
  const remote = await fetchBillingSubscription(subscriptionId);
  const { data: row, error } = await db
    .from('sellora_subscriptions')
    .select('id,creator_id,plan_key,variant_id,billing_period,plan_version_id,environment,status,provider_plan_id,amount_minor,currency,pending_plan_key,pending_variant_id,pending_billing_period,pending_plan_version_id')
    .eq('provider_subscription_id', subscriptionId)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error('Subscription is not registered in TABLELY.');
  await persistProviderSubscription(row.id, remote);
  return remote;
}

export async function persistProviderSubscription(localId: string, remote: RazorpaySubscription, eventAt?: string | null) {
  const db = getAdminSupabase();
  const now = new Date().toISOString();
  const { data: local, error: localError } = await db
    .from('sellora_subscriptions')
    .select('id,creator_id,plan_key,variant_id,billing_period,plan_version_id,environment,pending_plan_key,pending_variant_id,pending_billing_period,pending_plan_version_id,pending_change_at')
    .eq('id', localId)
    .maybeSingle();
  if (localError) throw localError;
  if (!local) throw new Error('Local subscription not found.');

  let mappedPlanKey = local.plan_key;
  let mappedPlanVersionId = local.plan_version_id;
  let mappedVariantId = local.variant_id;
  let mappedBillingPeriod = local.billing_period || 'monthly';
  let mappedAmountMinor: number | undefined;
  if (remote.plan_id) {
    const { data: version } = await db
      .from('sellora_plan_versions')
      .select('id,plan_key,variant_id,billing_period,amount_minor')
      .eq('environment', local.environment)
      .eq('provider_plan_id', remote.plan_id)
      .maybeSingle();
    if (version) {
      mappedPlanKey = version.plan_key;
      mappedPlanVersionId = version.id;
      mappedVariantId = version.variant_id;
      mappedBillingPeriod = version.billing_period || 'monthly';
      mappedAmountMinor = Number(version.amount_minor || 0);
    }
  }

  const patch: Record<string, unknown> = {
    provider_plan_id: remote.plan_id || null,
    provider_customer_id: remote.customer_id || null,
    customer_email: remote.customer_email || null,
    customer_contact: remote.customer_contact || null,
    status: String(remote.status || 'created'),
    plan_key: mappedPlanKey,
    variant_id: mappedVariantId,
    billing_period: mappedBillingPeriod,
    plan_version_id: mappedPlanVersionId,
    amount_minor: mappedAmountMinor ?? undefined,
    quantity: Number(remote.quantity || 1),
    total_count: remote.total_count ?? null,
    paid_count: Number(remote.paid_count || 0),
    remaining_count: remote.remaining_count ?? null,
    current_start: unixToIso(remote.current_start),
    current_end: unixToIso(remote.current_end),
    charge_at: unixToIso(remote.charge_at),
    start_at: unixToIso(remote.start_at),
    end_at: unixToIso(remote.end_at),
    // Razorpay returns `schedule_change_at` as the requested mode only on some
    // responses and `change_scheduled_at` as a timestamp for a pending update.
    // Preserve the local intent when the provider response only carries the
    // presence of a scheduled change; this is what keeps a pending downgrade
    // or cancellation visible between webhook/sync calls.
    cancel_at_period_end: Boolean(local.pending_plan_key === 'free' && remote.has_scheduled_changes) ||
      Boolean(local.pending_change_at === 'cycle_end' && remote.has_scheduled_changes && local.pending_plan_key === null),
    cancelled_at: ['cancelled', 'completed', 'expired'].includes(String(remote.status)) ? (unixToIso(remote.end_at) || now) : null,
    pending_change_at: remote.has_scheduled_changes ? (local.pending_change_at || 'cycle_end') : (mappedPlanKey !== local.plan_key ? null : local.pending_change_at || null),
    last_synced_at: now,
    last_provider_event_at: eventAt || now,
    updated_at: now,
    metadata: { provider_snapshot: remote },
  };
  if (mappedAmountMinor === undefined) delete patch.amount_minor;

  if (mappedPlanKey !== local.plan_key && remote.plan_id) {
    patch.pending_plan_key = null;
    patch.pending_variant_id = null;
    patch.pending_billing_period = null;
    patch.pending_plan_version_id = null;
    patch.pending_change_at = null;
  }

  const { error } = await db.from('sellora_subscriptions').update(patch).eq('id', localId);
  if (error) throw error;

  const { data: sub, error: subError } = await db.from('sellora_subscriptions').select('creator_id').eq('id', localId).maybeSingle();
  if (subError) throw subError;
  if (sub?.creator_id) {
    const { error: syncError } = await db.rpc('sellora_sync_subscription_entitlement', { p_creator_id: sub.creator_id });
    if (syncError) throw syncError;
  }
  return patch;
}

export async function persistSubscriptionPayment(subscriptionId: string, remote: RazorpayPayment) {
  const db = getAdminSupabase();
  const status = remote.status === 'captured' ? 'captured' : remote.status === 'authorized' ? 'authorized' : remote.status === 'failed' ? 'failed' : 'pending';
  const { data, error } = await db.from('sellora_subscription_payments').upsert({
    subscription_id: subscriptionId,
    provider_payment_id: remote.id,
    provider_invoice_id: remote.invoice_id || null,
    amount_minor: Number(remote.amount || 0),
    currency: String(remote.currency || 'INR').toUpperCase(),
    status,
    payment_method: remote.method || null,
    paid_at: status === 'captured' ? (unixToIso(remote.created_at) || new Date().toISOString()) : null,
    metadata: { provider_snapshot: remote },
  }, { onConflict: 'provider_payment_id' }).select('*').single();
  if (error) throw error;
  return data;
}

export async function syncPaymentFromProvider(subscriptionId: string, paymentId: string) {
  const remote = await fetchBillingPayment(paymentId);
  await persistSubscriptionPayment(subscriptionId, remote);
  return remote;
}

export async function getCurrentSubscription(creatorId: string) {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from('sellora_subscriptions')
    .select('*')
    .eq('creator_id', creatorId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}
