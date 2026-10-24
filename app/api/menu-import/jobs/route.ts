import { NextResponse } from 'next/server';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const resolved = await resolveServerRestaurantAccess({ branchId: url.searchParams.get('branchId'), permission: 'MENU_MANAGEMENT' });
  if ('error' in resolved) return resolved.error;
  const { data, error } = await resolved.access.supabase.from('menu_import_jobs')
    .select('id,source_filename,status,extracted_count,imported_count,selected_count,skipped_duplicate_count,rejected_count,error_message,created_at')
    .eq('branch_id', resolved.access.branchId).order('created_at', { ascending: false }).limit(20);
  if (error) return NextResponse.json({ error: 'Could not load import history.' }, { status: 500 });
  return NextResponse.json({ jobs: data ?? [] });
}
