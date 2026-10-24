import { getAdminSupabase } from './server-admin';
import { getEffectivePlan, normalizePlanFeatures, type Entitlements, type FeatureKey, type AnalyticsLevel } from './entitlements';

export async function getCreatorEntitlements(creatorId: string): Promise<Entitlements> {
  const db = getAdminSupabase();
  const [{ data: creatorPlan, error: creatorError }, { data: plans, error: plansError }] = await Promise.all([
    db.from('creator_plans').select('plan,access_source,access_starts_at,access_expires_at').eq('creator_id', creatorId).maybeSingle(),
    db.from('sellora_plans').select('plan_key,name,max_products,max_categories,features').eq('active', true),
  ]);
  if (creatorError) throw creatorError;
  if (plansError) throw plansError;
  const planKey = getEffectivePlan(creatorPlan);
  const catalog = (plans || []).find((plan: any) => plan.plan_key === planKey) || (plans || []).find((plan: any) => plan.plan_key === 'free');
  const features = normalizePlanFeatures(catalog?.features);
  return {
    planKey,
    planName: String(catalog?.name || planKey.charAt(0).toUpperCase() + planKey.slice(1)),
    maxProducts: Number(catalog?.max_products ?? 1),
    maxCategories: Number(catalog?.max_categories ?? 1),
    features,
    analyticsLevel: features.analytics,
  };
}

export function featureDenied(entitlements: Entitlements, feature: FeatureKey | 'analytics', requiredPlan: string) {
  const names: Record<string, string> = { custom_domain: 'Custom domains', coupons: 'Coupons', bundles: 'Bundles', upsells: 'Upsells', email_marketing: 'Email marketing', analytics_integrations: 'Analytics integrations', advanced_layouts: 'Advanced Bento layouts', link_scheduling: 'Link scheduling', link_thumbnails: 'Link thumbnails', analytics: 'This analytics level' };
  return { ok: false, code: 'FEATURE_NOT_AVAILABLE', feature, currentPlan: entitlements.planKey, requiredPlan, error: `${names[feature] || 'This feature'} are available on the ${requiredPlan.charAt(0).toUpperCase() + requiredPlan.slice(1)} plan.` };
}

export function analyticsRank(level: AnalyticsLevel) { return { basic: 0, standard: 1, advanced: 2 }[level]; }
