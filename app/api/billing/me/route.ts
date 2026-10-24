import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, withRateLimit } from '../../../lib/server-security';
import { getBillingEnvironment } from '../../../lib/billing';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'billing-read', 60);
  if (limited) return limited;
  try {
    const user = await getBearerUser(request);
    if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const db = getAdminSupabase();
    const environment = getBillingEnvironment();
    const [{ data: subscriptions, error: subError }, { data: plan, error: planError }, { data: variants, error: variantsError }, { data: grants, error: grantsError }] = await Promise.all([
      db.from('sellora_subscriptions').select('*').eq('creator_id', user.id).eq('environment', environment).in('status', ['authenticated','active','pending','paused','halted']).order('created_at', { ascending: false }).limit(5),
      db.from('sellora_plans').select('plan_key,name,description,price_minor,currency,billing_period,max_products,max_categories,features').eq('active', true),
      db.from('sellora_plan_variants').select('id,plan_key,billing_period,price_minor,currency,annual_discount_percent,active').eq('active', true),
      db.from('creator_access_grants').select('id,plan,access_type,starts_at,expires_at,status,note').eq('creator_id', user.id).eq('status','active').order('created_at', { ascending: false }).limit(10),
    ]);
    if (subError) throw subError; if (planError) throw planError; if (grantsError) throw grantsError;
    const subscription = subscriptions?.[0] || null;
    const subscriptionIds = (subscriptions || []).map((x:any) => x.id);
    const { data: payments, error: paymentsError } = subscriptionIds.length
      ? await db.from('sellora_subscription_payments').select('*').in('subscription_id', subscriptionIds).eq('status', 'captured').order('created_at', { ascending: false }).limit(25)
      : { data: [], error: null };
    if (paymentsError) throw paymentsError;
    const activeGrant = grants?.[0] || null;
    const { data: creatorPlan } = await db.from('creator_plans').select('plan,access_source,access_starts_at,access_expires_at').eq('creator_id', user.id).maybeSingle();
    const fallbackVariants = (plan || []).flatMap((entry: any) => [
      { id: `${entry.plan_key}-monthly-fallback`, plan_key: entry.plan_key, billing_period: 'monthly', price_minor: entry.price_minor, currency: entry.currency, annual_discount_percent: 0, active: true },
      { id: `${entry.plan_key}-yearly-fallback`, plan_key: entry.plan_key, billing_period: 'yearly', price_minor: Number(entry.price_minor || 0) * 10, currency: entry.currency, annual_discount_percent: Number(entry.price_minor || 0) > 0 ? 16.67 : 0, active: true },
    ]);
    const plans = (plan || []).map((entry: any) => ({ ...entry, variants: (variantsError ? fallbackVariants : variants || []).filter((variant: any) => variant.plan_key === entry.plan_key) }));
    return NextResponse.json({ ok: true, data: { subscription, payments: payments || [], plans, creatorPlan, activeGrant, environment, email: user.email || null } });
  } catch (error) {
    console.error('[billing/me]', error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Could not load subscriptions.' }, { status: 500 });
  }
}
