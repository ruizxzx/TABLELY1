import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { assertSameOrigin, getBearerUser, withRateLimit } from '../../../lib/server-security';
import { getCreatorEntitlements, featureDenied } from '../../../lib/server-entitlements';

export const dynamic = 'force-dynamic';
const fail = (body: Record<string, unknown>, status = 400) => NextResponse.json(body, { status });

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'marketing-manage', 30);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail({ ok: false, error: 'Unauthorized' }, 401);
    const body = await request.json() as Record<string, any>;
    const action = String(body.action || '');
    const db = getAdminSupabase();
    const { data: store } = await db.from('stores').select('id').eq('owner_id', user.id).maybeSingle();
    if (!store) return fail({ ok: false, error: 'Store not found.' }, 404);
    const entitlements = await getCreatorEntitlements(user.id);
    const feature = action.includes('coupon') ? 'coupons' : action.includes('bundle') ? 'bundles' : action.includes('upsell') ? 'upsells' : null;
    if (!feature || !entitlements.features[feature]) return fail(featureDenied(entitlements, feature || 'coupons', feature === 'coupons' ? 'creator' : 'creator'), 403);

    if (action === 'create_coupon') {
      const code = String(body.code || '').trim().toUpperCase();
      const discount = Number(body.discountValue);
      if (!/^[A-Z0-9_-]{3,40}$/.test(code) || !Number.isInteger(discount) || discount < 1 || discount > 100) return fail({ ok: false, error: 'Enter a valid coupon code and percentage.' });
      const { data, error } = await db.from('coupons').insert({ store_id: store.id, code, discount_type: 'percent', discount_value: discount, status: 'active' }).select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    if (action === 'create_bundle') {
      const title = String(body.title || '').trim();
      const price = Number(body.price);
      if (!title || title.length > 120 || !Number.isFinite(price) || price < 0) return fail({ ok: false, error: 'Bundle title and price are required.' });
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `bundle-${Date.now()}`;
      const { data, error } = await db.from('bundles').insert({ store_id: store.id, title, slug, description: String(body.description || '').trim() || null, price, status: 'draft' }).select('*').single();
      if (error) throw error;
      const productIds = Array.isArray(body.productIds) ? body.productIds.filter((id: unknown): id is string => typeof id === 'string') : [];
      if (productIds.length) {
        const { data: owned } = await db.from('products').select('id').eq('store_id', store.id).in('id', productIds);
        if ((owned || []).length !== productIds.length) return fail({ ok: false, error: 'Every bundle product must belong to your store.' });
        const { error: itemError } = await db.from('bundle_items').insert(productIds.map(productId => ({ bundle_id: data.id, product_id: productId })));
        if (itemError) throw itemError;
      }
      return NextResponse.json({ ok: true, data });
    }

    if (action === 'set_bundle_status') {
      const status = String(body.status || '');
      if (!['draft', 'live', 'archived'].includes(status)) return fail({ ok: false, error: 'Invalid bundle status.' });
      const { data, error } = await db.from('bundles').update({ status, updated_at: new Date().toISOString() }).eq('id', String(body.bundleId || '')).eq('store_id', store.id).select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    if (action === 'create_upsell') {
      const productId = String(body.productId || '');
      const upsellProductId = String(body.upsellProductId || '');
      if (!productId || !upsellProductId || productId === upsellProductId) return fail({ ok: false, error: 'Choose two different products.' });
      const { data: products } = await db.from('products').select('id,status,store_id').eq('store_id', store.id).in('id', [productId, upsellProductId]);
      const ownedProducts = products || [];
      if (ownedProducts.length !== 2 || ownedProducts.some((product: any) => product.status !== 'live')) return fail({ ok: false, error: 'Both upsell products must be live products from your store.' });
      const { data, error } = await db.from('upsells').insert({ store_id: store.id, product_id: productId, upsell_product_id: upsellProductId, headline: String(body.headline || 'Add this to your purchase').slice(0, 160), discount_percent: Math.max(0, Math.min(100, Number(body.discountPercent) || 0)), status: 'active' }).select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    return fail({ ok: false, error: 'Unsupported marketing action.' });
  } catch (error) {
    console.error('[marketing/manage]', error);
    return fail({ ok: false, error: error instanceof Error ? error.message : 'Could not update marketing.' }, 500);
  }
}
