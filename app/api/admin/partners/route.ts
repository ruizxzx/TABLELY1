import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { decryptPartnerPayoutDetails } from '@/lib/partner-payout-crypto';

async function getAdminContext() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return { response: NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 }) };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: 'Sign in required.' }, { status: 401 }) };
  const { data: allowed, error } = await supabase.rpc('is_platform_admin');
  if (error || allowed !== true) return { response: NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 }) };
  const admin = getSupabaseAdminClient();
  if (!admin) return { response: NextResponse.json({ error: 'Server database credentials are missing.' }, { status: 503 }) };
  return { supabase, admin, user };
}

export async function GET() {
  const context = await getAdminContext();
  if ('response' in context) return context.response;
  const { admin } = context;
  const [partners, referrals, commissions, payouts, adjustments, rules, overrides, clicks, audit] = await Promise.all([
    admin.from('tablely_partners').select('*').order('created_at', { ascending: false }).limit(1000),
    admin.from('tablely_partner_referrals').select('*').order('created_at', { ascending: false }).limit(1000),
    admin.from('tablely_partner_commissions').select('*').order('created_at', { ascending: false }).limit(2000),
    admin.from('tablely_partner_payouts').select('*').order('created_at', { ascending: false }).limit(500),
    admin.from('tablely_partner_adjustments').select('*').order('created_at', { ascending: false }).limit(1000),
    admin.from('tablely_partner_commission_rules').select('*,saas_plans(name,price_monthly)').order('plan_id'),
    admin.from('tablely_partner_commission_overrides').select('*').order('updated_at', { ascending: false }),
    admin.from('tablely_referral_clicks').select('partner_id,clicked_at,campaign').order('clicked_at', { ascending: false }).limit(5000),
    admin.from('tablely_partner_audit').select('*').order('created_at', { ascending: false }).limit(250),
  ]);
  for (const result of [partners, referrals, commissions, payouts, adjustments, rules, overrides, clicks, audit]) if (result.error) return NextResponse.json({ error: result.error.message }, { status: 500 });
  const ids = (referrals.data ?? []).map((r) => r.restaurant_organization_id).filter((id): id is string => Boolean(id));
  const [orgs, branches, subscriptions, plans] = ids.length ? await Promise.all([
    admin.from('organizations').select('id,name,owner_id,created_at,restaurant_category,business_email').in('id', ids),
    admin.from('branches').select('id,organization_id,name,address,phone').in('organization_id', ids),
    admin.from('organization_subscriptions').select('id,organization_id,plan_id,status,trial_started_at,trial_ends_at,current_period_start,current_period_end,provider_subscription_id').in('organization_id', ids),
    admin.from('saas_plans').select('id,name,price_monthly,active').order('price_monthly'),
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, await admin.from('saas_plans').select('id,name,price_monthly,active').order('price_monthly')];
  const orgIds = new Set(ids);
  const ownerIds = [...new Set((orgs.data ?? []).map((o) => o.owner_id).filter(Boolean))];
  const profiles = ownerIds.length ? await admin.from('profiles').select('id,full_name,phone').in('id', ownerIds) : { data: [], error: null };
  const billingEvents = ids.length ? await admin.from('subscription_billing_events').select('id,organization_id,provider_payment_id,provider_subscription_id,event_type,status,amount,currency,occurred_at').in('organization_id', ids).order('occurred_at', { ascending: false }).limit(2000) : { data: [], error: null };
  if (billingEvents.error) return NextResponse.json({ error: billingEvents.error.message }, { status: 500 });
  const payoutRows = await Promise.all((payouts.data ?? []).map(async (row) => {
    if (!row.proof_url || /^https?:\/\//i.test(row.proof_url)) return row;
    const { data: signed } = await admin.storage.from('tablely-partner-payout-proofs').createSignedUrl(row.proof_url, 3600);
    return { ...row, proof_url: signed?.signedUrl ?? null };
  }));
  return NextResponse.json({ data: {
    partners: (partners.data ?? []).map((partner) => {
      let details: Record<string, string> | null = null;
      try { if (typeof partner.payout_details?.encrypted === 'string') details = decryptPartnerPayoutDetails(partner.payout_details.encrypted); } catch { details = null; }
      return { ...partner, payout_details: details };
    }), referrals: referrals.data ?? [], commissions: commissions.data ?? [], payouts: payoutRows, adjustments: adjustments.data ?? [],
    rules: rules.data ?? [], overrides: overrides.data ?? [], clicks: clicks.data ?? [], audit: audit.data ?? [], organizations: (orgs.data ?? []).filter((o) => orgIds.has(o.id)),
    branches: branches.data ?? [], subscriptions: subscriptions.data ?? [], billingEvents: billingEvents.data ?? [], plans: plans.data ?? [], profiles: profiles.data ?? [],
  } });
}

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('partner_status'), partnerId: z.string().uuid(), status: z.enum(['PENDING','APPROVED','REJECTED','SUSPENDED']) }),
  z.object({ action: z.literal('payout_status'), partnerId: z.string().uuid(), status: z.enum(['VERIFIED','REJECTED','PENDING']) }),
  z.object({ action: z.literal('referral_status'), referralId: z.string().uuid(), status: z.enum(['VERIFIED','NEEDS_REVIEW','REJECTED','BUSINESS_VERIFICATION_PENDING']), note: z.string().max(2000).optional() }),
  z.object({ action: z.literal('rule'), planId: z.string().min(1).max(50), percent: z.number().min(0).max(100), mode: z.enum(['ONE_TIME','RECURRING']), months: z.number().int().min(1).max(120).nullable(), basis: z.enum(['PAYMENT_AMOUNT','PLAN_PRICE']), holdingDays: z.number().int().min(0).max(365), minimumPayout: z.number().min(0), reason: z.string().max(500) }),
  z.object({ action: z.literal('override'), partnerId: z.string().uuid(), planId: z.string().min(1).max(50), percent: z.number().min(0).max(100), mode: z.enum(['ONE_TIME','RECURRING']), months: z.number().int().min(1).max(120).nullable(), active: z.boolean(), reason: z.string().min(3).max(500) }),
  z.object({ action: z.literal('create_payout'), partnerId: z.string().uuid() }),
    z.object({ action: z.literal('mark_paid'), payoutId: z.string().uuid(), method: z.enum(['UPI','BANK_TRANSFER','OTHER']), reference: z.string().trim().min(4).max(120), transactionDate: z.string().datetime().optional(), proofUrl: z.string().max(1000).optional() }),
]);

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid partner management request.' }, { status: 400 });
  const context = await getAdminContext();
  if ('response' in context) return context.response;
  const { supabase } = context;
  const action = parsed.data;
  let result: { data: unknown; error: { message: string; code?: string } | null };
  if (action.action === 'partner_status') result = await supabase.rpc('tablely_partner_admin_set_status', { p_partner_id: action.partnerId, p_status: action.status });
  else if (action.action === 'payout_status') result = await supabase.rpc('tablely_partner_admin_verify_payout_details', { p_partner_id: action.partnerId, p_status: action.status });
  else if (action.action === 'referral_status') result = await supabase.rpc('tablely_partner_admin_verify_referral', { p_referral_id: action.referralId, p_status: action.status, p_note: action.note ?? null });
  else if (action.action === 'rule') result = await supabase.rpc('tablely_partner_admin_set_rule', { p_plan_id: action.planId, p_percent: action.percent, p_mode: action.mode, p_months: action.mode === 'ONE_TIME' ? 1 : action.months, p_basis: action.basis, p_holding_days: action.holdingDays, p_minimum: action.minimumPayout, p_reason: action.reason });
  else if (action.action === 'override') result = await supabase.rpc('tablely_partner_admin_set_override', { p_partner_id: action.partnerId, p_plan_id: action.planId, p_percent: action.percent, p_mode: action.mode, p_months: action.mode === 'ONE_TIME' ? 1 : action.months, p_active: action.active, p_reason: action.reason });
  else if (action.action === 'create_payout') result = await supabase.rpc('tablely_partner_admin_create_payout', { p_partner_id: action.partnerId });
  else result = await supabase.rpc('tablely_partner_admin_mark_paid', { p_payout_id: action.payoutId, p_method: action.method, p_reference: action.reference, p_date: action.transactionDate ?? new Date().toISOString(), p_proof_url: action.proofUrl ?? null });
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: result.error.code === '42501' ? 403 : 400 });
  return NextResponse.json({ ok: true, result: result.data });
}
