import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { hashCustomerVisitToken, isCustomerVisitToken } from '@/lib/customer-chat';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  visitToken: z.string().min(32).max(128),
  after: z.string().datetime().optional(),
  afterId: z.string().uuid().optional(),
});

type RouteContext = { params: Promise<{ conversationId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    visitToken: request.headers.get('x-tablely-visit-token'),
    after: url.searchParams.get('after') ?? undefined,
    afterId: url.searchParams.get('afterId') ?? undefined,
  });
  if (!parsed.success || !isCustomerVisitToken(parsed.data?.visitToken)) {
    return NextResponse.json({ error: 'A valid table visit is required.' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Messaging is not configured.' }, { status: 503 });
  const { conversationId } = await params;
  const { data: conversation, error: conversationError } = await admin
    .from('customer_restaurant_conversations')
    .select('id,status,expires_at,visit_token_hash')
    .eq('id', conversationId)
    .eq('visit_token_hash', hashCustomerVisitToken(parsed.data.visitToken))
    .maybeSingle();
  if (conversationError) {
    console.error('customer conversation lookup', conversationError);
    return NextResponse.json({ error: 'Conversation could not be loaded.' }, { status: 503 });
  }
  if (!conversation) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  if (conversation.status === 'CLOSED') {
    return NextResponse.json({ error: 'This table visit has ended. Start a new visit to message the restaurant.' }, { status: 410 });
  }
  if (new Date(conversation.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'This conversation has expired. Start a new visit to contact the restaurant.' }, { status: 410 });
  }

  let messagesQuery = admin
    .from('customer_restaurant_messages')
    .select('id,client_message_id,sender_type,body,created_at')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: parsed.data.after ? true : false })
    .order('id', { ascending: parsed.data.after ? true : false })
    .limit(100);
  if (parsed.data.after) {
    if (parsed.data.afterId) {
      messagesQuery = messagesQuery.or(
        `created_at.gt.${parsed.data.after},and(created_at.eq.${parsed.data.after},id.gt.${parsed.data.afterId})`,
      );
    } else {
      messagesQuery = messagesQuery.gt('created_at', parsed.data.after);
    }
  }

  const { data: rows, error } = await messagesQuery;
  if (error) {
    console.error('customer conversation messages', error);
    return NextResponse.json({ error: 'Messages could not be loaded.' }, { status: 503 });
  }
  const messages = parsed.data.after ? rows ?? [] : (rows ?? []).reverse();
  return NextResponse.json({
    conversation: { id: conversation.id, status: conversation.status, expiresAt: conversation.expires_at },
    messages,
  });
}

const messageSchema = z.object({
  visitToken: z.string().min(32).max(128),
  clientMessageId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});

export async function POST(request: Request, { params }: RouteContext) {
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isCustomerVisitToken(parsed.data?.visitToken)) {
    return NextResponse.json({ error: 'Enter a valid message for this visit.' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Messaging is not configured.' }, { status: 503 });
  const { conversationId } = await params;
  const { data: conversation, error: conversationError } = await admin
    .from('customer_restaurant_conversations')
    .select('id,status,expires_at,visit_token_hash')
    .eq('id', conversationId)
    .eq('visit_token_hash', hashCustomerVisitToken(parsed.data.visitToken))
    .maybeSingle();
  if (conversationError) {
    console.error('customer conversation send lookup', conversationError);
    return NextResponse.json({ error: 'Conversation could not be verified.' }, { status: 503 });
  }
  if (!conversation) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  if (conversation.status === 'CLOSED') {
    return NextResponse.json({ error: 'This table visit has ended. Start a new visit to message the restaurant.' }, { status: 410 });
  }
  if (new Date(conversation.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'This conversation has expired.' }, { status: 410 });
  }

  if (conversation.status !== 'OPEN') {
    const { error } = await admin.from('customer_restaurant_conversations')
      .update({ status: 'OPEN', updated_at: new Date().toISOString() })
      .eq('id', conversation.id);
    if (error) {
      console.error('customer conversation reopen', error);
      return NextResponse.json({ error: 'Conversation could not be reopened.' }, { status: 503 });
    }
  }

  const { data: message, error } = await admin
    .from('customer_restaurant_messages')
    .upsert({
      conversation_id: conversation.id,
      client_message_id: parsed.data.clientMessageId,
      sender_type: 'CUSTOMER',
      body: parsed.data.body,
    }, { onConflict: 'conversation_id,client_message_id', ignoreDuplicates: true })
    .select('id,client_message_id,sender_type,body,created_at')
    .maybeSingle();
  if (error) {
    console.error('customer conversation message insert', error);
    return NextResponse.json({ error: 'Message could not be sent.' }, { status: 503 });
  }

  if (message) return NextResponse.json({ message }, { status: 201 });
  const { data: existing, error: lookupError } = await admin
    .from('customer_restaurant_messages')
    .select('id,client_message_id,sender_type,body,created_at')
    .eq('conversation_id', conversation.id)
    .eq('client_message_id', parsed.data.clientMessageId)
    .single();
  if (lookupError) {
    console.error('customer conversation idempotency lookup', lookupError);
    return NextResponse.json({ error: 'Message status could not be confirmed.' }, { status: 503 });
  }
  return NextResponse.json({ message: existing }, { status: 200 });
}
