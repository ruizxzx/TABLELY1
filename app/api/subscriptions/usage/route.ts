import { NextResponse } from 'next/server';
import { requireSubscriptionViewer } from '@/lib/subscription-access';

export async function GET() {
  try {
    const x = await requireSubscriptionViewer();
    if ('error' in x) return x.error;
    const { data, error } = await x.supabase.rpc('get_subscription_usage');
    if (error) return NextResponse.json({ error: 'Could not load subscription usage.' }, { status: 500 });
    return NextResponse.json({ usage: data ?? null });
  } catch (error: unknown) {
    console.error('subscriptions/usage failed', error);
    return NextResponse.json({ error: 'Could not load subscription usage.' }, { status: 500 });
  }
}
