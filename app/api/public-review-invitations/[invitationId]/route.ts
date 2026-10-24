import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

export async function GET(_request: Request, { params }: { params: Promise<{ invitationId: string }> }) {
  const { invitationId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(invitationId)) {
    return NextResponse.json({ error: 'Review invitation not found.' }, { status: 404 });
  }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Review link unavailable.' }, { status: 503 });

  const { data: invite, error: invitationError } = await db.from('restaurant_review_invitations')
    .select('id,organization_id,branch_id,order_id,status')
    .eq('id', invitationId)
    .maybeSingle();
  if (invitationError) {
    console.error('public review invitation lookup failed', invitationError);
    return NextResponse.json({ error: 'Review invitation could not be verified.' }, { status: 503 });
  }
  if (!invite || ['CANCELLED', 'FAILED'].includes(invite.status)) {
    return NextResponse.json({ error: 'Review invitation not found.' }, { status: 404 });
  }

  const [{ data: order, error: orderError }, { data: branch, error: branchError }, { data: settings, error: settingsError }] = await Promise.all([
    db.from('orders').select('id').eq('id', invite.order_id).eq('branch_id', invite.branch_id).maybeSingle(),
    db.from('branches').select('id').eq('id', invite.branch_id).eq('organization_id', invite.organization_id).maybeSingle(),
    db.from('restaurant_google_review_settings').select('review_url').eq('organization_id', invite.organization_id).eq('branch_id', invite.branch_id).maybeSingle(),
  ]);
  if (orderError || branchError || settingsError) {
    console.error('public review invitation verification failed', orderError ?? branchError ?? settingsError);
    return NextResponse.json({ error: 'Review invitation could not be verified.' }, { status: 503 });
  }
  if (!order || !branch) return NextResponse.json({ error: 'Review invitation not found.' }, { status: 404 });
  if (!settings?.review_url) return NextResponse.json({ error: 'The restaurant has not configured its Google review link.' }, { status: 410 });

  const { error: clickError } = await db.from('restaurant_review_invitations')
    .update({ status: 'CLICKED', clicked_at: new Date().toISOString() })
    .eq('id', invite.id)
    .eq('organization_id', invite.organization_id)
    .eq('branch_id', invite.branch_id);
  if (clickError) {
    console.error('public review invitation click could not be recorded', clickError);
    return NextResponse.json({ error: 'Review link could not be recorded.' }, { status: 503 });
  }
  return NextResponse.redirect(settings.review_url, { status: 302 });
}
