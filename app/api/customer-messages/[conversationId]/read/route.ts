import { NextResponse } from 'next/server';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ conversationId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const branchId = new URL(request.url).searchParams.get('branchId');
  const resolved = await resolveServerRestaurantAccess({ branchId });
  if (resolved.error) return resolved.error;
  const { access } = resolved;
  if (!['OWNER', 'MANAGER', 'WAITER'].includes(access.context.staff.role)) {
    return NextResponse.json({ error: 'Customer message access is required.' }, { status: 403 });
  }

  const { conversationId } = await params;
  const { data: conversation, error: lookupError } = await access.admin
    .from('customer_restaurant_conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('branch_id', access.branchId)
    .eq('status', 'OPEN')
    .maybeSingle();
  if (lookupError) {
    console.error('customer conversation read lookup', lookupError);
    return NextResponse.json({ error: 'Conversation read state could not be verified.' }, { status: 503 });
  }
  if (!conversation) return NextResponse.json({ error: 'Open conversation not found.' }, { status: 404 });

  const { error } = await access.admin.rpc('mark_customer_chat_read', {
    p_conversation_id: conversationId,
  });
  if (error) {
    if (error.code === 'P0002') {
      return NextResponse.json({ error: 'This conversation has ended.' }, { status: 410 });
    }
    console.error('customer conversation mark read', error);
    return NextResponse.json({ error: 'Conversation read state could not be saved.' }, { status: 503 });
  }
  return NextResponse.json({ conversation: { id: conversationId, unread_customer_count: 0 } });
}
