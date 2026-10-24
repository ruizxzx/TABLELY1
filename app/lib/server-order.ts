import { getAdminSupabase } from './server-admin';
import { createOrderAccessToken } from './server-access';
import { sendPaymentFailedEmail, sendPurchaseEmails } from './server-email';
import { recordSaleLedger } from './server-finance';
import { toMinorUnits, fromMinorUnits } from './payments/money';

function asOne(value:any){return Array.isArray(value)?(value[0]||null):value;}

async function buildSnapshotRows(admin:any, order:any){
  if(order.bundle_id){
    const{data:bundleItems,error:bundleError}=await admin.from('bundle_items').select('product_id,products(id,title,price,file_path,file_access_url,digital_delivery_type,max_downloads,download_expiry_days)').eq('bundle_id',order.bundle_id);
    if(bundleError)throw bundleError;
    const rows=[];
    for(const bi of bundleItems||[]){
      const p=asOne(bi.products);if(!p)throw new Error('Purchased bundle product snapshot is unavailable.');
      const{data:files,error:fileError}=await admin.from('product_files').select('id,filename,file_path,sort_order,created_at').eq('product_id',p.id).order('sort_order',{ascending:true}).order('created_at',{ascending:true});
      if(fileError)throw fileError;
      rows.push({product_id:p.id,title:p.title,quantity:1,unit_amount:Number(p.price||0),line_amount:Number(p.price||0),file_path:p.digital_delivery_type==='link'?null:p.file_path,file_access_url:p.digital_delivery_type==='link'?p.file_access_url:null,max_downloads:p.max_downloads??null,download_expiry_days:p.download_expiry_days??30,delivery_manifest:files||[]});
    }
    return rows;
  }
  const{data:product,error}=await admin.from('products').select('id,title,price,file_path,file_access_url,digital_delivery_type,max_downloads,download_expiry_days').eq('id',order.product_id).maybeSingle();
  if(error)throw error;if(!product)throw new Error('Purchased product snapshot is unavailable.');
  const{data:files,error:fileError}=await admin.from('product_files').select('id,filename,file_path,sort_order,created_at').eq('product_id',product.id).order('sort_order',{ascending:true}).order('created_at',{ascending:true});
  if(fileError)throw fileError;
  return [{product_id:product.id,title:product.title,quantity:1,unit_amount:Number(product.price||order.gross_amount),line_amount:Number(order.gross_amount),file_path:product.digital_delivery_type==='link'?null:product.file_path,file_access_url:product.digital_delivery_type==='link'?product.file_access_url:null,max_downloads:product.max_downloads??null,download_expiry_days:product.download_expiry_days??30,delivery_manifest:files||[]}];
}

