import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { createTablelyPlan, findTablelyPlanByProvisioningId, getTablelyBillingConfigStatus } from '@/lib/tablely-billing';

const schema = z.object({
  planId: z.string().min(1),
  interval: z.enum(['month', 'year']).default('month'),
  amountRupees: z.number().finite().min(1).optional(),
});

type Plan = {
  id: string;
  name: string;
  description: string | null;
  price_monthly: number;
  price_annual: number | null;
  currency: string;
  provider_plan_id: string | null;
  provider_plan_id_annual: string | null;
};

type ProvisioningState = {
  provisioning_id: string;
  reused?: boolean;
  created_at?: string;
  plan_id: string;
  billing_interval: 'month' | 'year';
  price: number;
  currency: string;
  environment: string;
  old_provider_plan_id: string | null;
  old_price: number | null;
};

function rpcErrorMessage(error: { message?: string } | null | undefined, fallback: string) {
  return error?.message?.trim() || fallback;
}

async function requirePlatformAdmin() {
  const s = await getSupabaseServerClient();
  if (!s) return { error: NextResponse.json({ error: 'Authentication is not configured.' }, { status: 500 }) } as const;
  const { data: { user }, error: userError } = await s.auth.getUser();
  if (userError || !user) return { error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) } as const;
  const { data: isAdmin, error: adminError } = await s.rpc('is_platform_admin');
  if (adminError) return { error: NextResponse.json({ error: adminError.message }, { status: 500 }) } as const;
  if (!isAdmin) return { error: NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 }) } as const;
  return { s } as const;
}

