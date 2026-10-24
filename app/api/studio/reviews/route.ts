import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { withRateLimit } from '../../../lib/server-security';

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'creator-review-history', 60);
  if (limited) return limited;

  try {
    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const db = getAdminSupabase();
    const { data: { user }, error: authError } = await db.auth.getUser(authorization.slice(7));
    if (authError || !user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const { data: requests, error } = await db.from('product_verification_requests')
      .select('id,product_id,store_id,status,product_snapshot,submitted_at,reviewed_at,review_note,updated_at')
      .eq('creator_id', user.id)
      .order('submitted_at', { ascending: false });
    if (error) throw error;

    const rows = requests || [];
    const productIds = rows.map((row: any) => row.product_id).filter(Boolean);
    const storeIds = rows.map((row: any) => row.store_id).filter(Boolean);
    const [{ data: products }, { data: stores }] = await Promise.all([
      productIds.length ? db.from('products').select('id,title,slug,price,currency,product_type,status,visibility,updated_at').in('id', productIds) : Promise.resolve({ data: [] }),
      storeIds.length ? db.from('stores').select('id,name,username').in('id', storeIds) : Promise.resolve({ data: [] }),
    ]);
    const productMap = new Map((products || []).map((product: any) => [product.id, product]));
    const storeMap = new Map((stores || []).map((store: any) => [store.id, store]));

    return NextResponse.json({ ok: true, data: rows.map((row: any) => ({
      ...row,
      product: productMap.get(row.product_id) || row.product_snapshot || null,
      store: storeMap.get(row.store_id) || null,
    })) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Could not load review history.' }, { status: 500 });
  }
}
