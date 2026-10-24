import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { withRateLimit } from '../../../lib/server-security';
import { assertProductOwner } from '../../../lib/server-product';

export const dynamic = 'force-dynamic';

function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}
async function authUser(request: Request) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const db = getAdminSupabase();
  const { data, error } = await db.auth.getUser(auth.slice(7));
  if (error || !data.user) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  return data.user;
}

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'product-advanced-read', 120);
  if (limited) return limited;
  try {
    const user = await authUser(request);
    const productId = new URL(request.url).searchParams.get('productId') || '';
    if (!productId) return fail('Product ID is required.');
    await assertProductOwner(productId, user.id);
    const db = getAdminSupabase();
    const [{ data: variants, error: ve }, { data: versions, error: verErr }, { data: files, error: fe }] = await Promise.all([
      db.from('product_variants').select('*').eq('product_id', productId).order('created_at', { ascending: false }),
      db.from('product_versions').select('*').eq('product_id', productId).order('created_at', { ascending: false }),
      db.from('product_files').select('*').eq('product_id', productId).order('sort_order', { ascending: true }),
    ]);
    if (ve) throw ve; if (verErr) throw verErr; if (fe) throw fe;
    return NextResponse.json({ ok: true, data: { variants: variants || [], versions: versions || [], files: files || [] } });
  } catch (error: any) {
    return fail(error instanceof Error ? error.message : 'Could not load product extensions.', error?.status || 500);
  }
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'product-advanced-write', 40);
  if (limited) return limited;
  try {
    const user = await authUser(request);
    const body = await request.json();
    const productId = String(body.productId || '');
    if (!productId) return fail('Product ID is required.');
    await assertProductOwner(productId, user.id);
    const db = getAdminSupabase();
    const type = String(body.type || '');

    if (type === 'variant') {
      const name = String(body.name || '').trim();
      const price = Number(body.price);
      if (!name || name.length > 120) return fail('Variant name is required.');
      if (!Number.isFinite(price) || price < 0) return fail('Variant price is invalid.');
      const { data, error } = await db.from('product_variants').upsert({
        product_id: productId, name, sku: String(body.sku || '').trim() || null,
        price: Math.round(price), currency: String(body.currency || 'INR').toUpperCase(),
        file_path: String(body.filePath || '').trim() || null,
        status: ['active','draft','archived'].includes(body.status) ? body.status : 'active',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'product_id,name' }).select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    if (type === 'version') {
      const versionLabel = String(body.versionLabel || '').trim();
      if (!versionLabel || versionLabel.length > 50) return fail('Version label is required.');
      const { data, error } = await db.from('product_versions').upsert({
        product_id: productId, version_label: versionLabel,
        changelog: String(body.changelog || '').trim() || null,
        file_path: String(body.filePath || '').trim() || null,
        preview_file_path: String(body.previewFilePath || '').trim() || null,
      }, { onConflict: 'product_id,version_label' }).select('*').single();
      if (error) throw error;
      return NextResponse.json({ ok: true, data });
    }

    return fail('Unsupported product extension.');
  } catch (error: any) {
    return fail(error instanceof Error ? error.message : 'Could not save product extension.', error?.status || 500);
  }
}

export async function DELETE(request: Request) {
  const limited = withRateLimit(request, 'product-advanced-delete', 40);
  if (limited) return limited;
  try {
    const user = await authUser(request);
    const body = await request.json();
    const productId = String(body.productId || '');
    if (!productId) return fail('Product ID is required.');
    await assertProductOwner(productId, user.id);
    const db = getAdminSupabase();
    const table = body.type === 'version' ? 'product_versions' : 'product_variants';
    const id = String(body.id || '');
    if (!id) return fail('Record ID is required.');
    const { error } = await db.from(table).delete().eq('id', id).eq('product_id', productId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return fail(error instanceof Error ? error.message : 'Could not delete product extension.', error?.status || 500);
  }
}
