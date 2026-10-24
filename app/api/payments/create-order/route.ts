import { randomBytes, createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getConfiguredPaymentModel, getRazorpayProvider } from '../../../lib/payments';
import { getCreatorAuth } from '../../../lib/payments/razorpay-auth';
import { toMinorUnits } from '../../../lib/payments/money';
import { getBearerUser, withRateLimit } from '../../../lib/server-security';
import { getCreatorEntitlements } from '../../../lib/server-entitlements';
import { isPublishedNow } from '../../../lib/publication';

export const dynamic='force-dynamic';
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function fail(error:string,status=400){return NextResponse.json({ok:false,error},{status});}

export async function POST(request:Request){
 const limited=withRateLimit(request,'payment-create-order',30);if(limited)return limited;
 try{
  const body=await request.json() as {productId?:unknown;bundleId?:unknown;couponCode?:unknown;buyerEmail?:unknown;analytics?:unknown};
  const productId=typeof body.productId==='string'?body.productId:'';
  const bundleId=typeof body.bundleId==='string'?body.bundleId:'';
  const buyerEmail=typeof body.buyerEmail==='string'?body.buyerEmail.trim().toLowerCase():'';
  const couponCode=typeof body.couponCode==='string'?body.couponCode.trim().toUpperCase():'';
  const analytics=body.analytics&&typeof body.analytics==='object'?body.analytics as Record<string, unknown>:{};
  if((!productId&&!bundleId)||(productId&&bundleId))return fail('Choose one product or bundle.');
  if(!EMAIL_RE.test(buyerEmail)||buyerEmail.length>320)return fail('Enter a valid email address.');

  const model=getConfiguredPaymentModel();
  if(model!=='creator_connected')return fail('TABLELY is configured for creator-connected payments only.',503);

  const admin=getAdminSupabase();
  const authenticatedUser=await getBearerUser(request);
  const customerId=authenticatedUser?.id||null;
  if(authenticatedUser?.email && authenticatedUser.email.toLowerCase()!==buyerEmail) return fail('The checkout email must match your signed-in account email.',400);
  const razorpay=getRazorpayProvider();
  let store:any=null, primaryProduct:any=null, bundle:any=null, items:any[]=[];
  let subtotal=0, title='', currency='INR';

  if(productId){
  const{data:p,error}=await admin.from('products').select('id,store_id,title,price,currency,status,visibility,scheduled_publish_at,category_id,file_path,file_access_url,digital_delivery_type,max_purchases,max_downloads,download_expiry_days').eq('id',productId).maybeSingle();
   if(error)throw error;
  if(!p||p.status!=='live'||p.visibility!=='public'||!p.category_id||!isPublishedNow(p.scheduled_publish_at))return fail('This product is not available for purchase.',404);
   const{data:c,error:ce}=await admin.from('store_categories').select('id,status,is_visible,store_id').eq('id',p.category_id).eq('store_id',p.store_id).maybeSingle();
   if(ce)throw ce;
   if(!c||c.status!=='live'||!c.is_visible)return fail('This product is not available for purchase.',404);
   if(p.digital_delivery_type==='link'&&!p.file_access_url)return fail('This product has no delivery configured.',409);
   if(p.digital_delivery_type!=='link'&&!p.file_path)return fail('This product has no delivery file configured.',409);
   primaryProduct=p;subtotal=Math.max(0,Number(p.price||0));currency=String(p.currency||'INR').toUpperCase();title=p.title;
   const{data:files,error:fileError}=await admin.from('product_files').select('id,filename,file_path,sort_order,created_at').eq('product_id',p.id).order('sort_order',{ascending:true}).order('created_at',{ascending:true});
   if(fileError)throw fileError;
   items=[{product_id:p.id,title:p.title,quantity:1,unit_amount:subtotal,line_amount:subtotal,file_path:p.digital_delivery_type==='link'?null:p.file_path,file_access_url:p.digital_delivery_type==='link'?p.file_access_url:null,max_downloads:p.max_downloads??null,download_expiry_days:p.download_expiry_days??30,delivery_manifest:files||[]}];
  } else {
   const{data:b,error}=await admin.from('bundles').select('id,store_id,title,price,currency,status').eq('id',bundleId).maybeSingle();
   if(error)throw error;
   if(!b||b.status!=='live')return fail('This bundle is not available.',404);
   bundle=b;subtotal=Math.max(0,Number(b.price||0));currency=String(b.currency||'INR').toUpperCase();title=b.title;
   const{data:bi,error:bie}=await admin.from('bundle_items').select('product_id,products(id,title,price,currency,file_path,file_access_url,digital_delivery_type,status,visibility,category_id,store_id,max_downloads,download_expiry_days)').eq('bundle_id',b.id);
   if(bie)throw bie;
   const rows=bi||[];
   if(!rows.length)return fail('This bundle has no products.',409);
   for(const row of rows){
     const p=Array.isArray(row.products)?row.products[0]:row.products;
     // Bundle membership is atomic: every declared item must still be purchasable.
     if(!p||p.store_id!==b.store_id||p.status!=='live'||p.visibility!=='public'||!p.category_id)return fail('This bundle contains a product that is not available.',409);
     const{data:c,error:ce}=await admin.from('store_categories').select('id,status,is_visible,store_id').eq('id',p.category_id).eq('store_id',b.store_id).maybeSingle();
     if(ce)throw ce;
     if(!c||c.status!=='live'||!c.is_visible)return fail('This bundle contains a product that is not available.',409);
     if(String(p.currency||'INR').toUpperCase()!==currency)return fail('This bundle contains products using a different currency.',409);
     if(p.digital_delivery_type==='link'&&!p.file_access_url)return fail('This bundle contains a product with missing delivery configuration.',409);
     if(p.digital_delivery_type!=='link'&&!p.file_path)return fail('This bundle contains a product with missing delivery configuration.',409);
     const{data:files,error:fileError}=await admin.from('product_files').select('id,filename,file_path,sort_order,created_at').eq('product_id',p.id).order('sort_order',{ascending:true}).order('created_at',{ascending:true});
     if(fileError)throw fileError;
     if(!primaryProduct)primaryProduct={...p,store_id:b.store_id};
     items.push({product_id:p.id,title:p.title,quantity:1,unit_amount:Number(p.price||0),line_amount:Number(p.price||0),file_path:p.digital_delivery_type==='link'?null:p.file_path,file_access_url:p.digital_delivery_type==='link'?p.file_access_url:null,max_downloads:p.max_downloads??null,download_expiry_days:p.download_expiry_days??30,delivery_manifest:files||[]});
   }
  }

  const{data:s,error:se}=await admin.from('stores').select('id,owner_id,name,username,status').eq('id',bundle?.store_id||primaryProduct.store_id).maybeSingle();
  if(se)throw se;if(!s||s.status!=='active')return fail('This storefront is unavailable.',404);store=s;

  const{data:account,error:accountError}=await admin.from('payment_accounts').select('id,status,payment_model,provider,provider_account_id,is_current').eq('store_id',store.id).eq('provider','razorpay').eq('payment_model','creator_connected').eq('is_current',true).maybeSingle();
  if(accountError)throw accountError;if(!account||account.status!=='connected')return fail('PAYMENT_ACCOUNT_NOT_CONNECTED',503);

  let discount=0,coupon:any=null;
  if(couponCode){
    const entitlements=await getCreatorEntitlements(store.owner_id);
    if(!entitlements.features.coupons)return fail('Coupons are not available for this creator\'s current plan.',403);
   const{data:c,error:ce}=await admin.from('coupons').select('id,code,discount_type,discount_value,min_order_amount,max_redemptions,redeemed_count,expires_at,status').eq('store_id',store.id).eq('code',couponCode).maybeSingle();
   if(ce)throw ce;
   if(!c||c.status!=='active'||(c.expires_at&&new Date(c.expires_at)<new Date())||(c.max_redemptions!=null&&Number(c.redeemed_count)>=Number(c.max_redemptions)))return fail('This coupon is not available.');
   if(subtotal<Number(c.min_order_amount||0))return fail(`Minimum order amount is ₹${Number(c.min_order_amount).toLocaleString('en-IN')}.`);
   discount=c.discount_type==='percent'?Math.floor(subtotal*Math.min(100,Number(c.discount_value))/100):Math.min(subtotal,Number(c.discount_value));coupon=c;
  }

  const total=Math.max(0,subtotal-discount);if(total<=0)return fail('Free checkout is not supported by this payment flow yet.');
  if(productId&&primaryProduct?.max_purchases!=null){
   const{count,error}=await admin.from('orders').select('id',{count:'exact',head:true}).eq('product_id',primaryProduct.id).in('status',['paid','partially_refunded','refunded']);
   if(error)throw error;if((count||0)>=Number(primaryProduct.max_purchases))return fail('This product has reached its purchase limit.',409);
  }

  const amountMinor=toMinorUnits(total,currency);const now=new Date().toISOString();
  const cancelToken=randomBytes(24).toString('hex');const cancelTokenHash=createHash('sha256').update(cancelToken).digest('hex');
  const stale=new Date(Date.now()-30*60*1000).toISOString();
  const checkoutField=bundle?'bundle_id':'product_id';const checkoutValue=bundle?.id||primaryProduct.id;

  let staleQuery=admin.from('orders').update({status:'cancelled',payment_status:'cancelled',updated_at:now})
    .eq(checkoutField,checkoutValue).eq('buyer_email',buyerEmail).in('status',['created','pending']).lt('created_at',stale);
  staleQuery=bundle ? staleQuery.eq('bundle_id',bundle.id) : staleQuery.is('bundle_id','null');
  const{error:staleError}=await staleQuery;
  if(staleError)throw staleError;

  let query=admin.from('orders').select('id,payment_provider_order_id,gross_amount,currency,status,payment_status,created_at,payment_account_id,bundle_id,customer_id').eq(checkoutField,checkoutValue).eq('buyer_email',buyerEmail).in('status',['created','pending']).order('created_at',{ascending:false}).limit(1);
  query=bundle ? query.eq('bundle_id',bundle.id) : query.is('bundle_id','null');
  let{data:order,error:orderError}=await query.maybeSingle();if(orderError)throw orderError;
  if(order&&(Number(order.gross_amount)!==total||String(order.currency).toUpperCase()!==currency||order.payment_account_id!==account.id)){
   await admin.from('orders').update({status:'cancelled',payment_status:'cancelled',updated_at:now}).eq('id',order.id);order=null;
  }

  const attribution={session_id:typeof analytics.sessionId==='string'?analytics.sessionId.slice(0,120):null,visitor_id:typeof analytics.visitorId==='string'?analytics.visitorId.slice(0,120):null,link_id:typeof analytics.linkId==='string'?analytics.linkId.slice(0,80):null,utm_source:typeof analytics.utmSource==='string'?analytics.utmSource.slice(0,100):null,utm_medium:typeof analytics.utmMedium==='string'?analytics.utmMedium.slice(0,100):null,utm_campaign:typeof analytics.utmCampaign==='string'?analytics.utmCampaign.slice(0,100):null,utm_content:typeof analytics.utmContent==='string'?analytics.utmContent.slice(0,100):null,utm_term:typeof analytics.utmTerm==='string'?analytics.utmTerm.slice(0,100):null,referrer:typeof analytics.referrer==='string'?analytics.referrer.slice(0,500):null};
  if(!order){
  const{data:inserted,error}=await admin.from('orders').insert({store_id:store.id,product_id:primaryProduct.id,creator_id:store.owner_id,buyer_email:buyerEmail,subtotal_amount:subtotal,discount_amount:discount,coupon_id:coupon?.id||null,coupon_code:coupon?.code||null,bundle_id:bundle?.id||null,gross_amount:total,payment_fee:0,platform_fee:0,seller_net:total,currency,payment_provider:razorpay.name,payment_model:'creator_connected',payment_account_id:account.id,payment_status:'initializing',status:'created',delivery_status:'locked',checkout_cancel_token_hash:cancelTokenHash,provider_metadata:{product_title:title,bundle_id:bundle?.id||null,attribution}}).select('id,payment_provider_order_id,gross_amount,currency,status,payment_status,created_at,payment_account_id,bundle_id,customer_id').single();
   if(error){
     if(String(error.code)!=='23505')throw error;
     let retryQuery=admin.from('orders').select('id,payment_provider_order_id,gross_amount,currency,status,payment_status,created_at,payment_account_id,bundle_id,customer_id').eq(checkoutField,checkoutValue).eq('buyer_email',buyerEmail).in('status',['created','pending']).order('created_at',{ascending:false}).limit(1);
     retryQuery=bundle ? retryQuery.eq('bundle_id',bundle.id) : retryQuery.is('bundle_id','null');
     const{data:retry,error:retryError}=await retryQuery.maybeSingle();if(retryError)throw retryError;order=retry;
   }else order=inserted;
  }
  if(!order)throw new Error('Could not create checkout order.');

  const{data:itemRows,error:itemReadError}=await admin.from('order_items').select('id').eq('order_id',order.id).limit(1);if(itemReadError)throw itemReadError;
  if(!itemRows?.length){const{error:ie}=await admin.from('order_items').insert(items.map((i:any)=>({...i,order_id:order!.id})));if(ie&&String(ie.code)!=='23505')throw ie;}

  const auth=await getCreatorAuth(account.id);
  if(order.payment_provider_order_id){
    const{error:cancelHashError}=await admin.from('orders').update({checkout_cancel_token_hash:cancelTokenHash,customer_id:customerId,updated_at:now}).eq('id',order.id);if(cancelHashError)throw cancelHashError;
    return NextResponse.json({ok:true,provider:razorpay.name,keyId:auth.publicToken||auth.apiKeyId,orderId:order.id,providerOrderId:order.payment_provider_order_id,amount:amountMinor,currency,cancelToken});
  }

  const{error:txErr}=await admin.from('payment_transactions').insert({order_id:order.id,payment_account_id:account.id,provider:razorpay.name,provider_order_id:`initializing:${order.id}`,status:'initializing',amount:amountMinor,currency,payment_fee:0,metadata:{product_id:primaryProduct.id,store_id:store.id,creator_id:store.owner_id,bundle_id:bundle?.id||null}});
  if(txErr&&String(txErr.code)!=='23505')throw txErr;

  let providerOrder;
  try{
    providerOrder=await razorpay.createPayment({amountMinor,currency,receipt:`sellora_${order.id.replace(/-/g,'').slice(0,28)}`,notes:{sellora_order_id:order.id,sellora_product_id:primaryProduct.id,sellora_store_id:store.id,sellora_creator_id:store.owner_id,sellora_bundle_id:bundle?.id||''}},auth);
  }catch(e){
    await admin.from('payment_transactions').update({status:'failed',failure_message:e instanceof Error?e.message:'Payment initialization failed.',updated_at:now}).eq('order_id',order.id);
    await admin.from('orders').update({status:'failed',payment_status:'failed',updated_at:now}).eq('id',order.id).in('status',['created','pending']);
    throw e;
  }
  if(providerOrder.amountMinor!==amountMinor||providerOrder.currency.toUpperCase()!==currency)throw new Error('Payment provider returned an unexpected amount or currency.');
  const{error:oe}=await admin.from('orders').update({payment_provider_order_id:providerOrder.providerOrderId,payment_status:'pending',status:'pending',payment_account_id:account.id,updated_at:now,provider_metadata:{product_title:title,bundle_id:bundle?.id||null,coupon_code:coupon?.code||null,attribution}}).eq('id',order.id).in('status',['created','pending']);if(oe)throw oe;
  const{error:te}=await admin.from('payment_transactions').update({provider_order_id:providerOrder.providerOrderId,status:'pending',amount:providerOrder.amountMinor,payment_account_id:account.id,updated_at:now}).eq('order_id',order.id);if(te)throw te;
  const{error:hashError}=await admin.from('orders').update({checkout_cancel_token_hash:cancelTokenHash,customer_id:customerId,updated_at:now}).eq('id',order.id);if(hashError)throw hashError;
  return NextResponse.json({ok:true,provider:providerOrder.provider,keyId:auth.publicToken||auth.apiKeyId,orderId:order.id,providerOrderId:providerOrder.providerOrderId,amount:providerOrder.amountMinor,currency:providerOrder.currency,cancelToken});
 }catch(error){console.error('[create-order]',error);return fail(error instanceof Error?error.message:'Could not initialize payment.',500);}
}
