import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM times.');
const businessHoursSchema = z.object({
  monday: z.object({ open: timeSchema, close: timeSchema }).strict().optional(),
  tuesday: z.object({ open: timeSchema, close: timeSchema }).strict().optional(),
  wednesday: z.object({ open: timeSchema, close: timeSchema }).strict().optional(),
  thursday: z.object({ open: timeSchema, close: timeSchema }).strict().optional(),
  friday: z.object({ open: timeSchema, close: timeSchema }).strict().optional(),
  saturday: z.object({ open: timeSchema, close: timeSchema }).strict().optional(),
  sunday: z.object({ open: timeSchema, close: timeSchema }).strict().optional(),
}).strict().default({});

const schema = z.object({
  branchId: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(100),
  address: z.string().trim().min(2).max(300),
  phone: z.string().trim().max(30).optional().default(''),
  timezone: z.string().trim().min(1).max(100).default('Asia/Kolkata'),
  businessHours: businessHoursSchema,
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid branch setup details.' }, { status: 400 });
  const resolved = await resolveServerRestaurantAccess({ branchId: parsed.data.branchId, ownerOnly: true });
  if ('error' in resolved) return resolved.error;
  const { access } = resolved;
  try { new Intl.DateTimeFormat('en-US', { timeZone: parsed.data.timezone }); }
  catch { return NextResponse.json({ error: 'Choose a valid IANA timezone.' }, { status: 400 }); }
  const { error } = await access.admin.from('branches').update({
    name: parsed.data.name,
    address: parsed.data.address,
    phone: parsed.data.phone || null,
    timezone: parsed.data.timezone,
    business_hours: parsed.data.businessHours,
  }).eq('id', access.branchId).eq('organization_id', access.context.organization.id);
  if (error) return NextResponse.json({ error: 'Could not save branch configuration.' }, { status: 500 });
  return NextResponse.json({ ok: true, branchId: access.branchId });
}
