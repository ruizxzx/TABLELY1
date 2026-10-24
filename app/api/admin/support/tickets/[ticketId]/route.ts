import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupportAdminContext } from '@/lib/support-admin';

export const dynamic = 'force-dynamic';

const statusSchema = z.enum(['NEW', 'OPEN', 'WAITING_FOR_RESTAURANT', 'ESCALATED', 'RESOLVED', 'CLOSED']);
const prioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const bodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), body: z.string().trim().min(1).max(10000) }),
  z.object({ type: z.literal('note'), body: z.string().trim().min(1).max(10000) }),
]);
const patchSchema = z.object({
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  assignedTo: z.string().uuid().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);

type RouteContext = { params: Promise<{ ticketId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const resolved = await getSupportAdminContext();
  if (resolved.error) return resolved.error;
  const { ticketId } = await params;
  const { data: ticket, error: ticketError } = await resolved.context.admin
    .from('support_tickets')
    .select('id,ticket_number,organization_id,branch_id,created_by,category,subject,description,priority,status,assigned_to,last_message_at,created_at,updated_at,resolved_at')
    .eq('id', ticketId)
    .maybeSingle();
  if (ticketError) {
    console.error('platform support ticket lookup', ticketError);
    return NextResponse.json({ error: 'Support conversation could not be loaded.' }, { status: 503 });
  }
  if (!ticket) return NextResponse.json({ error: 'Support request not found.' }, { status: 404 });

  const [messages, notes, audit, branch, organization] = await Promise.all([
    resolved.context.admin.from('support_ticket_messages').select('id,author_type,author_user_id,body,created_at').eq('ticket_id', ticket.id).order('created_at').limit(500),
    resolved.context.admin.from('support_internal_notes').select('id,author_user_id,body,created_at').eq('ticket_id', ticket.id).order('created_at').limit(500),
    resolved.context.admin.from('support_audit_logs').select('id,actor_user_id,action,details,created_at').eq('ticket_id', ticket.id).order('created_at', { ascending: false }).limit(100),
    ticket.branch_id ? resolved.context.admin.from('branches').select('id,name').eq('id', ticket.branch_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    resolved.context.admin.from('organizations').select('id,name,slug,created_at').eq('id', ticket.organization_id).maybeSingle(),
  ]);
  const failed = messages.error ?? notes.error ?? audit.error ?? branch.error ?? organization.error;
  if (failed) {
    console.error('platform support ticket detail', failed);
    return NextResponse.json({ error: 'Support conversation details could not be loaded.' }, { status: 503 });
  }
  return NextResponse.json({
    ticket: { ...ticket, branch: branch.data, organization: organization.data },
    messages: messages.data ?? [],
    internalNotes: notes.data ?? [],
    audit: audit.data ?? [],
  });
}

export async function POST(request: Request, { params }: RouteContext) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Enter a valid message or private note.' }, { status: 400 });

  const resolved = await getSupportAdminContext();
  if (resolved.error) return resolved.error;
  const { ticketId } = await params;
  const { data: ticket, error: ticketError } = await resolved.context.admin
    .from('support_tickets').select('id,status').eq('id', ticketId).maybeSingle();
  if (ticketError) {
    console.error('platform support reply lookup', ticketError);
    return NextResponse.json({ error: 'Support conversation could not be loaded.' }, { status: 503 });
  }
  if (!ticket) return NextResponse.json({ error: 'Support request not found.' }, { status: 404 });

  if (parsed.data.type === 'note') {
    const { data, error } = await resolved.context.admin.from('support_internal_notes')
      .insert({ ticket_id: ticket.id, author_user_id: resolved.context.user.id, body: parsed.data.body })
      .select('id,author_user_id,body,created_at').single();
    if (error) {
      console.error('platform support internal note', error);
      return NextResponse.json({ error: 'Private note could not be saved.' }, { status: 503 });
    }
    return NextResponse.json({ note: data }, { status: 201 });
  }

  const { data: message, error } = await resolved.context.admin.from('support_ticket_messages')
    .insert({
      ticket_id: ticket.id,
      author_type: 'PLATFORM',
      author_user_id: resolved.context.user.id,
      body: parsed.data.body,
    })
    .select('id,author_type,author_user_id,body,created_at').single();
  if (error) {
    console.error('platform support reply create', error);
    return NextResponse.json({ error: 'Message could not be sent.' }, { status: 503 });
  }
  const { error: updateError } = await resolved.context.admin.from('support_tickets')
    .update({ status: 'WAITING_FOR_RESTAURANT', resolved_at: null, updated_by: resolved.context.user.id, updated_at: new Date().toISOString() })
    .eq('id', ticket.id);
  if (updateError) {
    console.error('platform support reply status', updateError);
    return NextResponse.json({ error: 'Message was sent, but ticket status could not be updated.' }, { status: 503 });
  }
  return NextResponse.json({ message }, { status: 201 });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid support ticket update.' }, { status: 400 });

  const resolved = await getSupportAdminContext();
  if (resolved.error) return resolved.error;
  const { ticketId } = await params;
  const updates: Record<string, unknown> = { updated_by: resolved.context.user.id, updated_at: new Date().toISOString() };
  if (parsed.data.status) {
    updates.status = parsed.data.status;
    updates.resolved_at = ['RESOLVED', 'CLOSED'].includes(parsed.data.status) ? new Date().toISOString() : null;
  }
  if (parsed.data.priority) updates.priority = parsed.data.priority;
  if (parsed.data.assignedTo !== undefined) updates.assigned_to = parsed.data.assignedTo;
  const { data, error } = await resolved.context.admin.from('support_tickets')
    .update(updates)
    .eq('id', ticketId)
    .select('id,ticket_number,status,priority,assigned_to,updated_at,resolved_at')
    .maybeSingle();
  if (error) {
    console.error('platform support ticket update', error);
    return NextResponse.json({ error: 'Support ticket could not be updated.' }, { status: 503 });
  }
  if (!data) return NextResponse.json({ error: 'Support request not found.' }, { status: 404 });
  return NextResponse.json({ ticket: data });
}
