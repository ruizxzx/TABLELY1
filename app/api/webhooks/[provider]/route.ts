import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getRazorpayProvider } from '../../../lib/payments';
import { getCreatorAuth } from '../../../lib/payments/razorpay-auth';
import { toMinorUnits } from '../../../lib/payments/money';
import { markOrderPaid, handlePaymentFailedEmail } from '../../../lib/server-order';
export const dynamic='force-dynamic';

export async function POST(request:Request,{params}:{params:Promise<{provider:string}>}){
 try{
  const{provider:providerName}=await params;
  if(providerName!=='razorpay')return NextResponse.json({ok:false,error:'Unsupported provider.'},{status:404});
  const raw=await request.text();
  const provider=getRazorpayProvider();
  const signature=request.headers.get('x-razorpay-signature');
  const event=provider.parseWebhook(raw,request.headers);
  const admin=getAdminSupabase();

  if(!event.providerOrderId||!event.status){
    // Signature cannot be checked against a creator account without an order mapping.
    // Platform fallback remains available for non-creator/provider legacy events.
    const validFallback=provider.validateWebhook(raw,signature);
    if(!validFallback)return NextResponse.json({ok:false,error:'Invalid webhook signature.'},{status:401});
    return NextResponse.json({ok:true,ignored:true});
  }

  const{data:order,error:orderError}=await admin.from('orders').select('id,creator_id,product_id,gross_amount,currency,payment_provider,payment_provider_order_id,payment_account_id,status').eq('payment_provider',provider.name).eq('payment_provider_order_id',event.providerOrderId).maybeSingle();
  if(orderError)throw orderError;
  if(!order){
    const validFallback=provider.validateWebhook(raw,signature);
    if(!validFallback)return NextResponse.json({ok:false,error:'Invalid webhook signature.'},{status:401});
    return NextResponse.json({ok:true,ignored:true});
  }

  const auth=order.payment_account_id?await getCreatorAuth(order.payment_account_id):undefined;
  const valid=provider.validateWebhook(raw,signature,auth?.webhookSecret);
  if(!valid)return NextResponse.json({ok:false,error:'Invalid webhook signature.'},{status:401});

  const{data:existing}=await admin.from('payment_events').select('id,processed_at').eq('provider',provider.name).eq('provider_event_id',event.providerEventId).maybeSingle();
  if(existing?.processed_at)return NextResponse.json({ok:true,duplicate:true});
  if(!existing){const{error}=await admin.from('payment_events').insert({provider:provider.name,provider_event_id:event.providerEventId,event_type:event.eventType,provider_order_id:event.providerOrderId,provider_payment_id:event.paymentId,signature_verified:true,payload:event.raw});if(error&&String(error.code)==='23505')return NextResponse.json({ok:true,duplicate_in_progress:true});if(error)throw error;}

  if(event.status==='succeeded'&&event.paymentId){
    if(!order.payment_account_id)throw new Error('Order payment account is missing.');
    const creatorAuth=await getCreatorAuth(order.payment_account_id);
    const payment=await provider.getPayment(event.paymentId,creatorAuth);
    const expected=toMinorUnits(Number(order.gross_amount),String(order.currency));
    if(payment.orderId!==order.payment_provider_order_id||payment.amountMinor!==expected||payment.currency.toUpperCase()!==String(order.currency).toUpperCase())throw new Error('Webhook payment does not match the TABLELY order.');
    if(payment.status!=='captured'){
      await admin.from('payment_events').update({processed_at:new Date().toISOString(),error_message:`Provider payment status is ${payment.status}.`}).eq('provider',provider.name).eq('provider_event_id',event.providerEventId);
      return NextResponse.json({ok:true,pending:true});
    }
    await admin.from('payment_transactions').update({status:'succeeded',provider_payment_id:payment.id,payment_fee:Math.max(0,Number(payment.feeMinor||0)),updated_at:new Date().toISOString(),succeeded_at:new Date().toISOString()}).eq('order_id',order.id).eq('provider_order_id',order.payment_provider_order_id);
    await markOrderPaid(order.id,{paymentId:payment.id,paymentFeeMinor:Math.max(0,Number(payment.feeMinor||0)),amountMinor:expected,currency:String(order.currency),provider:provider.name});
  } else {
    const status=event.status;
    const transitionable=['created','pending','processing'].includes(String(order.status));
    if(status==='failed' && transitionable){
      await admin.from('payment_transactions').update({status:'failed',provider_payment_id:event.paymentId,updated_at:new Date().toISOString()}).eq('order_id',order.id).eq('provider_order_id',order.payment_provider_order_id);
      const{error:failureError}=await admin.from('orders').update({status:'failed',payment_status:'failed',updated_at:new Date().toISOString()}).eq('id',order.id).in('status',['created','pending','processing']);
      if(failureError)throw failureError;
      await handlePaymentFailedEmail(order.id);
    }else if(status==='processing' && transitionable){
      await admin.from('payment_transactions').update({status:'processing',provider_payment_id:event.paymentId,updated_at:new Date().toISOString()}).eq('order_id',order.id).eq('provider_order_id',order.payment_provider_order_id);
      const{error:processingError}=await admin.from('orders').update({status:'pending',payment_status:'processing',updated_at:new Date().toISOString()}).eq('id',order.id).in('status',['created','pending','processing']);
      if(processingError)throw processingError;
    }
  }

  await admin.from('payment_events').update({processed_at:new Date().toISOString()}).eq('provider',provider.name).eq('provider_event_id',event.providerEventId);
  return NextResponse.json({ok:true});
 }catch(error){
  console.error('[webhook]',error);
  return NextResponse.json({ok:false,error:error instanceof Error?error.message:'Webhook processing failed.'},{status:500});
 }
}
