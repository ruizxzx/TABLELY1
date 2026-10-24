import { NextResponse } from 'next/server';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const branchId = new URL(request.url).searchParams.get('branchId');
  const resolved = await resolveServerRestaurantAccess({ branchId, permission: 'PAYMENTS' });
  if (resolved.error) return resolved.error;
  const { admin, branchId: scopedBranch } = resolved.access;
  const { data: orders, error } = await admin.from('orders')
    .select('id,order_number,total,payment_status,created_at,customer_name,table_id')
    .eq('branch_id', scopedBranch).eq('payment_status', 'PENDING').order('created_at', { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: 'Could not load unpaid orders.' }, { status: 500 });
  const orderIds = (orders ?? []).map(order => order.id);
  if (!orderIds.length) return NextResponse.json({ orders: [] }, { headers: { 'Cache-Control': 'private, no-store' } });
  const { data: splits, error: splitError } = await admin.from('order_split_bills')
    .select('id,order_id,split_method,expected_amount_paise,status')
    .in('order_id', orderIds);
  if (splitError) return NextResponse.json({ error: 'Split bill data is unavailable. Apply the Build 29 migration first.' }, { status: 503 });
  const splitIds = (splits ?? []).map(split => split.id);
  const { data: participants, error: participantError } = splitIds.length
    ? await admin.from('order_split_participants').select('id,split_bill_id,participant_key,display_name,allocated_amount_paise,paid_amount_paise,status').in('split_bill_id', splitIds)
    : { data: [], error: null };
  if (participantError) return NextResponse.json({ error: 'Split participant data is unavailable.' }, { status: 500 });
  const splitByOrder = new Map((splits ?? []).map(split => [split.order_id, {
    ...split,
    participants: (participants ?? []).filter(participant => participant.split_bill_id === split.id),
  }]));
  return NextResponse.json({ orders: (orders ?? []).map(order => ({ ...order, split: splitByOrder.get(order.id) ?? null })) }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(request: Request) {
  const resolved = await resolveServerRestaurantAccess();
  if (resolved.error) return resolved.error;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }); }
  const action = String(body.action ?? '');
  if (action === 'configure') {
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    const method = typeof body.method === 'string' ? body.method : '';
    const participants = Array.isArray(body.participants) ? body.participants : null;
    if (!orderId || !participants || participants.length < 2 || participants.length > 20) return NextResponse.json({ error: 'A split requires an order and 2 to 20 participants.' }, { status: 400 });
    const { data, error } = await resolved.access.supabase.rpc('configure_order_split', { p_order_id: orderId, p_method: method, p_participants: participants });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, split: data });
  }
  if (action === 'collect') {
    const participantId = typeof body.participantId === 'string' ? body.participantId : '';
    const amountPaise = Number(body.amountPaise);
    const method = typeof body.method === 'string' ? body.method : '';
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
    if (!participantId || !Number.isSafeInteger(amountPaise) || amountPaise <= 0 || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) return NextResponse.json({ error: 'Enter a valid payment amount and request key.' }, { status: 400 });
    const { data, error } = await resolved.access.supabase.rpc('collect_split_counter_payment', {
      p_participant_id: participantId, p_amount_paise: amountPaise, p_method: method, p_idempotency_key: idempotencyKey,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true, settlement: data });
  }
  return NextResponse.json({ error: 'Unsupported split bill action.' }, { status: 400 });
}
