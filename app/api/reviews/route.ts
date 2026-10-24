import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit } from '../../lib/server-security';

const fail = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'reviews-write', 20);
  if (limited) return limited;
  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Please sign in again.', 401);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || 'submit');
    const db = getAdminSupabase();
    if (action === 'moderate') {
      const reviewId = String(body.reviewId || '');
      const status = String(body.status || '');
      if (!reviewId || !['approved', 'rejected', 'pending'].includes(status)) return fail('Invalid moderation request.');
      const { data: review } = await db.from('product_reviews').select('id,store_id').eq('id', reviewId).maybeSingle();
      if (!review) return fail('Review not found.', 404);
      const { data: store } = await db.from('stores').select('id').eq('id', review.store_id).eq('owner_id', user.id).maybeSingle();
      if (!store) return fail('You cannot moderate this review.', 403);
      const { error } = await db.from('product_reviews').update({ status, moderated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', reviewId).eq('store_id', store.id);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }
    const productId = String(body.productId || '');
    const rating = Number(body.rating);
    const reviewText = String(body.review || '').trim();
    if (!productId || !Number.isInteger(rating) || rating < 1 || rating > 5 || reviewText.length < 10 || reviewText.length > 2000) return fail('Add a rating and a review of 10 to 2,000 characters.');
    const { data: product } = await db.from('products').select('id,store_id,title').eq('id', productId).maybeSingle();
    if (!product) return fail('Product not found.', 404);
    const { data: paidOrder } = await db.from('orders').select('id').eq('product_id', productId).eq('status', 'paid').eq('buyer_email', String(user.email || '').toLowerCase()).limit(1).maybeSingle();
    if (!paidOrder) return fail('Only verified buyers can review this product.', 403);
    const { data, error } = await db.from('product_reviews').upsert({ product_id: product.id, store_id: product.store_id, customer_id: user.id, customer_email: String(user.email || '').toLowerCase(), rating, review: reviewText, status: 'pending', updated_at: new Date().toISOString() }, { onConflict: 'product_id,customer_email' }).select('id,status').single();
    if (error) throw error;
    return NextResponse.json({ ok: true, data, message: 'Review submitted for creator moderation.' });
  } catch (error) {
    console.error('[reviews]', error);
    return fail(error instanceof Error ? error.message : 'Could not update review.', 500);
  }
}
