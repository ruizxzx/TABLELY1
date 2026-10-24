import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

const schema = z.object({
  category: z.enum(['Restaurant', 'Cafe', 'Quick Service Restaurant', 'Bakery', 'Food Truck', 'Cloud Kitchen', 'Bar / Pub', 'Other']),
  cuisine: z.string().trim().max(100).optional().default(''),
  email: z.union([z.string().trim().email().max(254), z.literal('')]).optional().default(''),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Choose a valid restaurant category and cuisine.' }, { status: 400 });
  const resolved = await resolveServerRestaurantAccess({ ownerOnly: true });
  if ('error' in resolved) return resolved.error;
  const { access } = resolved;
  const { error } = await access.admin.from('organizations').update({
    restaurant_category: parsed.data.category,
    cuisine_type: parsed.data.cuisine || null,
    business_email: parsed.data.email || null,
  }).eq('id', access.context.organization.id);
  if (error) return NextResponse.json({ error: 'Could not save restaurant category details.' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
