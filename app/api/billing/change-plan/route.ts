import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit, writeAudit } from '../../../lib/server-security';
import { cancelBillingSubscription, getBillingEnvironment, updateBillingSubscription } from '../../../lib/billing';
import { persistProviderSubscription } from '../../../lib/billing-service';

export const dynamic = 'force-dynamic';
const PAID = new Set(['creator','pro','max']);
const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });
const rank: Record<string, number> = { free: 0, creator: 1, pro: 2, max: 3 };

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'billing-change-plan', 10);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Please sign in again.', 401);
    const body = await request.json() as { planKey?: unknown; billingPeriod?: unknown };
    const targetKey = String(body.planKey || '').toLowerCase();
    if (targetKey !== 'free' && !PAID.has(targetKey)) return fail('Invalid target plan.');

    const db = getAdminSupabase();
    const environment = getBillingEnvironment();
    const { data: current, error: currentError } = await db.from('sellora_subscriptions').select('*').eq('creator_id', user.id).eq('environment', environment).in('status', ['authenticated','active','pending','paused','halted']).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (currentError) throw currentError;
    if (!current) return fail('No active TABLELY subscription was found.', 409);
    const billingPeriod = String(body.billingPeriod || current.billing_period || 'monthly').toLowerCase() === 'yearly' ? 'yearly' : 'monthly';
    if (targetKey === current.plan_key && billingPeriod === (current.billing_period || 'monthly') && !current.pending_plan_key) return NextResponse.json({ ok: true, data: current });
    if (targetKey !== current.plan_key && targetKey === current.pending_plan_key && billingPeriod === (current.pending_billing_period || current.billing_period || 'monthly')) return NextResponse.json({ ok: true, data: current, unchanged: true });

    if (targetKey === 'free') {
      const remote = await cancelBillingSubscription(current.provider_subscription_id, true);
      await db.from('sellora_subscriptions').update({ pending_plan_key:'free', pending_plan_version_id:null, pending_change_at:'cycle_end', cancel_at_period_end:true, updated_at:new Date().toISOString() }).eq('id', current.id);
      await persistProviderSubscription(current.id, remote);
      await writeAudit({ actorUserId: user.id, action: 'subscription.downgrade_to_free', entityType: 'subscription', entityId: current.id, before: { planKey: current.plan_key }, after: { planKey: 'free', changeAt: 'cycle_end' } });
      return NextResponse.json({ ok: true, data: { ...remote, scheduledPlanKey: 'free' } });
    }

    const { data: target, error: targetError } = await db.from('sellora_plans').select('plan_key,name,price_minor,currency').eq('plan_key', targetKey).eq('active', true).maybeSingle();
    if (targetError) throw targetError;
    if (!target) return fail('Target plan is unavailable.');
    const { data: targetVariant, error: variantError } = await db.from('sellora_plan_variants').select('id,price_minor,currency,billing_period').eq('plan_key', targetKey).eq('billing_period', billingPeriod).eq('active', true).maybeSingle();
    if (variantError) throw variantError;
    if (!targetVariant) return fail('Target billing period is unavailable.');
    const { data: version, error: versionError } = await db.from('sellora_plan_versions').select('id,plan_key,variant_id,amount_minor,currency,billing_period,provider_plan_id,status').eq('variant_id', targetVariant.id).eq('environment', environment).eq('is_current', true).eq('status','current').maybeSingle();
    if (versionError) throw versionError;
    if (!version?.provider_plan_id) return fail(`TABLELY billing for ${target.name} is not provisioned yet.`,503);

    const currentRank = rank[current.plan_key] ?? 0;
    const targetRank = rank[targetKey] ?? 0;
    const scheduleChangeAt = targetRank > currentRank ? 'now' : targetRank < currentRank ? 'cycle_end' : 'cycle_end';
    const remote = await updateBillingSubscription(current.provider_subscription_id, { planId: version.provider_plan_id, scheduleChangeAt, customerNotify: true });
    const patch = scheduleChangeAt === 'now'
      ? { pending_plan_key:null, pending_variant_id:null, pending_plan_version_id:null, billing_period:billingPeriod, variant_id:targetVariant.id, pending_change_at:null, cancel_at_period_end:false, cancelled_at:null }
      : { pending_plan_key:targetKey, pending_variant_id:targetVariant.id, pending_plan_version_id:version.id, pending_billing_period:billingPeriod, pending_change_at:'cycle_end' as const, cancel_at_period_end:false, cancelled_at:null };
    const { error: updateError } = await db.from('sellora_subscriptions').update(patch).eq('id', current.id);
    if (updateError) throw updateError;
    await persistProviderSubscription(current.id, remote);
    await writeAudit({ actorUserId: user.id, action: scheduleChangeAt === 'now' ? 'subscription.upgrade' : 'subscription.change', entityType: 'subscription', entityId: current.id, before: { planKey: current.plan_key, billingPeriod: current.billing_period }, after: { planKey: targetKey, billingPeriod, changeAt: scheduleChangeAt } });
    return NextResponse.json({ ok: true, data: { ...remote, scheduledPlanKey: scheduleChangeAt === 'cycle_end' ? targetKey : null, scheduledBillingPeriod: scheduleChangeAt === 'cycle_end' ? billingPeriod : null, changeAt: scheduleChangeAt } });
  } catch (error) {
    console.error('[billing/change-plan]', error);
    return fail(error instanceof Error ? error.message : 'Could not change subscription plan.', 500);
  }
}