export async function GET() {
  const auth = await requirePlatformAdmin();
  if ('error' in auth) return auth.error;
  const { data, error } = await auth.s.rpc('admin_list_plans_v2');
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ plans: data ?? [], billing: getTablelyBillingConfigStatus() });
}

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid plan provisioning request.' }, { status: 400 });

  const auth = await requirePlatformAdmin();
  if ('error' in auth) return auth.error;
  const { s } = auth;
  const billing = getTablelyBillingConfigStatus();
  if (!billing.configured) return NextResponse.json({ error: 'Tablely subscription billing is not configured on the server.' }, { status: 503 });

  const { data: plans, error: listError } = await s.rpc('admin_list_plans_v2');
  if (listError) return NextResponse.json({ error: listError.message }, { status: 403 });
  const plan = (plans ?? []).find((row: unknown) => row && typeof row === 'object' && 'id' in row && String((row as { id: unknown }).id) === parsed.data.planId) as Plan | undefined;
  if (!plan) return NextResponse.json({ error: 'Plan not found.' }, { status: 404 });
  if (parsed.data.planId === 'ENTERPRISE') return NextResponse.json({ error: 'Enterprise plans use contact sales and do not provision a self-serve payment plan.' }, { status: 400 });

  const currentAmount = parsed.data.interval === 'year' ? Number(plan.price_annual ?? 0) : Number(plan.price_monthly ?? 0);
  const amountRupees = Number(parsed.data.amountRupees ?? currentAmount);
  if (!Number.isFinite(amountRupees) || amountRupees < 1) return NextResponse.json({ error: 'Plan price must be at least ₹1.' }, { status: 400 });

  const { data: started, error: startError } = await s.rpc('admin_begin_plan_reprovision', {
    p_plan_id: parsed.data.planId,
    p_billing_interval: parsed.data.interval,
    p_price: amountRupees,
    p_currency: plan.currency || 'INR',
    p_environment: billing.environment || 'unknown',
  });
  if (startError) {
    const message = rpcErrorMessage(startError, 'Could not start provider-plan provisioning.');
    const conflict = /already.*progress|provisioning.*progress/i.test(message);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }

  const state = started as ProvisioningState;
  const recoverExisting = async () => {
    const recovered = await findTablelyPlanByProvisioningId({ provisioningId: state.provisioning_id, createdAt: state.created_at });
    if (!recovered) return null;
    const { data: finalized, error: finalizeError } = await s.rpc('admin_finalize_plan_reprovision', {
      p_provisioning_id: state.provisioning_id,
      p_provider_plan_id: recovered.id,
    });
    if (finalizeError) throw new Error(finalizeError.message);
    return finalized;
  };

  if (state.reused) {
    try {
      const finalized = await recoverExisting();
      if (finalized) {
        return NextResponse.json({ ok: true, providerPlanId: recoveredPlanId(finalized, parsed.data.interval, state.provisioning_id), reused: true, recovered: true, interval: parsed.data.interval });
      }
    } catch (error: unknown) {
      console.error('admin/billing-plans: pending provisioning recovery failed', { planId: parsed.data.planId, interval: parsed.data.interval, provisioningId: state.provisioning_id, error: error instanceof Error ? error.message : 'unknown error' });
      return NextResponse.json({ error: 'A provider plan was created but the billing mapping could not be finalized. Retry this operation to safely reconcile it.' }, { status: 500 });
    }
    return NextResponse.json({ error: 'A provider-plan provisioning request is already in progress. No duplicate provider plan was created.' }, { status: 409 });
  }

  try {
    const created = await createTablelyPlan({
      name: `${plan.name} ${parsed.data.interval === 'year' ? 'Annual' : 'Monthly'}`,
      description: plan.description ?? undefined,
      amountRupees,
      currency: plan.currency,
      period: parsed.data.interval === 'year' ? 'yearly' : 'monthly',
      provisioningId: state.provisioning_id,
    });
    const { data: finalized, error: finalizeError } = await s.rpc('admin_finalize_plan_reprovision', {
      p_provisioning_id: state.provisioning_id,
      p_provider_plan_id: created.id,
    });
    if (finalizeError) {
      console.error('admin/billing-plans: provider plan created but DB finalization failed', { planId: parsed.data.planId, interval: parsed.data.interval, provisioningId: state.provisioning_id, providerPlanId: created.id, error: finalizeError.message });
      return NextResponse.json({ error: 'The new provider plan was created, but the billing mapping could not be finalized. Retry the same operation to safely reconcile it.' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, providerPlanId: created.id, existing: Boolean(state.old_provider_plan_id), reProvisioned: Boolean(state.old_provider_plan_id), interval: parsed.data.interval, plan: finalized });
  } catch (providerError: unknown) {
    try {
      const recovered = await recoverExisting();
      if (recovered) {
        return NextResponse.json({ ok: true, providerPlanId: recoveredPlanId(recovered, parsed.data.interval, state.provisioning_id), recovered: true, interval: parsed.data.interval });
      }
    } catch (recoveryError: unknown) {
      console.error('admin/billing-plans: provider failure recovery failed', { planId: parsed.data.planId, interval: parsed.data.interval, provisioningId: state.provisioning_id, error: recoveryError instanceof Error ? recoveryError.message : 'unknown error' });
      return NextResponse.json({ error: 'Provider provisioning did not complete and automatic recovery also failed. The existing TABLELY price/provider mapping was left unchanged.' }, { status: 502 });
    }

    const safeReason = providerError instanceof Error ? providerError.message : 'Could not provision the billing plan.';
    const { error: failError } = await s.rpc('admin_fail_plan_reprovision', {
      p_provisioning_id: state.provisioning_id,
      p_reason: safeReason,
    });
    if (failError) console.error('admin/billing-plans: failed to mark provisioning record failed', { provisioningId: state.provisioning_id, error: failError.message });
    console.error('admin/billing-plans: provider provisioning failed', { planId: parsed.data.planId, interval: parsed.data.interval, provisioningId: state.provisioning_id, providerEnvironment: billing.environment, error: safeReason });
    return NextResponse.json({ error: 'Could not create the Razorpay billing plan. The current TABLELY price and provider mapping were left unchanged.' }, { status: 502 });
  }
}

function recoveredPlanId(plan: unknown, interval: 'month' | 'year', fallback: string) {
  if (plan && typeof plan === 'object') {
    const value = interval === 'year' ? (plan as { provider_plan_id_annual?: unknown }).provider_plan_id_annual : (plan as { provider_plan_id?: unknown }).provider_plan_id;
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
}
