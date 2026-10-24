import { NextResponse } from 'next/server';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const branchId = new URL(request.url).searchParams.get('branchId');
  const resolved = await resolveServerRestaurantAccess({ branchId });
  if (resolved.error) return resolved.error;
  const { access } = resolved;
  if (!['OWNER', 'MANAGER', 'WAITER'].includes(access.context.staff.role)) {
    return NextResponse.json({ error: 'Customer message access is required.' }, { status: 403 });
  }

  const { data: conversations, error } = await access.admin
    .from('customer_restaurant_conversations')
    .select('id,table_id,table_session_id,status,created_at,last_message_at,expires_at,unread_customer_count')
    .eq('branch_id', access.branchId)
    .eq('status', 'OPEN')
    .gt('expires_at', new Date().toISOString())
    .order('last_message_at', { ascending: false })
    .limit(100);
  if (error) {
    console.error('customer message inbox', error);
    return NextResponse.json({ error: 'Customer messages could not be loaded.' }, { status: 503 });
  }

  const tableIds = [...new Set((conversations ?? []).map((conversation) => conversation.table_id))];
  const { data: tables, error: tableError } = tableIds.length
    ? await access.admin.from('tables').select('id,table_number').in('id', tableIds).eq('branch_id', access.branchId)
    : { data: [], error: null };
  if (tableError) {
    console.error('customer message table labels', tableError);
    return NextResponse.json({ error: 'Table information could not be loaded.' }, { status: 503 });
  }
  const tableById = new Map((tables ?? []).map((table) => [table.id, table.table_number]));
  const conversationIds = (conversations ?? []).map((conversation) => conversation.id);
  const { data: messageRows, error: messageError } = conversationIds.length
    ? await access.admin.from('customer_restaurant_messages')
      .select('conversation_id,body,created_at')
      .in('conversation_id', conversationIds)
      .order('created_at', { ascending: false })
      .limit(500)
    : { data: [], error: null };
  if (messageError) {
    console.error('customer message inbox previews', messageError);
    return NextResponse.json({ error: 'Customer message previews could not be loaded.' }, { status: 503 });
  }
  const latestMessageByConversation = new Map<string, string>();
  for (const message of messageRows ?? []) {
    if (!latestMessageByConversation.has(message.conversation_id)) {
      latestMessageByConversation.set(message.conversation_id, message.body);
    }
  }
  return NextResponse.json({
    conversations: (conversations ?? []).map((conversation) => ({
      ...conversation,
      table_number: tableById.get(conversation.table_id) ?? null,
      latest_message: latestMessageByConversation.get(conversation.id) ?? null,
    })),
  });
}
