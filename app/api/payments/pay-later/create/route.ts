import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createRazorpayOrder } from '@/lib/razorpay';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';

const schema = z.object({ sessionId: z.string().uuid(), idempotencyKey: z.string().min(16).max(100) });

export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'Payment configuration is incomplete.' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid payment request.' }, { status: 400 });
    const { data: attempt, error } = await supabase.rpc('create_pay_later_payment_attempt', { p_session_id: parsed.data.sessionId, p_idempotency_key: parsed.data.idempotencyKey });
    if (error || !attempt?.[0]) return NextResponse.json({ error: error?.message ?? 'Could not create payment session.' }, { status: 409 });
    const row = attempt[0] as { attempt_id: string; attempt_token: string; branch_id: string; amount: number; razorpay_order_id: string | null; payment_expires_at: string };
    const admin = getSupabaseAdminClient();
    if (!admin) return NextResponse.json({ error: 'Payment configuration is incomplete.' }, { status: 503 });
    const { data: branch } = await admin.from('branches').select('organization_id').eq('id', row.branch_id).maybeSingle();
    if (!branch) return NextResponse.json({ error: 'Restaurant not found.' }, { status: 404 });
    const keys = resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin, branch.organization_id, row.branch_id));
    if (!keys.enabled) return NextResponse.json({ error: 'Online payments are not enabled for this restaurant.' }, { status: 403 });
    let razorpayOrderId = row.razorpay_order_id;
    if (!razorpayOrderId) {
      const order = await createRazorpayOrder({ amountInPaise: Math.round(Number(row.amount) * 100), receipt: `tablely-later-${row.attempt_id}`, notes: { tablely_pay_later_attempt_id: row.attempt_id } }, { keyId: keys.keyId, keySecret: keys.secret });
      razorpayOrderId = order.id;
      const { data: saved, error: saveError } = await supabase.rpc('set_pay_later_payment_attempt_razorpay_order', { p_attempt_id: row.attempt_id, p_attempt_token: row.attempt_token, p_razorpay_order_id: razorpayOrderId });
      if (saveError || saved !== true) return NextResponse.json({ error: 'Payment session changed. Please try again.' }, { status: 409 });
    }
    return NextResponse.json({ attemptId: row.attempt_id, attemptToken: row.attempt_token, razorpayOrderId, amount: Math.round(Number(row.amount) * 100), currency: 'INR', keyId: keys.keyId, paymentExpiresAt: row.payment_expires_at });
  } catch (error) {
    console.error('payments/pay-later/create', error);
    return NextResponse.json({ error: 'Could not create payment session.' }, { status: 500 });
  }
}
