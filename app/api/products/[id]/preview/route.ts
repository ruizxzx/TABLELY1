import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ ok:false, error:'Product not found.' }, { status:404 });
    const url = new URL(request.url);
    const download = url.searchParams.get('download') === '1' || url.searchParams.get('download') === 'true';
    const admin = getAdminSupabase();
    const { data: product, error } = await admin.from('products').select('id,status,visibility,preview_file_path,store_id,category_id').eq('id',id).maybeSingle();
    if (error) throw error;
    if (!product || product.status !== 'live' || product.visibility !== 'public' || !product.preview_file_path || !product.category_id) {
      return NextResponse.json({ ok:false, error:'Preview is not available.' }, { status:404 });
    }
    const { data: store, error: storeError } = await admin.from('stores').select('id,status').eq('id',product.store_id).maybeSingle();
    if (storeError) throw storeError;
    if (!store || store.status !== 'active') return NextResponse.json({ok:false,error:'Preview is not available.'},{status:404});
    const { data: category } = await admin.from('store_categories').select('id,status,is_visible').eq('id',product.category_id).eq('store_id',product.store_id).maybeSingle();
    if (!category || category.status !== 'live' || !category.is_visible) return NextResponse.json({ok:false,error:'Preview is not available.'},{status:404});
    const { data: signed, error: signedError } = await admin.storage.from('product-files').createSignedUrl(product.preview_file_path, 300, { download });
    if (signedError || !signed?.signedUrl) throw signedError || new Error('Could not create preview URL.');
    return NextResponse.redirect(signed.signedUrl, 303);
  } catch (error) {
    console.error('[product-preview]', error);
    return NextResponse.json({ok:false,error:error instanceof Error?error.message:'Preview failed.'},{status:500});
  }
}
