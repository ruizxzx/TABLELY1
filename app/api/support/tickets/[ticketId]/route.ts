import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveServerRestaurantAccess, type ServerRestaurantAccess } from '@/lib/server-restaurant';

export const dynamic = 'force-dynamic';

const messageSchema = z.object({
  body: z.string().trim().min(1).max(10000),
});

type RouteContext = { params: Promise<{ ticketId: string }> };

async function findAccessibleTicket(
  access: ServerRestaurantAccess,
  ticketId: string,
) {
  const branchIds = access.context.branches.map((branch) => branch.id);
  return access.admin
    .from('support_tickets')
    .select('id,ticket_number,branch_id,category,subject,description,priority,status,last_message_at,created_at,updated_at,resolved_at')
    .eq('id', ticketId)
    .eq('organization_id', access.context.organization.id)
    .in('branch_id', branchIds)
    .maybeSingle();
}

export async function GET(_request: Request, { params }: RouteContext) {
  const resolved = await resolveServerRestaurantAccess();
  if (resolved.error) return resolved.error;
  const { access } = resolved;
  if (!['OWNER', 'MANAGER'].includes(access.context.staff.role)) {
    return NextResponse.json({ error: 'Owner or manager access is required.' }, { status: 403 });
  }
  const { ticketId } = await params;
  const { data: ticket, error: ticketError } = await findAccessibleTicket(access, ticketId);
  if (ticketError) {
    console.error('restaurant support ticket lookup', ticketError);
    return NextResponse.json({ error: 'Support conversation could not be loaded.' }, { status: 503 });
  }
  if (!ticket) return NextResponse.json({ error: 'Support request not found.' }, { status: 404 });

  const { data: messages, error } = await access.admin
    .from('support_ticket_messages')
    .select('id,author_type,body,created_at')
    .eq('ticket_id', ticket.id)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) {
    console.error('restaurant support conversation', error);
    return NextResponse.json({ error: 'Support conversation could not be loaded.' }, { status: 503 });
  }
  return NextResponse.json({ ticket, messages: messages ?? [] });
}

export async function POST(request: Request, { params }: RouteContext) {
  const parsed = messageSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Enter a valid message.' }, { status: 400 });

  const resolved = await resolveServerRestaurantAccess();
  if (resolved.error) return resolved.error;
  const { access } = resolved;
  if (!['OWNER', 'MANAGER'].includes(access.context.staff.role)) {
    return NextResponse.json({ error: 'Owner or manager access is required.' }, { status: 403 });
  }
  const { ticketId } = await params;
  const { data: ticket, error: ticketError } = await findAccessibleTicket(access, ticketId);
  if (ticketError) {
    console.error('restaurant support reply lookup', ticketError);
    return NextResponse.json({ error: 'Support conversation could not be loaded.' }, { status: 503 });
  }
  if (!ticket) return NextResponse.json({ error: 'Support request not found.' }, { status: 404 });

  if (ticket.status === 'CLOSED' || ticket.status === 'RESOLVED') {
    const { error } = await access.admin.from('support_tickets')
      .update({ status: 'OPEN', resolved_at: null, updated_by: access.context.userId, updated_at: new Date().toISOString() })
      .eq('id', ticket.id);
    if (error) {
      console.error('restaurant support ticket reopen', error);
      return NextResponse.json({ error: 'Support request could not be reopened.' }, { status: 503 });
    }
  }

  const { data: message, error } = await access.admin
    .from('support_ticket_messages')
    .insert({
      ticket_id: ticket.id,
      author_type: 'RESTAURANT',
      author_user_id: access.context.userId,
      body: parsed.data.body,
    })
    .select('id,author_type,body,created_at')
    .single();
  if (error) {
    console.error('restaurant support reply create', error);
    return NextResponse.json({ error: 'Message could not be sent.' }, { status: 503 });
  }
  return NextResponse.json({ message }, { status: 201 });
}
