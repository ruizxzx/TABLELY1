import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidToken(invitationId: string, token: string) {
  const secret = (process.env.CRON_SECRET || process.env.SELLORA_CRON_SECRET || '').trim();
  if (!secret || !/^[a-f0-9]{64}$/i.test(token)) return false;
  const expected = createHmac('sha256', secret).update(invitationId).digest();
  const supplied = Buffer.from(token, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const invitationId = url.searchParams.get('invitationId') ?? '';
  const token = url.searchParams.get('token') ?? '';
  if (!UUID_PATTERN.test(invitationId) || !isValidToken(invitationId, token)) {
    return NextResponse.json({ error: 'This feedback email link is invalid or expired.' }, { status: 403 });
  }

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Email preferences are temporarily unavailable.' }, { status: 503 });
  const { data: invitation, error: invitationError } = await db.from('restaurant_feedback_invitations')
    .select('id,organization_id,branch_id,order_id,status,channel')
    .eq('id', invitationId)
    .maybeSingle();
  if (invitationError) {
    console.error('[customer-engagement/email-unsubscribe] Could not load invitation:', invitationError.message);
    return NextResponse.json({ error: 'Email preferences could not be updated.' }, { status: 503 });
  }
  if (!invitation) return NextResponse.json({ error: 'Feedback email invitation not found.' }, { status: 404 });
  if (invitation.channel !== 'EMAIL') return NextResponse.json({ error: 'Feedback email invitation not found.' }, { status: 404 });

  const { data: order, error: orderError } = await db.from('orders')
    .select('branch_id,customer_profile_id,customer_phone')
    .eq('id', invitation.order_id)
    .eq('branch_id', invitation.branch_id)
    .maybeSingle();
  if (orderError) {
    console.error('[customer-engagement/email-unsubscribe] Could not load order identity:', orderError.message);
    return NextResponse.json({ error: 'Email preferences could not be updated.' }, { status: 503 });
  }
  if (!order) return NextResponse.json({ error: 'Feedback email invitation not found.' }, { status: 404 });

  const phone = order.customer_phone?.replace(/\D/g, '').slice(-10) ?? null;
  let update = db.from('restaurant_customer_preferences')
    .update({ feedback_email: false, feedback_email_withdrawn_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('organization_id', invitation.organization_id);
  update = order.customer_profile_id
    ? update.eq('customer_id', order.customer_profile_id)
    : phone ? update.eq('phone', phone) : update.eq('id', '00000000-0000-0000-0000-000000000000');
  const { error: preferenceError } = await update;
  if (preferenceError) {
    console.error('[customer-engagement/email-unsubscribe] Could not withdraw consent:', preferenceError.message);
    return NextResponse.json({ error: 'Email preferences could not be updated.' }, { status: 503 });
  }

  const { error: queueError } = await db.from('restaurant_notification_queue')
    .update({ status: 'CANCELLED', error_code: 'feedback_email_consent_withdrawn', updated_at: new Date().toISOString() })
    .eq('organization_id', invitation.organization_id)
    .eq('order_id', invitation.order_id)
    .eq('channel', 'EMAIL')
    .eq('event_key', 'FEEDBACK_REQUEST')
    .in('status', ['QUEUED', 'FAILED']);
  if (queueError) {
    console.error('[customer-engagement/email-unsubscribe] Consent was withdrawn but pending invitations could not be cancelled:', queueError.message);
    return NextResponse.json({ error: 'Consent was withdrawn, but pending email delivery could not be cancelled.' }, { status: 503 });
  }

  const { error: updateInvitationError } = await db.from('restaurant_feedback_invitations')
    .update({ status: 'CANCELLED' }).eq('id', invitation.id).eq('status', 'QUEUED');
  if (updateInvitationError) {
    console.error('[customer-engagement/email-unsubscribe] Consent was withdrawn but invitation status could not be updated:', updateInvitationError.message);
    return NextResponse.json({ error: 'Consent was withdrawn, but invitation status could not be updated.' }, { status: 503 });
  }
  return NextResponse.json({ ok: true, message: 'You will not receive future private feedback emails from this restaurant.' });
}
