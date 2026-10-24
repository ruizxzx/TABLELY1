import { NextResponse } from 'next/server';
import { getSupportAdminContext } from '@/lib/support-admin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const resolved = await getSupportAdminContext();
  if (resolved.error) return resolved.error;

  const query = new URL(request.url).searchParams;
  const status = query.get('status');
  let ticketsQuery = resolved.context.admin
    .from('support_tickets')
    .select('id,ticket_number,organization_id,branch_id,created_by,category,subject,description,priority,status,assigned_to,last_message_at,created_at,updated_at,resolved_at')
    .order('updated_at', { ascending: false })
    .limit(100);
  if (status && status !== 'ALL') ticketsQuery = ticketsQuery.eq('status', status);

  const { data: tickets, error } = await ticketsQuery;
  if (error) {
    console.error('platform support ticket list', error);
    return NextResponse.json({ error: 'Support inbox could not be loaded.' }, { status: 503 });
  }
  const organizationIds = [...new Set((tickets ?? []).map((ticket) => ticket.organization_id))];
  const { data: organizations, error: organizationError } = organizationIds.length
    ? await resolved.context.admin.from('organizations').select('id,name,slug,created_at').in('id', organizationIds)
    : { data: [], error: null };
  if (organizationError) {
    console.error('platform support restaurant context', organizationError);
    return NextResponse.json({ error: 'Restaurant context could not be loaded.' }, { status: 503 });
  }
  const organizationById = new Map((organizations ?? []).map((organization) => [organization.id, organization]));
  return NextResponse.json({
    tickets: (tickets ?? []).map((ticket) => ({
      ...ticket,
      organization: organizationById.get(ticket.organization_id) ?? null,
    })),
  });
}
