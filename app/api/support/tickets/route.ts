import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export const dynamic = 'force-dynamic';

const categories = [
  'TECHNICAL', 'QR_MENU', 'PAYMENTS', 'BILLING', 'SUBSCRIPTION',
  'BRANCH', 'STAFF_PERMISSIONS', 'WHATSAPP', 'GOOGLE_REVIEWS',
  'GENERAL', 'FEATURE_REQUEST',
] as const;

const createSchema = z.object({
  category: z.enum(categories),
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(1).max(10000),
});

export async function GET() {
  const resolved = await resolveServerRestaurantAccess();
  if (resolved.error) return resolved.error;
  const { access } = resolved;
  if (!['OWNER', 'MANAGER'].includes(access.context.staff.role)) {
    return NextResponse.json({ error: 'Owner or manager access is required.' }, { status: 403 });
  }

  const branchIds = access.context.branches.map((branch) => branch.id);
  const { data, error } = await access.admin
    .from('support_tickets')
    .select('id,ticket_number,branch_id,category,subject,description,priority,status,last_message_at,created_at,updated_at')
    .eq('organization_id', access.context.organization.id)
    .in('branch_id', branchIds)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) {
    console.error('restaurant support ticket list', error);
    return NextResponse.json({ error: 'Support requests could not be loaded.' }, { status: 503 });
  }
  return NextResponse.json({ tickets: data ?? [] });
}

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter a valid support subject, category, and description.' }, { status: 400 });
  }

  const resolved = await resolveServerRestaurantAccess();
  if (resolved.error) return resolved.error;
  const { access } = resolved;
  if (!['OWNER', 'MANAGER'].includes(access.context.staff.role)) {
    return NextResponse.json({ error: 'Owner or manager access is required.' }, { status: 403 });
  }

  const { data, error } = await access.admin.rpc('create_restaurant_support_ticket', {
    p_organization_id: access.context.organization.id,
    p_branch_id: access.branchId,
    p_created_by: access.context.userId,
    p_category: parsed.data.category,
    p_subject: parsed.data.subject,
    p_description: parsed.data.description,
  });
  if (error || !data) {
    console.error('restaurant support ticket create', error);
    return NextResponse.json({ error: 'Support request could not be created.' }, { status: 503 });
  }
  return NextResponse.json({ ticket: data }, { status: 201 });
}
