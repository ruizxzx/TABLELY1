import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { withRateLimit, getBearerUser } from '../../../lib/server-security';
import { assertProductOwner } from '../../../lib/server-product';

export const dynamic = 'force-dynamic';

function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = withRateLimit(request, 'product-delete', 30);
  if (limited) return limited;
  try {
    const user = await getBearerUser(request);
    if (!user) return fail('Unauthorized', 401);
    const { id } = await params;
    if (!id) return fail('Product ID is required.');
    const owned = await assertProductOwner(id, user.id);
    const db = getAdminSupabase();

    const [{ count: orderCount, error: orderError }, { count: itemCount, error: itemError }] = await Promise.all([
      db.from('orders').select('id', { count: 'exact', head: true }).eq('product_id', id),
      db.from('order_items').select('id', { count: 'exact', head: true }).eq('product_id', id),
    ]);
    if (orderError) throw orderError;
    if (itemError) throw itemError;

    if ((orderCount || 0) > 0 || (itemCount || 0) > 0) {
      const { error } = await db.from('products').update({
        status: 'archived',
        plan_archived: false,
        plan_archived_at: null,
        published_at: null,
        updated_at: new Date().toISOString(),
      }).eq('id', id);
      if (error) throw error;
      return NextResponse.json({
        ok: true,
        archived: true,
        message: 'Product archived because it has order history. Historical orders were preserved.'
      });
    }

    const paths = [
      owned.cover_image_path,
      owned.file_path,
      owned.preview_file_path,
    ].filter(Boolean) as string[];

    const { error: deleteError } = await db.from('products').delete().eq('id', id);
    if (deleteError) throw deleteError;

    const warnings: string[] = [];
    const coverPath = owned.cover_image_path ? [owned.cover_image_path] : [];
    const productPaths = [owned.file_path, owned.preview_file_path].filter(Boolean) as string[];
    if (coverPath.length) {
      const { error } = await db.storage.from('store-media').remove(coverPath);
      if (error) warnings.push(`Cover cleanup: ${error.message}`);
    }
    if (productPaths.length) {
      const { error } = await db.storage.from('product-files').remove(productPaths);
      if (error) warnings.push(`File cleanup: ${error.message}`);
    }

    return NextResponse.json({ ok: true, archived: false, deleted: true, warnings });
  } catch (error: any) {
    return fail(error instanceof Error ? error.message : 'Could not remove product.', error?.status || 500);
  }
}
