import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchRazorpayPayment, verifyRazorpayWebhookSignature } from '@/lib/razorpay';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';
export async function POST(request:Request){const raw=await request.text();const admin=getSupabaseAdminClient();if(!admin)return new NextResponse('Server not configured',{status:503});try{
 const body=JSON.parse(raw) as {event?:string;payload?:{payment?:{entity?:{id?:string;order_id?:string;amount?:number;status?:string;method?:string}};order?:{entity?:{id?:string}}}};
 if(!['payment.captured','order.paid','payment.authorized','payment.failed'].includes(body.event??''))return NextResponse.json({ok:true});
 const entity=body.payload?.payment?.entity;const paymentId=entity?.id;const razorpayOrderId=entity?.order_id??body.payload?.order?.entity?.id;if(!paymentId||!razorpayOrderId)return NextResponse.json({ok:true});
 const{data:attempt}=await admin.from('payment_attempts').select('id,attempt_token,branch_id,total,status,payment_expires_at,razorpay_order_id').eq('razorpay_order_id',razorpayOrderId).maybeSingle();
 if(attempt){
   const{data:branch}=await admin.from('branches').select('organization_id').eq('id',attempt.branch_id).maybeSingle();if(!branch)return NextResponse.json({ok:true});
   const keys=resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin,branch.organization_id,attempt.branch_id));
   if(!keys.enabled||!verifyRazorpayWebhookSignature(raw,request.headers.get('x-razorpay-signature')??'',{keyId:keys.keyId,keySecret:keys.secret,webhookSecret:keys.webhook}))return new NextResponse('Invalid signature',{status:400});
   const payment=entity?.amount?entity:await fetchRazorpayPayment(paymentId,{keyId:keys.keyId,keySecret:keys.secret});const amount=Number(payment.amount??0)/100;if(Math.abs(amount-Number(attempt.total))>0.005)return new NextResponse('Amount mismatch',{status:400});
   const status=String(payment.status??'').toUpperCase();
   if(status==='FAILED'){const{error}=await admin.rpc('mark_payment_attempt_failed',{p_payment_attempt_id:attempt.id,p_attempt_token:attempt.attempt_token,p_razorpay_payment_id:paymentId,p_reason:'Online payment failed'});if(error)return NextResponse.json({error:'Webhook processing failed.'},{status:500});return NextResponse.json({ok:true});}
   if(status==='CAPTURED'||body.event==='order.paid'){
     const{error}=await admin.rpc('finalize_payment_attempt_v18',{p_payment_attempt_id:attempt.id,p_attempt_token:attempt.attempt_token,p_razorpay_payment_id:paymentId,p_payment_method:payment.method??'ONLINE'});if(error){console.error('payments/webhook: finalize attempt failed',error);return NextResponse.json({error:'Webhook processing failed.'},{status:500});}
   }
   return NextResponse.json({ok:true});
 }
 const{data:order}=await admin.from('orders').select('id,branch_id,total,payment_status,razorpay_order_id').eq('razorpay_order_id',razorpayOrderId).maybeSingle();if(!order)return NextResponse.json({ok:true});
 const{data:branch}=await admin.from('branches').select('organization_id').eq('id',order.branch_id).maybeSingle();if(!branch)return NextResponse.json({ok:true});
 const keys=resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin,branch.organization_id,order.branch_id));if(!keys.enabled||!verifyRazorpayWebhookSignature(raw,request.headers.get('x-razorpay-signature')??'',{keyId:keys.keyId,keySecret:keys.secret,webhookSecret:keys.webhook}))return new NextResponse('Invalid signature',{status:400});
 const payment=entity?.amount?entity:await fetchRazorpayPayment(paymentId,{keyId:keys.keyId,keySecret:keys.secret});const amount=Number(payment.amount??0)/100;if(Math.abs(amount-Number(order.total))>0.005)return new NextResponse('Amount mismatch',{status:400});const status=String(payment.status??'').toUpperCase();
 await admin.rpc('record_razorpay_payment_transaction',{p_order_id:order.id,p_branch_id:order.branch_id,p_provider_order_id:razorpayOrderId,p_provider_payment_id:paymentId,p_amount:Number(order.total),p_currency:'INR',p_status:status,p_method:payment.method??null,p_raw_metadata:body});
 if(status==='CAPTURED'||body.event==='order.paid')await admin.from('orders').update({payment_status:'PAID',razorpay_payment_id:paymentId,payment_method:`PAY_NOW:${payment.method??'ONLINE'}`,paid_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',order.id).eq('status','NEW').eq('payment_status','PENDING');
 else if(status==='FAILED'){const{error:fe}=await admin.rpc('record_online_payment_failure_by_provider',{p_razorpay_order_id:razorpayOrderId,p_razorpay_payment_id:paymentId,p_reason:'Online payment failed',p_metadata:body});if(fe)return NextResponse.json({error:'Webhook processing failed.'},{status:500});}
 return NextResponse.json({ok:true});
}catch(e:unknown){console.error('payments/webhook: unexpected error',e);return NextResponse.json({error:'Webhook processing failed.'},{status:500})}}
