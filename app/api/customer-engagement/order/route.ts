import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const querySchema = z.object({
  orderId: z.string().uuid(),
  trackingToken: z.string().min(20).max(200),
});

export async function GET(request: Request) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Order session could not be verified.' }, { status: 400 });

  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Customer engagement is temporarily unavailable.' }, { status: 503 });

  const { data: order, error } = await db
    .from('orders')
    .select('id,branch_id,status,payment_status')
    .eq('id', parsed.data.orderId)
    .eq('tracking_token', parsed.data.trackingToken)
    .maybeSingle();

  if (error) return NextResponse.json({ error: 'Could not verify this order.' }, { status: 503 });
  if (!order) return NextResponse.json({ error: 'Order session could not be verified.' }, { status: 403 });
  if (order.status !== 'COMPLETED' || order.payment_status !== 'PAID') {
    return NextResponse.json({ feedbackUrl: null, reviewUrl: null });
  }

  const { data: branch, error: branchError } = await db.from('branches')
    .select('organization_id')
    .eq('id', order.branch_id)
    .maybeSingle();
  if (branchError) return NextResponse.json({ error: 'Could not verify this order.' }, { status: 503 });
  if (!branch) return NextResponse.json({ error: 'Order session could not be verified.' }, { status: 404 });

  const [{ data: feedback, error: feedbackError }, { data: review, error: reviewError }] = await Promise.all([
    db.from('restaurant_feedback_invitations')
      .select('id')
      .eq('order_id', order.id)
      .eq('organization_id', branch.organization_id)
      .eq('branch_id', order.branch_id)
      .maybeSingle(),
    db.from('restaurant_review_invitations')
      .select('id')
      .eq('organization_id', branch.organization_id)
      .eq('order_id', order.id)
      .eq('branch_id', order.branch_id)
      .maybeSingle(),
  ]);
  if (feedbackError || reviewError) return NextResponse.json({ error: 'Could not load order follow-up links.' }, { status: 503 });

  return NextResponse.json({
    feedbackUrl: feedback ? `/feedback/${feedback.id}` : null,
    reviewUrl: review ? `/api/public-review-invitations/${review.id}` : null,
  });
}
