import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';
import { verifyOrderAccessToken } from '../../../../lib/server-access';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const token = url.searchParams.get('token') || '';
    const requestedProductId = url.searchParams.get('productId') || '';
    const requestedFileId = url.searchParams.get('fileId') || '';

    if (!verifyOrderAccessToken(token, id)) return NextResponse.json({ ok:false, error:'Invalid or expired download access.' }, { status:401 });

    const admin = getAdminSupabase();
    const { data: order, error } = await admin.from('orders')
      .select('id,status,delivery_status,download_revoked_at,download_count,product_id')
      .eq('id', id).maybeSingle();
    if (error) throw error;
    if (!order) return NextResponse.json({ok:false,error:'Order not found.'},{status:404});
    if (!['paid','partially_refunded'].includes(order.status) || order.delivery_status !== 'available') return NextResponse.json({ok:false,error:'Download is not available.'},{status:403});
    if (order.download_revoked_at) return NextResponse.json({ok:false,error:'Download access has been revoked.'},{status:403});

    const productId = requestedProductId || order.product_id;
    if (!productId) return NextResponse.json({ok:false,error:'Purchased product not found.'},{status:404});

    const { data: item, error: itemError } = await admin.from('order_items')
      .select('id,product_id,file_path,file_access_url,download_count,max_downloads,delivery_expires_at,delivery_manifest,title')
      .eq('order_id', id).eq('product_id', productId).maybeSingle();
    if (itemError) throw itemError;
    if (!item) return NextResponse.json({ok:false,error:'This product is not part of the order.'},{status:403});
    if (item.delivery_expires_at && new Date(item.delivery_expires_at) < new Date()) return NextResponse.json({ok:false,error:'Download access for this product has expired.'},{status:403});

    let filePath = item.file_path || null;
    const accessUrl = item.file_access_url || null;
    const manifest = Array.isArray(item.delivery_manifest) ? item.delivery_manifest : [];

    if (requestedFileId) {
      const snapFile = manifest.find((f:any)=>String(f?.id||'')===requestedFileId);
      if (!snapFile) return NextResponse.json({ok:false,error:'This file is not part of the purchased delivery snapshot.'},{status:403});
      if (accessUrl) return NextResponse.json({ok:false,error:'External-access orders do not have individual files.'},{status:400});
      filePath = typeof snapFile.file_path === 'string' ? snapFile.file_path : null;
    }

    if (accessUrl) {
      if (!/^https?:\/\//i.test(accessUrl)) return NextResponse.json({ok:false,error:'External delivery link is unavailable.'},{status:404});
      const {data:claimed,error:claimError}=await admin.rpc('sellora_claim_download',{p_order_id:id,p_order_item_id:item.id});
      if(claimError)throw claimError;if(claimed!==true)return NextResponse.json({ok:false,error:'Download limit reached for this product.'},{status:403});
      const response=NextResponse.redirect(accessUrl,303);response.headers.set('Referrer-Policy','no-referrer');
      const{error:countError}=await admin.rpc('sellora_increment_order_download',{p_order_id:id});
      if(countError)console.error('[order-download-order-counter]',countError);
      return response;
    }

    if (!filePath) return NextResponse.json({ok:false,error:'Digital file is unavailable.'},{status:404});
    const { data: signed, error: signedError } = await admin.storage.from('product-files').createSignedUrl(filePath, 300, {download:true});
    if (signedError || !signed?.signedUrl) throw signedError || new Error('Could not create secure download.');

    const {data:claimed,error:claimError}=await admin.rpc('sellora_claim_download',{p_order_id:id,p_order_item_id:item.id});
    if(claimError)throw claimError;if(claimed!==true)return NextResponse.json({ok:false,error:'Download limit reached for this product.'},{status:403});
    const{error:countError}=await admin.rpc('sellora_increment_order_download',{p_order_id:id});
    if(countError)console.error('[order-download-order-counter]',countError);
    return NextResponse.redirect(signed.signedUrl,303);
  } catch(error) {
    console.error('[order-download]', error);
    return NextResponse.json({ok:false,error:error instanceof Error?error.message:'Download failed.'},{status:500});
  }
}
