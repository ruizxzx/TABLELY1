export const PLAN_CONFIG = {
  free: { label: 'Free', priceMonthly: 0, maxProducts: 1, maxCategories: 1, analytics: 'basic' as const, branding: true, customDomain: false, coupons: false, bundles: false, upsells: false },
  creator: { label: 'Creator', priceMonthly: 199, maxProducts: 10, maxCategories: 2, analytics: 'standard' as const, branding: false, customDomain: false, coupons: true, bundles: true, upsells: true },
  pro: { label: 'Pro', priceMonthly: 499, maxProducts: Infinity, maxCategories: 10, analytics: 'advanced' as const, branding: false, customDomain: true, coupons: true, bundles: true, upsells: true },
  max: { label: 'Max', priceMonthly: 999, maxProducts: Infinity, maxCategories: Infinity, analytics: 'advanced' as const, branding: false, customDomain: true, coupons: true, bundles: true, upsells: true },
} as const;

export type PlanKey = keyof typeof PLAN_CONFIG;
export type FeatureKey = 'link_hub'|'store'|'checkout'|'email_capture'|'email_marketing'|'analytics_integrations'|'coupons'|'bundles'|'upsells'|'branding'|'custom_domain'|'advanced_layouts'|'link_scheduling'|'link_thumbnails';
export type AnalyticsLevel = 'basic'|'standard'|'advanced';
export type PlanFeatures = Record<FeatureKey, boolean> & { analytics: AnalyticsLevel };
export type Entitlements = { planKey: PlanKey; planName: string; maxProducts: number; maxCategories: number; features: PlanFeatures; analyticsLevel: AnalyticsLevel };

export type CreatorPlanRecord = {
  plan?: string | null;
  access_source?: string | null;
  access_starts_at?: string | null;
  access_expires_at?: string | null;
};

export function getEffectivePlan(record: CreatorPlanRecord | null | undefined, now = Date.now()): PlanKey {
  const plan = (record?.plan || 'free') as PlanKey;
  if (!PLAN_CONFIG[plan]) return 'free';
  const starts = record?.access_starts_at ? Date.parse(record.access_starts_at) : NaN;
  const expires = record?.access_expires_at ? Date.parse(record.access_expires_at) : NaN;
  if (Number.isFinite(starts) && starts > now) return 'free';
  if (Number.isFinite(expires) && expires <= now) return 'free';
  return plan;
}

const DEFAULT_FEATURES: PlanFeatures = { link_hub: false, store: false, checkout: false, email_capture: false, email_marketing: false, analytics_integrations: false, coupons: false, bundles: false, upsells: false, branding: true, custom_domain: false, advanced_layouts: false, link_scheduling: false, link_thumbnails: false, analytics: 'basic' };

export function normalizePlanFeatures(value: unknown): PlanFeatures {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const analytics = source.analytics === 'standard' || source.analytics === 'advanced' ? source.analytics : 'basic';
  const booleanKeys: FeatureKey[] = ['link_hub', 'store', 'checkout', 'email_capture', 'email_marketing', 'analytics_integrations', 'coupons', 'bundles', 'upsells', 'branding', 'custom_domain', 'advanced_layouts', 'link_scheduling', 'link_thumbnails'];
  return { ...DEFAULT_FEATURES, ...Object.fromEntries(booleanKeys.map(key => [key, source[key] === true])), analytics } as PlanFeatures;
}

export function canUseFeature(entitlements: Pick<Entitlements, 'features'>, feature: FeatureKey) {
  return entitlements.features[feature] === true;
}

export function hasAnalyticsLevel(entitlements: Pick<Entitlements, 'analyticsLevel'>, level: AnalyticsLevel) {
  const rank = { basic: 0, standard: 1, advanced: 2 };
  return rank[entitlements.analyticsLevel] >= rank[level];
}

export function getPlanLimit(plan: PlanKey | string, limit: 'products' | 'categories') {
  const config = PLAN_CONFIG[plan as PlanKey] || PLAN_CONFIG.free;
  return limit === 'products' ? config.maxProducts : config.maxCategories;
}

export function requiredPlanForFeature(features: Array<{ plan_key: string; features: unknown }>, feature: FeatureKey) {
  const order: PlanKey[] = ['free', 'creator', 'pro', 'max'];
  return order.find(plan => features.some(row => row.plan_key === plan && normalizePlanFeatures(row.features)[feature] === true)) || 'max';
}

export function planLimitMessage(code: string, plan: PlanKey | string = 'free') {
  if (code.includes('PRODUCT_LIMIT_REACHED')) {
    const max = PLAN_CONFIG[plan as PlanKey]?.maxProducts;
    return `You've reached the ${PLAN_CONFIG[plan as PlanKey]?.label ?? 'current'} plan product limit${Number.isFinite(max) ? ` of ${max}` : ''}.`;
  }
  if (code.includes('CATEGORY_LIMIT_REACHED')) {
    const max = PLAN_CONFIG[plan as PlanKey]?.maxCategories;
    return `You've reached the ${PLAN_CONFIG[plan as PlanKey]?.label ?? 'current'} plan category limit${Number.isFinite(max) ? ` of ${max}` : ''}.`;
  }
  if (code.includes('CATEGORY_REQUIRED')) return 'Choose a category before saving the product.';
  if (code.includes('DIGITAL_FILE_REQUIRED')) return 'A digital file is required for an uploaded-file product.';
  if (code.includes('DIGITAL_LINK_REQUIRED')) return 'Add a delivery link before publishing this product.';
  if (code.includes('INVALID_DIGITAL_LINK')) return 'Delivery links must use http:// or https://.';
  if (code.includes('INVALID_CATEGORY')) return 'That category is not available in your store.';
  return code;
}
