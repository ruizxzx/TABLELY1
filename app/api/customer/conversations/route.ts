import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { hashCustomerVisitToken, isCustomerVisitToken } from '@/lib/customer-chat';

export const dynamic = 'force-dynamic';

const openSchema = z.object({
  tableCode: z.string().trim().min(1).max(64),
  visitToken: z.string().min(32).max(128),
});

export async function POST(request: Request) {
  const parsed = openSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !isCustomerVisitToken(parsed.data?.visitToken)) {
    return NextResponse.json({ error: 'A valid table visit is required.' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Messaging is not configured.' }, { status: 503 });

  const { data, error } = await admin.rpc('open_customer_restaurant_conversation', {
    p_table_code: parsed.data.tableCode,
    p_visit_token_hash: hashCustomerVisitToken(parsed.data.visitToken),
  });
  const conversation = Array.isArray(data) ? data[0] : data;
  if (error || !conversation) {
    if (error?.code === 'P0002') {
      return NextResponse.json({ error: 'This table is not available for messaging.' }, { status: 404 });
    }
    if (error?.code === 'P0001' && error.message?.includes('visit has ended')) {
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
    console.error('customer conversation open', error);
    return NextResponse.json({ error: 'Could not open a conversation with this restaurant.' }, { status: 503 });
  }

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      status: conversation.status,
      expiresAt: conversation.expires_at,
      channel: `tablely:customer-conversation:${conversation.channel_key}`,
      tableNumber: conversation.table_number,
    },
  });
}
