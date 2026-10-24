import { getAdminSupabase } from './server-admin';

export type PublicPlan = {
  plan_key: 'free' | 'creator' | 'pro' | 'max';
  name: string;
  description: string | null;
  price_minor: number;
  currency: string;
  billing_period: 'monthly' | 'yearly';
  max_products: number;
  max_categories: number;
  features: Record<string, unknown>;
  variants?: Array<{
    id: string;
    billing_period: 'monthly' | 'yearly';
    price_minor: number;
    currency: string;
    annual_discount_percent: number;
    active: boolean;
  }>;
};

export async function getPublicPlans(): Promise<PublicPlan[]> {
  const db = getAdminSupabase();
  const { data, error } = await db
    .from('sellora_plans')
    .select('plan_key,name,description,price_minor,currency,billing_period,max_products,max_categories,features')
    .eq('active', true)
    .order('price_minor', { ascending: true });
  if (error) throw error;
  const { data: variants, error: variantsError } = await db
    .from('sellora_plan_variants')
    .select('id,plan_key,billing_period,price_minor,currency,annual_discount_percent,active')
    .eq('active', true)
    .order('price_minor', { ascending: true });
  if (variantsError) {
    return (data || []).map((plan: any) => ({
      ...plan,
      variants: [
        { id: `${plan.plan_key}-monthly-fallback`, plan_key: plan.plan_key, billing_period: 'monthly', price_minor: plan.price_minor, currency: plan.currency, annual_discount_percent: 0, active: true },
        { id: `${plan.plan_key}-yearly-fallback`, plan_key: plan.plan_key, billing_period: 'yearly', price_minor: Number(plan.price_minor || 0) * 10, currency: plan.currency, annual_discount_percent: Number(plan.price_minor || 0) > 0 ? 16.67 : 0, active: true },
      ],
    })) as PublicPlan[];
  }
  return (data || []).map((plan: any) => ({
    ...plan,
    variants: (variants || []).filter((variant: any) => variant.plan_key === plan.plan_key),
  })) as PublicPlan[];
}
