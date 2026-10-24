import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit, writeAudit } from '../../../lib/server-security';
import { cancelBillingSubscription, createBillingSubscription, ensureBillingPlanProvisioned, getBillingEnvironment, getBillingPublicKey } from '../../../lib/billing';
import { persistProviderSubscription } from '../../../lib/billing-service';

export const dynamic = 'force-dynamic';

const PLAN_KEYS = new Set(['creator', 'pro', 'max']);
const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const detail = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [detail.message, detail.details, detail.hint, detail.code].filter(value => typeof value === 'string' && value.trim());
    if (parts.length) return parts.join(' | ');
  }
  return fallback;
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'billing-create-subscription', 10);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Please sign in again.', 401);
    const body = await request.json() as { planKey?: unknown; billingPeriod?: unknown };
    const planKey = String(body.planKey || '').toLowerCase();
    const billingPeriod = String(body.billingPeriod || 'monthly').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';
    if (!PLAN_KEYS.has(planKey)) return fail('Choose a paid TABLELY plan.');

    const db = getAdminSupabase();
    const environment = getBillingEnvironment();
    const [{ data: plan, error: planError }, { data: variant, error: variantError }, { data: existing, error: existingError }] = await Promise.all([
      db.from('sellora_plans').select('plan_key,name,description,price_minor,currency,billing_period').eq('plan_key', planKey).eq('active', true).maybeSingle(),
      db.from('sellora_plan_variants').select('id,plan_key,billing_period,price_minor,currency,active').eq('plan_key', planKey).eq('billing_period', billingPeriod).eq('active', true).maybeSingle(),
      db.from('sellora_subscriptions').select('*').eq('creator_id', user.id).eq('environment', environment).in('status', ['authenticated','active','pending','paused','halted']).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (planError) throw planError; if (variantError) throw variantError; if (existingError) throw existingError;
    if (!plan || !variant || Number(variant.price_minor) <= 0) return fail('This subscription option is not currently available.');
    if (existing && ['authenticated','active','pending','paused','halted'].includes(String(existing.status))) {
      return fail('You already have an active or pending TABLELY subscription. Use Change plan instead.', 409);
    }

    let { data: version, error: versionError } = await db.from('sellora_plan_versions')
      .select('id,plan_key,variant_id,version_no,amount_minor,currency,billing_period,provider_plan_id,status')
      .eq('variant_id', variant.id).eq('environment', environment).eq('is_current', true).eq('status', 'current').maybeSingle();
    if (versionError) throw versionError;
    if (!version) {
      const { data: fallbackVersion, error: fallbackVersionError } = await db.from('sellora_plan_versions')
        .select('id,plan_key,variant_id,version_no,amount_minor,currency,billing_period,provider_plan_id,status')
        .eq('variant_id', variant.id).eq('environment', environment).eq('is_current', true).order('version_no', { ascending: false }).limit(1).maybeSingle();
      if (fallbackVersionError) throw fallbackVersionError;
      version = fallbackVersion ?? null;
    }

    if (!version) {
      const { data: latestRows, error: latestError } = await db.from('sellora_plan_versions').select('version_no').eq('variant_id', variant.id).eq('environment', environment).order('version_no', { ascending: false }).limit(1);
      if (latestError) throw latestError;
      const { data: createdVersion, error: createVersionError } = await db.from('sellora_plan_versions').insert({
        plan_key: planKey,
        variant_id: variant.id,
        version_no: Number(latestRows?.[0]?.version_no || 0) + 1,
        amount_minor: Number(variant.price_minor),
        currency: String(variant.currency || plan.currency || 'INR').toUpperCase(),
        billing_period: billingPeriod,
        environment,
        provider: 'razorpay',
        status: 'unprovisioned',
        is_current: false,
      }).select('id,plan_key,variant_id,version_no,amount_minor,currency,billing_period,provider_plan_id,status').single();
      if (createVersionError) throw createVersionError;
      version = createdVersion;
    }

    if (!version?.provider_plan_id) {
      try {
        const providerPlan = await ensureBillingPlanProvisioned({
          planKey: version.plan_key,
          planName: plan.name,
          amountMinor: Number(version.amount_minor),
          currency: String(version.currency || 'INR'),
          billingPeriod,
          environment,
          versionId: version.id,
          updateVersion: async (payload) => {
            const { error } = await db.from('sellora_plan_versions').update(payload).eq('id', version!.id);
            if (error) throw error;
          },
        });
        version = { ...version, provider_plan_id: providerPlan.id, status: 'current' };
      } catch (provisionError) {
        console.error('[billing/create-subscription:auto-provision]', provisionError);
        return fail(`TABLELY billing for ${plan.name} is not provisioned yet. Ask an admin to reprovision the plan.`, 503);
      }
    }

    const remote = await createBillingSubscription({
      planId: version.provider_plan_id,
      totalCount: 100,
      notes: { sellora_creator_id: user.id, sellora_plan_key: planKey, sellora_billing_period: billingPeriod, sellora_plan_version_id: version.id },
    });

    const { data: local, error: insertError } = await db.from('sellora_subscriptions').insert({
      creator_id: user.id,
      plan_key: planKey,
      variant_id: variant.id,
      plan_version_id: version.id,
      billing_period: billingPeriod,
      environment,
      provider: 'razorpay',
      provider_subscription_id: remote.id,
      provider_plan_id: remote.plan_id,
      customer_email: user.email || null,
      status: String(remote.status || 'created'),
      amount_minor: Number(version.amount_minor),
      currency: version.currency,
      quantity: Number(remote.quantity || 1),
      total_count: remote.total_count ?? 100,
      paid_count: Number(remote.paid_count || 0),
      remaining_count: remote.remaining_count ?? null,
      current_start: remote.current_start ? new Date(remote.current_start * 1000).toISOString() : null,
      current_end: remote.current_end ? new Date(remote.current_end * 1000).toISOString() : null,
      charge_at: remote.charge_at ? new Date(remote.charge_at * 1000).toISOString() : null,
      start_at: remote.start_at ? new Date(remote.start_at * 1000).toISOString() : null,
      end_at: remote.end_at ? new Date(remote.end_at * 1000).toISOString() : null,
      metadata: { provider_snapshot: remote },
    }).select('*').single();
    if (insertError) {
      try { await cancelBillingSubscription(remote.id, false); } catch (cancelError) { console.error('[billing/create-subscription-orphan-cancel]', cancelError); }
      try { await writeAudit({ actorUserId: user.id, action: 'subscription.local_insert_failed', entityType: 'subscription', after: { providerSubscriptionId: remote.id, planKey }, metadata: { error: insertError.message } }); } catch {}
      throw insertError;
    }
    await persistProviderSubscription(local.id, remote);
    await writeAudit({ actorUserId: user.id, action: 'subscription.checkout_created', entityType: 'subscription', entityId: local.id, after: { planKey, billingPeriod, providerSubscriptionId: remote.id, environment } });
    return NextResponse.json({ ok: true, data: { subscriptionId: remote.id, subscriptionRecordId: local.id, keyId: getBillingPublicKey(), planKey, billingPeriod, environment } });
  } catch (error) {
    console.error('[billing/create-subscription]', error);
    return fail(errorMessage(error, 'Could not start subscription checkout.'), 500);
  }
}
