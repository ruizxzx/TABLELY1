import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const db = getAdminSupabase();
    const { data, error } = await db
      .from('sellora_plans')
      .select('plan_key,name,description,price_minor,currency,billing_period,max_products,max_categories,features')
      .eq('active', true)
      .order('price_minor', { ascending: true });
    if (error) throw error;
    const { data: variants, error: variantsError } = await db.from('sellora_plan_variants').select('id,plan_key,billing_period,price_minor,currency,annual_discount_percent,active').eq('active', true).order('price_minor', { ascending: true });
    const fallbackVariants = (data || []).flatMap((plan: any) => [
      { id: `${plan.plan_key}-monthly-fallback`, plan_key: plan.plan_key, billing_period: 'monthly', price_minor: plan.price_minor, currency: plan.currency, annual_discount_percent: 0, active: true },
      { id: `${plan.plan_key}-yearly-fallback`, plan_key: plan.plan_key, billing_period: 'yearly', price_minor: Number(plan.price_minor || 0) * 10, currency: plan.currency, annual_discount_percent: Number(plan.price_minor || 0) > 0 ? 16.67 : 0, active: true },
    ]);
    const grouped = (data || []).map((plan: any) => ({ ...plan, variants: (variantsError ? fallbackVariants : variants || []).filter((variant: any) => variant.plan_key === plan.plan_key) }));
    return NextResponse.json({ ok: true, data: grouped });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Could not load plans.' }, { status: 500 });
  }
}
