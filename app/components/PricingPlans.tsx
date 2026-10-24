'use client';

import { useState } from 'react';
import ButtonLink from './ButtonLink';

type BillingPeriod = 'monthly' | 'yearly';

const planMeta: Record<string, { eyebrow: string; description: string; accent: string }> = {
  free: { eyebrow: 'Start here', description: 'Everything you need to launch your first creator page.', accent: 'plan-tone-free' },
  creator: { eyebrow: 'For growing creators', description: 'The full toolkit for turning attention into income.', accent: 'plan-tone-creator' },
  pro: { eyebrow: 'For serious businesses', description: 'More room, more insight, and your own domain.', accent: 'plan-tone-pro' },
  max: { eyebrow: 'The complete setup', description: 'Every capability unlocked for your biggest ambitions.', accent: 'plan-tone-max' },
};

function price(variant: any, fallback: any) {
  const amount = Number(variant?.price_minor ?? fallback?.price_minor ?? 0) / 100;
  const currency = variant?.currency || fallback?.currency || 'INR';
  return currency === 'INR' ? `₹${amount.toLocaleString('en-IN')}` : `${currency} ${amount.toLocaleString('en-IN')}`;
}

function limit(value: any) {
  return Number(value) === 9223372036854775807 ? 'Unlimited' : String(value);
}

export default function PricingPlans({ plans, planFeatureSummary }: { plans: any[]; planFeatureSummary: Record<string, string[]> }) {
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  return <>
    <div className="pricing-toggle-wrap"><span>Choose your subscription rhythm</span><div className="billing-toggle"><button className={billingPeriod === 'monthly' ? 'active' : ''} onClick={() => setBillingPeriod('monthly')}>Monthly</button><button className={billingPeriod === 'yearly' ? 'active' : ''} onClick={() => setBillingPeriod('yearly')}>Annual <span>save more</span></button></div></div>
    <div className="feature-grid pricing-grid">{plans.map((plan: any) => { const meta = planMeta[plan.plan_key] || planMeta.free; const variant = plan.variants?.find((entry: any) => entry.billing_period === billingPeriod) || plan; const annualDiscount = Number(variant?.annual_discount_percent || 0); return <div className={`card feature plan-card ${meta.accent} landing-reveal ${plan.plan_key === 'creator' ? 'plan-card-featured' : ''}`} key={plan.plan_key}><div className="plan-card-top"><span className="plan-eyebrow">{meta.eyebrow}</span>{plan.plan_key === 'creator' && <span className="plan-badge">MOST POPULAR</span>}</div><h3>{plan.name}</h3><p className="plan-description">{meta.description}</p><div className="plan-price">{price(variant, plan)}<span> / {billingPeriod === 'yearly' ? 'year' : 'monthly'}</span></div>{billingPeriod === 'yearly' && annualDiscount > 0 && <div className="billing-savings">Save {annualDiscount}% annually</div>}<div className="plan-capacity"><div><b>{limit(plan.max_products)}</b><span>live products</span></div><i /><div><b>{limit(plan.max_categories)}</b><span>categories</span></div></div><div className="plan-includes"><span>Includes</span><b>Link Hub + Storefront</b></div><ul className="plan-feature-list">{(planFeatureSummary[plan.plan_key] || []).map((feature: string) => <li key={feature}><span>✓</span>{feature}</li>)}</ul><ButtonLink href={`/signup?plan=${encodeURIComponent(plan.plan_key)}&billing=${billingPeriod}`} primary={plan.plan_key === 'creator'}>{plan.plan_key === 'free' ? 'Start free' : `Choose ${plan.name}`} <span aria-hidden="true">→</span></ButtonLink></div>; })}</div>
  </>;
}
