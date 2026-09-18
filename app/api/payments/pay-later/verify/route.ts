import { NextResponse } from 'next/server';
import { z } from 'zod';
import { fetchRazorpayPayment, verifyRazorpayPaymentSignature } from '@/lib/razorpay';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';

const schema = z.object({ attemptId: z.string().uuid(), attemptToken: z.string().min(32).max(128), razorpayPaymentId: z.string().min(5).max(100), razorpayOrderId: z.string().min(5).max(100), razorpaySignature: z.string().length(64) });

export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'Payment configuration is incomplete.' }, { status: 503 });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: 'Invalid payment verification request.' }, { status: 400 });
    const admin = getSupabaseAdminClient();
    if (!admin) return NextResponse.json({ error: 'Payment configuration is incomplete.' }, { status: 503 });
    const { data: attempt } = await admin.from('pay_later_payment_attempts').select('id,attempt_token,branch_id,amount,status,razorpay_order_id,payment_expires_at').eq('id', parsed.data.attemptId).eq('attempt_token', parsed.data.attemptToken).maybeSingle();
    if (!attempt) return NextResponse.json({ error: 'Payment session not found.' }, { status: 404 });
    if (attempt.status === 'SUCCESS') return NextResponse.json({ ok: true, paid: true });
    if (['FAILED', 'EXPIRED'].includes(attempt.status)) return NextResponse.json({ error: 'Payment session is no longer valid.' }, { status: 409 });
    if (new Date(attempt.payment_expires_at).getTime() <= Date.now()) return NextResponse.json({ error: 'Payment session expired.' }, { status: 409 });
    if (attempt.razorpay_order_id !== parsed.data.razorpayOrderId) return NextResponse.json({ error: 'Razorpay order mismatch.' }, { status: 400 });
    const { data: branch } = await admin.from('branches').select('organization_id').eq('id', attempt.branch_id).maybeSingle();
    if (!branch) return NextResponse.json({ error: 'Restaurant not found.' }, { status: 404 });
    const keys = resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin, branch.organization_id, attempt.branch_id));
    if (!keys.enabled || !verifyRazorpayPaymentSignature(parsed.data.razorpayOrderId, parsed.data.razorpayPaymentId, parsed.data.razorpaySignature, { keyId: keys.keyId, keySecret: keys.secret })) return NextResponse.json({ error: 'Payment signature verification failed.' }, { status: 400 });
    const payment = await fetchRazorpayPayment(parsed.data.razorpayPaymentId, { keyId: keys.keyId, keySecret: keys.secret });
    if (payment.order_id !== parsed.data.razorpayOrderId || Number(payment.amount) !== Math.round(Number(attempt.amount) * 100)) return NextResponse.json({ error: 'Payment details do not match the outstanding balance.' }, { status: 400 });
    if (String(payment.status).toUpperCase() !== 'CAPTURED') return NextResponse.json({ ok: true, paid: false, status: payment.status });
    const { data, error } = await supabase.rpc('finalize_pay_later_payment_attempt', { p_attempt_id: attempt.id, p_attempt_token: attempt.attempt_token, p_razorpay_payment_id: parsed.data.razorpayPaymentId, p_razorpay_order_id: parsed.data.razorpayOrderId, p_payment_method: payment.method ?? 'ONLINE' });
    if (error) return NextResponse.json({ error: error.message.includes('expired') ? 'Payment session expired.' : 'Could not finalize payment.' }, { status: error.message.includes('expired') ? 409 : 500 });
    return NextResponse.json({ ok: true, paid: true, result: Array.isArray(data) ? data[0] : data });
  } catch (error) {
    console.error('payments/pay-later/verify', error);
    return NextResponse.json({ error: 'Could not verify payment.' }, { status: 500 });
  }
}
