import { NextResponse } from 'next/server';
import { getBearerUser, withRateLimit } from '../../../lib/server-security';
import { getCreatorEntitlements } from '../../../lib/server-entitlements';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'entitlements-me', 60);
  if (limited) return limited;
  try {
    const user = await getBearerUser(request);
    if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const entitlements = await getCreatorEntitlements(user.id);
    return NextResponse.json({ ok: true, data: { ...entitlements, limits: { products: entitlements.maxProducts, categories: entitlements.maxCategories } } });
  } catch (error) {
    console.error('[entitlements/me]', error);
    return NextResponse.json({ ok: false, error: 'Could not load entitlements.' }, { status: 500 });
  }
}
