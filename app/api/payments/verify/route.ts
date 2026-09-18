import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { fetchRazorpayPayment, verifyRazorpayPaymentSignature } from '@/lib/razorpay';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';
const schema=z.object({
  paymentAttemptId:z.string().uuid().optional(),attemptToken:z.string().min(32).max(128).optional(),
  orderId:z.string().uuid().optional(),trackingToken:z.string().min(20).max(128).optional(),
  razorpayPaymentId:z.string().min(5).max(100),razorpayOrderId:z.string().min(5).max(100),razorpaySignature:z.string().length(64)
}).refine(v => Boolean(v.paymentAttemptId&&v.attemptToken)||Boolean(v.orderId&&v.trackingToken),'Invalid payment verification request.');
export async function POST(request:Request){try{
 const p=schema.safeParse(await request.json());if(!p.success)return NextResponse.json({error:'Invalid payment verification request.'},{status:400});
 const admin=getSupabaseAdminClient();if(!admin)return NextResponse.json({error:'Payment verification is not configured.'},{status:503});
 let branchId:string,total:number,expectedRazorpayOrderId:string|null=null;
 if(p.data.paymentAttemptId&&p.data.attemptToken){const{data:attempt,error}=await admin.from('payment_attempts').select('id,branch_id,total,status,payment_expires_at,razorpay_order_id').eq('id',p.data.paymentAttemptId).eq('attempt_token',p.data.attemptToken).maybeSingle();if(error||!attempt)return NextResponse.json({error:'Payment session not found.'},{status:404});if(attempt.status==='SUCCESS')return NextResponse.json({error:'Payment already completed.'},{status:409});if(['FAILED','EXPIRED'].includes(attempt.status))return NextResponse.json({error:'Payment session is no longer valid. Please place a new order.'},{status:409});if(new Date(attempt.payment_expires_at).getTime()<=Date.now()){await admin.rpc('expire_stale_payment_attempts');return NextResponse.json({error:'Payment session expired. Please place a new order.'},{status:409});}branchId=attempt.branch_id;total=Number(attempt.total);expectedRazorpayOrderId=attempt.razorpay_order_id;}
 else {const{data:order,error}=await admin.from('orders').select('id,branch_id,total,payment_status,razorpay_order_id,status,payment_method').eq('id',p.data.orderId).eq('tracking_token',p.data.trackingToken).maybeSingle();if(error||!order)return NextResponse.json({error:'Order not found.'},{status:404});if(order.status==='CANCELLED')return NextResponse.json({error:'Order is cancelled.'},{status:409});branchId=order.branch_id;total=Number(order.total);expectedRazorpayOrderId=order.razorpay_order_id;}
 const{data:branch}=await admin.from('branches').select('organization_id').eq('id',branchId).maybeSingle();if(!branch)return NextResponse.json({error:'Restaurant not found.'},{status:404});
 const keys=resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin,branch.organization_id,branchId));if(!keys.enabled)return NextResponse.json({error:'Online payments are disabled.'},{status:403});
 if(expectedRazorpayOrderId!==p.data.razorpayOrderId)return NextResponse.json({error:'Razorpay order mismatch.'},{status:400});
 if(!verifyRazorpayPaymentSignature(p.data.razorpayOrderId,p.data.razorpayPaymentId,p.data.razorpaySignature,{keyId:keys.keyId,keySecret:keys.secret}))return NextResponse.json({error:'Payment signature verification failed.'},{status:400});
 const payment=await fetchRazorpayPayment(p.data.razorpayPaymentId,{keyId:keys.keyId,keySecret:keys.secret});if(payment.order_id!==p.data.razorpayOrderId)return NextResponse.json({error:'Payment belongs to a different Razorpay order.'},{status:400});if(Number(payment.amount)!==Math.round(total*100))return NextResponse.json({error:'Payment amount mismatch.'},{status:400});
 const status=String(payment.status??'').toUpperCase();
 if(status==='FAILED'){
   if(p.data.paymentAttemptId){const{error:e}=await admin.rpc('mark_payment_attempt_failed',{p_payment_attempt_id:p.data.paymentAttemptId,p_attempt_token:p.data.attemptToken!,p_razorpay_payment_id:p.data.razorpayPaymentId,p_reason:'Online payment failed'});if(e)return NextResponse.json({error:'Could not record payment failure.'},{status:500});}
   else {const{error:e}=await admin.rpc('record_online_payment_failure',{p_order_id:p.data.orderId!,p_tracking_token:p.data.trackingToken!,p_razorpay_order_id:p.data.razorpayOrderId,p_razorpay_payment_id:p.data.razorpayPaymentId,p_reason:'Online payment failed'});if(e)return NextResponse.json({error:'Could not record payment failure.'},{status:500});}
   return NextResponse.json({ok:true,paid:false,status});
 }
 if(status!=='CAPTURED')return NextResponse.json({ok:true,paid:false,status});
 if(p.data.paymentAttemptId){
   const{data:rows,error:e}=await admin.rpc('finalize_payment_attempt_v18',{p_payment_attempt_id:p.data.paymentAttemptId,p_attempt_token:p.data.attemptToken!,p_razorpay_payment_id:p.data.razorpayPaymentId,p_payment_method:payment.method??'ONLINE'});
   if(e){console.error('payments/verify: finalize attempt failed',e);return NextResponse.json({error:e.message.includes('expired')?'Payment session expired. Please place a new order.':'Could not finalize payment.'},{status:e.message.includes('expired')?409:500});}
   const row=Array.isArray(rows)?rows[0]:rows;return NextResponse.json({ok:true,paid:true,status,orderId:row?.order_id,orderNumber:row?.order_number,trackingToken:row?.tracking_token});
 }
 await admin.rpc('record_razorpay_payment_transaction',{p_order_id:p.data.orderId,p_branch_id:branchId,p_provider_order_id:p.data.razorpayOrderId,p_provider_payment_id:p.data.razorpayPaymentId,p_amount:total,p_currency:payment.currency??'INR',p_status:status,p_method:payment.method??null,p_raw_metadata:{source:'checkout-handler',legacy:true}});
 const{error:ue}=await admin.from('orders').update({payment_status:'PAID',payment_method:`PAY_NOW:${payment.method??'ONLINE'}`,razorpay_payment_id:p.data.razorpayPaymentId,paid_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',p.data.orderId!).eq('status','NEW').eq('payment_status','PENDING');if(ue)return NextResponse.json({error:'Could not finalize payment.'},{status:500});
 return NextResponse.json({ok:true,paid:true,status,trackingToken:p.data.trackingToken});
}catch(e:unknown){console.error('payments/verify: unexpected error',e);return NextResponse.json({error:'Could not verify payment.'},{status:500})}}
