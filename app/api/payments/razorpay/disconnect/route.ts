import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';
import { assertSameOrigin, getBearerUser, withRateLimit } from '../../../../lib/server-security';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'razorpay-disconnect', 10);
  if (limited) return limited;

  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const admin = getAdminSupabase();
    const { data: account, error: accountError } = await admin
      .from('payment_accounts')
      .select('id')
      .eq('creator_id', user.id)
      .eq('provider', 'razorpay')
      .eq('is_current', true)
      .maybeSingle();
    if (accountError) throw accountError;
    if (!account) return NextResponse.json({ ok: true });

    // Preserve credential material: historical orders may still require provider access for refunds/reconciliation.
    const { error } = await admin
      .from('payment_accounts')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('id', account.id)
      .eq('creator_id', user.id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[razorpay-disconnect]', error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Could not disconnect Razorpay.' }, { status: 500 });
  }
}
