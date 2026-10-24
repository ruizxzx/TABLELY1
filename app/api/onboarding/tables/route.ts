import { NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

const schema = z.object({ branchId: z.string().uuid().optional(), count: z.number().int().min(1).max(100), requestId: z.string().uuid() });

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Choose between 1 and 100 tables.' }, { status: 400 });
  const resolved = await resolveServerRestaurantAccess({ branchId: parsed.data.branchId, ownerOnly: true });
  if ('error' in resolved) return resolved.error;
  const { data, error } = await resolved.access.supabase.rpc('create_onboarding_tables', {
    p_branch_id: resolved.access.branchId,
    p_count: parsed.data.count,
    p_request_id: parsed.data.requestId,
  });
  if (error) {
    console.error('onboarding table creation failed', { code: error.code, message: error.message });
    return NextResponse.json({ error: 'Could not create tables. Apply the Build 28 migration and retry.' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, result: data });
}
