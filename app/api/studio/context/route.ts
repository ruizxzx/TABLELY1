import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, withRateLimit } from '../../../lib/server-security';
import { getEffectivePlan } from '../../../lib/entitlements';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'studio-context', 60);
  if (limited) return limited;

  try {
    const user = await getBearerUser(request);
    if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const db = getAdminSupabase();
    const [{ data: store, error: storeError }, { data: creatorPlan, error: planError }] = await Promise.all([
      db.from('stores').select('username,avatar_url,link_hub_config').eq('owner_id', user.id).maybeSingle(),
      db.from('creator_plans').select('plan,access_source,access_starts_at,access_expires_at').eq('creator_id', user.id).maybeSingle(),
    ]);

    if (storeError) throw storeError;
    if (planError) throw planError;

    return NextResponse.json({
      ok: true,
      data: {
        email: user.email || null,
        username: store?.username || null,
        primaryPage: store?.link_hub_config?.primaryPage === 'linkhub' ? 'linkhub' : 'store',
        avatarUrl: store?.avatar_url || null,
        creatorPlan,
        effectivePlan: getEffectivePlan(creatorPlan),
      },
    });
  } catch (error) {
    console.error('[studio/context]', error);
    return NextResponse.json({ ok: false, error: 'Could not load creator workspace context.' }, { status: 500 });
  }
}
