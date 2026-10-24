import { NextResponse } from 'next/server';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';
import { validateMenuImportDrafts } from '@/lib/menu-import-parser';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { jobId?: string; branchId?: string; items?: unknown } | null;
  if (!body?.jobId || typeof body.jobId !== 'string') return NextResponse.json({ error: 'A valid import job is required.' }, { status: 400 });
  const resolved = await resolveServerRestaurantAccess({ branchId: body.branchId, permission: 'MENU_MANAGEMENT' });
  if ('error' in resolved) return resolved.error;
  const { access } = resolved;
  let items;
  try { items = validateMenuImportDrafts(body.items); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid menu items.' }, { status: 400 }); }
  const { data: job, error: jobError } = await access.admin.from('menu_import_jobs')
    .select('id,branch_id,user_id,status')
    .eq('id', body.jobId).eq('branch_id', access.branchId).maybeSingle();
  if (jobError || !job) return NextResponse.json({ error: 'Menu import job not found.' }, { status: 404 });
  if (job.user_id !== access.context.userId && access.context.staff.role !== 'OWNER') return NextResponse.json({ error: 'This import belongs to another user.' }, { status: 403 });
  if (job.status !== 'PREVIEW') return NextResponse.json({ error: 'This import is no longer awaiting approval.' }, { status: 409 });
  const { data, error } = await access.supabase.rpc('commit_menu_import_job', {
    p_job_id: body.jobId,
    p_items: items.map((item) => ({ name: item.name, category: item.category, description: item.description, price: item.price, is_veg: item.is_veg, variants: item.variants, modifier_groups: item.modifier_groups })),
  });
  if (error) {
    console.error('menu import commit failed', { code: error.code, message: error.message });
    return NextResponse.json({ error: error.message.includes('permission') ? 'Menu management permission is required.' : 'Could not commit this menu import. No partial success is reported; review the import and retry.' }, { status: 400 });
  }
  return NextResponse.json({ ok: true, result: data });
}