export async function markOrderPaid(orderId:string,payment:{paymentId:string;paymentFeeMinor:number;amountMinor:number;currency:string;provider:string}){
  const admin=getAdminSupabase();
  const{data:order,error}=await admin.from('orders').select('id,status,gross_amount,currency,store_id,product_id,bundle_id,creator_id,buyer_email,platform_fee,subtotal_amount,discount_amount,coupon_id,invoice_number,payment_provider,download_token_expires_at,provider_metadata').eq('id',orderId).maybeSingle();
  if(error)throw error;if(!order)throw new Error('Order not found.');

  const expectedAmountMinor=toMinorUnits(Number(order.gross_amount),String(order.currency));
  if(payment.amountMinor!==expectedAmountMinor)throw new Error('Verified payment amount does not match the order.');
  if(String(payment.currency).toUpperCase()!==String(order.currency).toUpperCase())throw new Error('Verified payment currency does not match the order.');
  if(payment.provider!==String(order.payment_provider||''))throw new Error('Verified payment provider does not match the order.');

  const paymentFeeMinor=Math.max(0,Number(payment.paymentFeeMinor||0));
  const paymentFeeMajor=fromMinorUnits(paymentFeeMinor,String(order.currency));
  const platformFeeMajor=Math.max(0,Number(order.platform_fee||0));
  const sellerNetMajor=Math.max(0,Number(order.gross_amount)-paymentFeeMajor-platformFeeMajor);
  const now=new Date().toISOString();
  const invoiceNumber=order.invoice_number||`SEL-${now.slice(0,10).replace(/-/g,'')}-${order.id.replace(/-/g,'').slice(0,8).toUpperCase()}`;

  let{data:existingItems,error:existingItemsError}=await admin.from('order_items').select('id,product_id,file_path,file_access_url,max_downloads,download_expiry_days,delivery_manifest').eq('order_id',order.id).order('created_at',{ascending:true});
  if(existingItemsError)throw existingItemsError;
  if(!existingItems?.length){
    const rows=await buildSnapshotRows(admin,order);
    const{error:snapshotError}=await admin.from('order_items').insert(rows.map((r:any)=>({...r,order_id:order.id})));
    if(snapshotError&&String(snapshotError.code)!=='23505')throw snapshotError;
    const{data:retryItems,error:retryError}=await admin.from('order_items').select('id,product_id,file_path,file_access_url,max_downloads,download_expiry_days,delivery_manifest').eq('order_id',order.id).order('created_at',{ascending:true});
    if(retryError)throw retryError;existingItems=retryItems||[];
  }

  // Exactly one caller may transition the order to paid. Duplicate verification/webhook
  // calls still return a valid order URL but cannot duplicate ledger/analytics/coupon effects.
  const{data:claimed,error:claimError}=await admin.from('orders')
    .update({status:'paid',payment_status:'succeeded',payment_id:payment.paymentId,payment_fee:paymentFeeMajor,platform_fee:platformFeeMajor,seller_net:sellerNetMajor,gross_amount_minor:payment.amountMinor,payment_fee_minor:paymentFeeMinor,platform_fee_minor:Math.round(platformFeeMajor*100),seller_net_minor:Math.max(0,payment.amountMinor-paymentFeeMinor-Math.round(platformFeeMajor*100)),delivery_status:'available',invoice_number:invoiceNumber,download_token_expires_at:order.download_token_expires_at||null,paid_at:now,updated_at:now})
    .eq('id',order.id).in('status',['created','pending','processing','failed']).select('id').maybeSingle();
  if(claimError)throw claimError;

  if(!claimed){
    const token=createOrderAccessToken(order.id);
    return{token,orderUrl:`/order/${encodeURIComponent(order.id)}?token=${encodeURIComponent(token)}`,duplicate:true};
  }

  const downloadItems=(existingItems||[]).map((item:any)=>({id:item.id,days:Math.min(3650,Math.max(1,Number(item.download_expiry_days||30)))}));
  const expiryBase=Date.parse(now);
  for(const item of downloadItems){
    const expiry=new Date(expiryBase+item.days*86400000).toISOString();
    const{error:itemUpdateError}=await admin.from('order_items').update({delivery_expires_at:expiry}).eq('id',item.id);if(itemUpdateError)throw itemUpdateError;
  }
  const earliestExpiry=downloadItems.length?downloadItems.reduce((min:any,i:any)=>{
    const dt=new Date(expiryBase+i.days*86400000).toISOString();return dt<min?dt:min;
  },new Date(expiryBase+3650*86400000).toISOString()):new Date(expiryBase+30*86400000).toISOString();
  await admin.from('orders').update({download_token_expires_at:earliestExpiry}).eq('id',order.id);

  await admin.from('payment_transactions').update({status:'succeeded',provider_payment_id:payment.paymentId,payment_fee:paymentFeeMinor,updated_at:now,succeeded_at:now}).eq('order_id',order.id);
  await recordSaleLedger(order.id,order.store_id,order.creator_id,{grossMinor:payment.amountMinor,paymentFeeMinor,platformFeeMinor:Math.round(platformFeeMajor*100),currency:String(order.currency)});

  const{error:feeError}=await admin.from('payment_fees').upsert({order_id:order.id,provider:payment.provider,amount_minor:paymentFeeMinor,tax_minor:0,currency:String(order.currency),provider_reference:payment.paymentId},{onConflict:'order_id,provider'});if(feeError)console.error('[payment-fee]',feeError);
  const{error:platformFeeError}=await admin.from('platform_fees').upsert({order_id:order.id,creator_id:order.creator_id,amount_minor:Math.round(platformFeeMajor*100),currency:String(order.currency),rate_bps:0},{onConflict:'order_id'});if(platformFeeError)console.error('[platform-fee]',platformFeeError);

  const attribution=order.provider_metadata?.attribution&&typeof order.provider_metadata.attribution==='object'?order.provider_metadata.attribution:{};
  const{error:analyticsError}=await admin.from('store_analytics_events').upsert({store_id:order.store_id,product_id:order.product_id,link_id:attribution.link_id||null,event_id:`purchase:${order.id}`,event_type:'purchase',source:attribution.utm_source||'direct',utm_source:attribution.utm_source||null,utm_medium:attribution.utm_medium||null,utm_campaign:attribution.utm_campaign||null,utm_content:attribution.utm_content||null,utm_term:attribution.utm_term||null,referrer:attribution.referrer||null,visitor_id:attribution.visitor_id||null,session_id:attribution.session_id||null,order_id:order.id,checkout_id:order.id},{onConflict:'event_id',ignoreDuplicates:true});if(analyticsError)console.error('[purchase-analytics]',analyticsError);
  if(order.coupon_id){
    try{
      const{error:redemptionError}=await admin.from('coupon_redemptions').insert({coupon_id:order.coupon_id,order_id:order.id,buyer_email:order.buyer_email,discount_amount:Number(order.discount_amount||0)});
      if(redemptionError&&String((redemptionError as any).code)!=='23505')console.error('[coupon-redemption]',redemptionError);
      else if(!redemptionError){const{error:incrementError}=await admin.rpc('increment_coupon_redemption',{coupon_uuid:order.coupon_id});if(incrementError)console.error('[coupon-redemption-increment]',incrementError);}
    }catch(e){console.error('[coupon-redemption]',e);}
  }

  const token=createOrderAccessToken(order.id);
  await sendPurchaseEmails(order.id,token).catch(e=>console.error('[order-email]',e));
  return{token,orderUrl:`/order/${encodeURIComponent(order.id)}?token=${encodeURIComponent(token)}`};
}

export async function handlePaymentFailedEmail(orderId:string){return sendPaymentFailedEmail(orderId).catch(error=>{console.error('[failed-payment-email]',error);return false;});}
