import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { orderId?: unknown; cancelToken?: unknown };
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    const cancelToken = typeof body.cancelToken === 'string' ? body.cancelToken : '';
    if (!orderId || !cancelToken) return NextResponse.json({ ok: false, error: 'Order and cancellation token are required.' }, { status: 400 });
    const admin = getAdminSupabase();
    const now = new Date().toISOString();
    const tokenHash=createHash('sha256').update(cancelToken).digest('hex');
    const { data:order,error:readError }=await admin.from('orders').select('id,status,checkout_cancel_token_hash').eq('id',orderId).maybeSingle();
    if(readError) throw readError;
    if(!order || order.checkout_cancel_token_hash!==tokenHash) return NextResponse.json({ok:false,error:'Invalid checkout cancellation token.'},{status:403});
    const { error } = await admin.from('orders').update({ status: 'cancelled', payment_status: 'cancelled', updated_at: now }).eq('id', orderId).in('status', ['created', 'pending']);
    if (error) throw error;
    await admin.from('payment_transactions').update({ status: 'cancelled', updated_at: now }).eq('order_id', orderId).in('status', ['initializing', 'pending', 'processing']);
    return NextResponse.json({ ok: true, orderId });
  } catch (error) {
    console.error('[payments/cancel]', error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Could not cancel payment.' }, { status: 500 });
  }
}
