import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ conversationId: string }> };

const replySchema = z.object({
  clientMessageId: z.string().uuid(),
  body: z.string().trim().min(1).max(4000),
});

export async function GET(request: Request, { params }: RouteContext) {
  const branchId = new URL(request.url).searchParams.get('branchId');
  const resolved = await resolveServerRestaurantAccess({ branchId });
  if (resolved.error) return resolved.error;
  const { access } = resolved;
  if (!['OWNER', 'MANAGER', 'WAITER'].includes(access.context.staff.role)) {
    return NextResponse.json({ error: 'Customer message access is required.' }, { status: 403 });
  }
  const { conversationId } = await params;
  const { data: conversation, error: conversationError } = await access.admin
    .from('customer_restaurant_conversations')
    .select('id,table_id,table_session_id,branch_id,status,created_at,last_message_at,expires_at')
    .eq('id', conversationId)
    .eq('branch_id', access.branchId)
    .maybeSingle();
  if (conversationError) {
    console.error('customer message conversation lookup', conversationError);
    return NextResponse.json({ error: 'Conversation could not be loaded.' }, { status: 503 });
  }
  if (!conversation) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  if (conversation.status === 'CLOSED' || new Date(conversation.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'This conversation has ended.' }, { status: 410 });
  }

  const { data: messages, error } = await access.admin
    .from('customer_restaurant_messages')
    .select('id,client_message_id,sender_type,sender_user_id,body,created_at')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(100);
  if (error) {
    console.error('customer message history', error);
    return NextResponse.json({ error: 'Conversation messages could not be loaded.' }, { status: 503 });
  }
  const { data: table, error: tableError } = await access.admin
    .from('tables').select('table_number').eq('id', conversation.table_id).eq('branch_id', access.branchId).maybeSingle();
  if (tableError) {
    console.error('customer message table lookup', tableError);
    return NextResponse.json({ error: 'Table information could not be loaded.' }, { status: 503 });
  }
  return NextResponse.json({
    conversation: { ...conversation, table_number: table?.table_number ?? null },
    messages: (messages ?? []).reverse(),
  });
}

export async function POST(request: Request, { params }: RouteContext) {
  const parsed = replySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Enter a valid message.' }, { status: 400 });
  const branchId = new URL(request.url).searchParams.get('branchId');
  const resolved = await resolveServerRestaurantAccess({ branchId });
  if (resolved.error) return resolved.error;
  const { access } = resolved;
  if (!['OWNER', 'MANAGER', 'WAITER'].includes(access.context.staff.role)) {
    return NextResponse.json({ error: 'Customer message access is required.' }, { status: 403 });
  }
  const { conversationId } = await params;
  const { data: conversation, error: conversationError } = await access.admin
    .from('customer_restaurant_conversations')
    .select('id,status,expires_at')
    .eq('id', conversationId)
    .eq('branch_id', access.branchId)
    .maybeSingle();
  if (conversationError) {
    console.error('customer message reply lookup', conversationError);
    return NextResponse.json({ error: 'Conversation could not be verified.' }, { status: 503 });
  }
  if (!conversation) return NextResponse.json({ error: 'Conversation not found.' }, { status: 404 });
  if (conversation.status === 'CLOSED' || new Date(conversation.expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: 'This conversation has ended.' }, { status: 410 });
  }

  if (conversation.status !== 'OPEN') {
    const { error } = await access.admin.from('customer_restaurant_conversations')
      .update({ status: 'OPEN', updated_at: new Date().toISOString() })
      .eq('id', conversation.id)
      .eq('branch_id', access.branchId);
    if (error) {
      console.error('customer conversation staff reopen', error);
      return NextResponse.json({ error: 'Conversation could not be reopened.' }, { status: 503 });
    }
  }

  const { data: message, error } = await access.admin
    .from('customer_restaurant_messages')
    .upsert({
      conversation_id: conversation.id,
      client_message_id: parsed.data.clientMessageId,
      sender_type: 'STAFF',
      sender_user_id: access.context.userId,
      body: parsed.data.body,
    }, { onConflict: 'conversation_id,client_message_id', ignoreDuplicates: true })
    .select('id,client_message_id,sender_type,sender_user_id,body,created_at')
    .maybeSingle();
  if (error) {
    console.error('customer conversation staff reply', error);
    return NextResponse.json({ error: 'Message could not be sent.' }, { status: 503 });
  }
  if (message) return NextResponse.json({ message }, { status: 201 });
  const { data: existing, error: lookupError } = await access.admin
    .from('customer_restaurant_messages')
    .select('id,client_message_id,sender_type,sender_user_id,body,created_at')
    .eq('conversation_id', conversation.id)
    .eq('client_message_id', parsed.data.clientMessageId)
    .single();
  if (lookupError) {
    console.error('customer message staff idempotency lookup', lookupError);
    return NextResponse.json({ error: 'Message status could not be confirmed.' }, { status: 503 });
  }
  return NextResponse.json({ message: existing }, { status: 200 });
}
