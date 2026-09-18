import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { createTablelyPlan, getTablelyBillingConfigStatus } from '@/lib/tablely-billing';

const schema = z.object({ planId: z.string().min(1), interval: z.enum(['month', 'year']).default('month') });

export async function GET() {
  const s = await getSupabaseServerClient();
  if (!s) return NextResponse.json({ error: 'Authentication is not configured.' }, { status: 500 });
  const { data: { user }, error: userError } = await s.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { data: isAdmin, error: adminError } = await s.rpc('is_platform_admin');
  if (adminError) return NextResponse.json({ error: adminError.message }, { status: 500 });
  if (!isAdmin) return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 });
  const { data, error } = await s.rpc('admin_list_plans_v2');
  if (error) return NextResponse.json({ error: error.message }, { status: 403 });
  return NextResponse.json({ plans: data ?? [], billing: getTablelyBillingConfigStatus() });
}

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid plan request.' }, { status: 400 });
  const s = await getSupabaseServerClient();
  if (!s) return NextResponse.json({ error: 'Authentication is not configured.' }, { status: 500 });
  const { data: { user }, error: userError } = await s.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { data: isAdmin, error: adminError } = await s.rpc('is_platform_admin');
  if (adminError) return NextResponse.json({ error: adminError.message }, { status: 500 });
  if (!isAdmin) return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 });
  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Server database configuration is incomplete.' }, { status: 503 });
  const { data: plans, error: listError } = await s.rpc('admin_list_plans_v2');
  if (listError) return NextResponse.json({ error: listError.message }, { status: 403 });
  const plan = (plans ?? []).find((row: unknown) => row && typeof row === 'object' && 'id' in row && String((row as { id: unknown }).id) === parsed.data.planId) as ({ id: string; name: string; description: string | null; price_monthly: number; currency: string; provider_plan_id: string | null } | undefined);
  if (!plan) return NextResponse.json({ error: 'Plan not found.' }, { status: 404 });
  if (parsed.data.planId === 'ENTERPRISE') return NextResponse.json({ error: 'Enterprise plans use contact sales and do not provision a self-serve payment plan.' }, { status: 400 });
  const existingId = parsed.data.interval === 'year' ? (plan as { provider_plan_id_annual?: string | null }).provider_plan_id_annual : plan.provider_plan_id;
  if (existingId) return NextResponse.json({ ok: true, providerPlanId: existingId, existing: true, interval: parsed.data.interval });
  try {
    const amount = parsed.data.interval === 'year' ? Number((plan as { price_annual?: number | null }).price_annual ?? 0) : Number(plan.price_monthly);
    if (amount < 1) return NextResponse.json({ error: 'Plan price must be at least ₹1.' }, { status: 400 });
    const created = await createTablelyPlan({ name: `${plan.name} ${parsed.data.interval === 'year' ? 'Annual' : 'Monthly'}`, description: plan.description ?? undefined, amountRupees: amount, currency: plan.currency, period: parsed.data.interval === 'year' ? 'yearly' : 'monthly' });
    const { error } = await admin.rpc('admin_set_provider_plan_id_v2', { p_plan_id: parsed.data.planId, p_provider_plan_id: created.id, p_billing_interval: parsed.data.interval });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, providerPlanId: created.id });
  } catch (providerError: unknown) {
    return NextResponse.json({ error: providerError instanceof Error ? providerError.message : 'Could not provision the billing plan.' }, { status: 502 });
  }
}
