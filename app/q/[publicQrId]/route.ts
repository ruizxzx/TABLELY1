import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unavailable(status = 404) {
  return new NextResponse('This table QR code is unavailable. Please ask restaurant staff for assistance.', {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0', 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export async function GET(request: Request, { params }: { params: Promise<{ publicQrId: string }> }) {
  const { publicQrId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicQrId)) return unavailable();
  const admin = getSupabaseAdminClient();
  if (!admin) return new NextResponse('QR resolver is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store' } });

  const { data: table, error: tableError } = await admin.from('tables')
    .select('id,table_code,active,branch_id')
    .eq('public_qr_id', publicQrId)
    .maybeSingle();
  if (tableError || !table || !table.active) return unavailable(table && !table.active ? 410 : 404);

  const { data: branch, error: branchError } = await admin.from('branches')
    .select('id,organization_id,is_active')
    .eq('id', table.branch_id)
    .maybeSingle();
  if (branchError || !branch || !branch.is_active) return unavailable(410);

  const { data: organization, error: organizationError } = await admin.from('organizations')
    .select('slug,status')
    .eq('id', branch.organization_id)
    .maybeSingle();
  if (organizationError || !organization || organization.status !== 'ACTIVE' || !organization.slug) return unavailable(410);

  const target = new URL(`/r/${encodeURIComponent(organization.slug)}/table/${encodeURIComponent(table.table_code)}`, request.url);
  target.searchParams.set('qr', publicQrId);
  return NextResponse.redirect(target, {
    status: 307,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
