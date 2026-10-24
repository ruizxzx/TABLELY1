import { createHmac, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token && token === process.env.META_WEBHOOK_VERIFY_TOKEN?.trim() && challenge) {
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

export async function POST(request: Request) {
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: 'Webhook unavailable.' }, { status: 503 });
  const raw = await request.text();
  const signature = request.headers.get('x-hub-signature-256') || '';
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const providedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 401 });
  }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Webhook unavailable.' }, { status: 503 });
  let body: { entry?: Array<{ changes?: Array<{ value?: Record<string, any> }> }> };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Webhook payload could not be processed.' }, { status: 400 });
  }
  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const phoneNumberId = value.metadata?.phone_number_id;
        if (typeof phoneNumberId !== 'string' || !phoneNumberId) continue;
        const { data: connection, error: connectionError } = await db.from('restaurant_whatsapp_connections').select('organization_id').eq('phone_number_id', phoneNumberId).maybeSingle();
        if (connectionError) throw connectionError;
        if (!connection) continue;
        for (const status of value.statuses ?? []) {
          const messageId = String(status.id ?? '');
          if (!messageId) continue;
          const normalized = String(status.status ?? '').toUpperCase();
          const mapped = ['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(normalized) ? normalized : null;
          const { data: queue, error: queueError } = await db.from('restaurant_notification_queue').select('id,status').eq('organization_id', connection.organization_id).eq('provider_message_id', messageId).maybeSingle();
          if (queueError) throw queueError;
          const { error: eventError } = await db.from('restaurant_notification_events').upsert({ organization_id: connection.organization_id, queue_id: queue?.id ?? null, provider_event_id: `${messageId}:${normalized}:${status.timestamp ?? ''}`, provider_message_id: messageId, event_type: normalized, payload: { errors: (status.errors ?? []).map((x: { code?: number; title?: string }) => ({ code: x.code, title: x.title })) } }, { onConflict: 'provider_event_id', ignoreDuplicates: true });
          if (eventError) throw eventError;
          if (queue && mapped) {
            const rank: Record<string, number> = { QUEUED: 0, SENDING: 1, FAILED: 1, SENT: 2, DELIVERED: 3, READ: 4, CANCELLED: 5 };
            if ((rank[queue.status] ?? -1) < (rank[mapped] ?? -1)) {
              const lowerStatuses = Object.keys(rank).filter(statusName => rank[statusName] < rank[mapped]);
              const { error: statusError } = await db.from('restaurant_notification_queue').update({ status: mapped, error_code: mapped === 'FAILED' ? 'meta_delivery_failed' : null, updated_at: new Date().toISOString() }).eq('id', queue.id).eq('organization_id', connection.organization_id).in('status', lowerStatuses);
              if (statusError) throw statusError;
            }
          }
        }
        for (const message of value.messages ?? []) {
          const text = String(message.text?.body ?? '').trim().toUpperCase();
          const from = String(message.from ?? '').replace(/\D/g, '');
          if (['STOP', 'UNSUBSCRIBE', 'CANCEL'].includes(text)) {
            const tail = from.slice(-10);
            if (tail.length !== 10) continue;
            const withdrawnAt = new Date().toISOString();
            const { error: preferenceError } = await db.from('restaurant_customer_preferences').update({ whatsapp_service: false, whatsapp_marketing: false, feedback_messages: false, withdrawn_at: withdrawnAt, updated_at: withdrawnAt }).eq('organization_id', connection.organization_id).eq('phone', tail);
            if (preferenceError) throw preferenceError;
            const recipientHash = createHash('sha256').update(`${connection.organization_id}:${tail}`).digest('hex');
            const { error: cancelError } = await db.from('restaurant_notification_queue').update({ status: 'CANCELLED', error_code: 'customer_withdrew_whatsapp_consent', updated_at: withdrawnAt }).eq('organization_id', connection.organization_id).eq('recipient_hash', recipientHash).eq('channel', 'WHATSAPP').in('status', ['QUEUED', 'FAILED']);
            if (cancelError) throw cancelError;
          }
        }
      }
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Meta WhatsApp webhook', error);
    return NextResponse.json({ error: 'Webhook event could not be durably recorded.' }, { status: 503 });
  }
}
