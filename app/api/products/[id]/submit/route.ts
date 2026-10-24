import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';
import { withRateLimit } from '../../../../lib/server-security';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = withRateLimit(request, 'product-submit-review', 20);
  if (limited) return limited;

  try {
    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const db = getAdminSupabase();
    const { data: { user }, error: authError } = await db.auth.getUser(authorization.slice(7));
    if (authError || !user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const { data: product, error: productError } = await db
      .from('products')
      .select('id,store_id,title,slug,price,currency,product_type,status,visibility,digital_delivery_type,file_path,file_access_url,category_id')
      .eq('id', id)
      .maybeSingle();
    if (productError) throw productError;
    if (!product) return NextResponse.json({ ok: false, error: 'Product not found.' }, { status: 404 });

    const { data: store, error: storeError } = await db.from('stores').select('id,owner_id,name,username').eq('id', product.store_id).maybeSingle();
    if (storeError) throw storeError;
    if (!store || store.owner_id !== user.id) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });

    const deliveryConfigured = product.digital_delivery_type === 'link'
      ? Boolean(String(product.file_access_url || '').trim())
      : Boolean(String(product.file_path || '').trim());
    if (!deliveryConfigured) return NextResponse.json({ ok: false, error: 'A digital delivery file or link is required before review.' }, { status: 400 });

    const snapshot = {
      title: product.title,
      slug: product.slug,
      product_type: product.product_type,
      price: product.price,
      currency: product.currency,
      category_id: product.category_id,
      submitted_status: product.status,
    };
    const now = new Date().toISOString();
    const { data: review, error: reviewError } = await db.from('product_verification_requests').upsert({
      product_id: product.id,
      creator_id: user.id,
      store_id: store.id,
      status: 'pending',
      product_snapshot: snapshot,
      submitted_at: now,
      reviewed_at: null,
      reviewed_by: null,
      review_note: null,
      updated_at: now,
    }, { onConflict: 'product_id,status' }).select('id,status,submitted_at').single();
    if (reviewError) throw reviewError;

    return NextResponse.json({ ok: true, data: review });
  } catch (error) {
    console.error('[product submit review]', error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Could not submit product for review.' }, { status: 500 });
  }
}
