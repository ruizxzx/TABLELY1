export const TABLELY_FEATURES = [
  'ONLINE_PAYMENTS',
  'UNLIMITED_STAFF',
  'SERVICE_REQUESTS',
  'ANALYTICS',
  'CUSTOM_BRANDING',
  'MULTI_BRANCH',
  'ADVANCED_ANALYTICS',
  'CROSS_BRANCH_REPORTING',
  'ADVANCED_PERMISSIONS',
  'CUSTOM_DOMAIN',
  'PAYMENT_TRACKING',
] as const;

export type TablelyFeature = (typeof TABLELY_FEATURES)[number];

export type TablelyEntitlements = {
  organization_id: string;
  plan_id: string;
  plan_name: string;
  price_monthly: number;
  currency: string;
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  features: Record<string, boolean>;
  limits: Record<string, number | null>;
};

export function hasTablelyFeature(entitlements: TablelyEntitlements | null | undefined, feature: TablelyFeature) {
  return Boolean(entitlements?.features?.[feature]);
}
