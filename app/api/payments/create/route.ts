import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { createRazorpayOrder } from '@/lib/razorpay';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';

const schema=z.object({
  paymentAttemptId:z.string().uuid().optional(),
  attemptToken:z.string().min(32).max(128).optional(),
  orderId:z.string().uuid().optional(),
  trackingToken:z.string().min(20).max(128).optional(),
}).refine(v => Boolean(v.paymentAttemptId && v.attemptToken) || Boolean(v.orderId && v.trackingToken), 'Invalid payment request.');

export async function POST(request:Request){
  try{
    const parsed=schema.safeParse(await request.json());
    if(!parsed.success)return NextResponse.json({error:'Invalid payment request.'},{status:400});
    const admin=getSupabaseAdminClient();
    if(!admin)return NextResponse.json({error:'Server payment configuration is incomplete.'},{status:503});
    const ip=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||request.headers.get('x-real-ip')||'unknown';
    const{data:allowed,error:rl}=await admin.rpc('allow_rate_limit',{p_key:`payment:${ip}`,p_window_seconds:60,p_max_requests:30});
    if(rl||allowed===false)return NextResponse.json({error:'Too many payment attempts. Please wait a moment.'},{status:429});

    let branchId:string, total:number, razorpayOrderId:string|null=null;
    let paymentAttemptId:string|null=null;
    if(parsed.data.paymentAttemptId&&parsed.data.attemptToken){
      paymentAttemptId=parsed.data.paymentAttemptId;
      const{data:attempt,error}=await admin.from('payment_attempts').select('id,attempt_token,branch_id,total,status,payment_expires_at,razorpay_order_id').eq('id',paymentAttemptId).eq('attempt_token',parsed.data.attemptToken).maybeSingle();
      if(error||!attempt)return NextResponse.json({error:'Payment session not found.'},{status:404});
      if(attempt.status==='SUCCESS')return NextResponse.json({error:'Payment session has already been completed.'},{status:409});
      if(['FAILED','EXPIRED'].includes(attempt.status)) return NextResponse.json({error:'Payment session has expired or failed. Please place a new order.'},{status:409});
      if(new Date(attempt.payment_expires_at).getTime()<=Date.now()){
        await admin.rpc('expire_stale_payment_attempts');
        return NextResponse.json({error:'Payment session has expired. Please place a new order.'},{status:409});
      }
      branchId=attempt.branch_id; total=Number(attempt.total); razorpayOrderId=attempt.razorpay_order_id;
    } else {
      const{orderId,trackingToken}=parsed.data as {orderId:string;trackingToken:string};
      const{data:order,error}=await admin.from('orders').select('id,branch_id,total,payment_status,payment_method,razorpay_order_id,status,order_number,tracking_token').eq('id',orderId).eq('tracking_token',trackingToken).maybeSingle();
      if(error||!order)return NextResponse.json({error:'Order not found.'},{status:404});
      if(order.status==='CANCELLED')return NextResponse.json({error:'Order is cancelled.'},{status:409});
      if(order.payment_status==='PAID')return NextResponse.json({error:'Order is already paid.'},{status:409});
      if(!(order.payment_method==='PAY_NOW'||order.payment_method?.startsWith('PAY_NOW:')))return NextResponse.json({error:'This order is not an online-payment order.'},{status:400});
      branchId=order.branch_id; total=Number(order.total); razorpayOrderId=order.razorpay_order_id;
    }

    const{data:branch}=await admin.from('branches').select('organization_id').eq('id',branchId).maybeSingle();
    if(!branch)return NextResponse.json({error:'Restaurant not found.'},{status:404});
    const{data:featureAllowed,error:featureError}=await admin.rpc('organization_has_feature',{p_organization_id:branch.organization_id,p_feature:'ONLINE_PAYMENTS'});
    if(featureError||!featureAllowed)return NextResponse.json({error:featureError?'Could not create payment order.':'Online payments are not available on the current Tablely plan.'},{status:featureError?500:403});
    const keys=resolveRazorpayCredentials(await getRestaurantPaymentSettings(admin,branch.organization_id,branchId));
    if(!keys.enabled)return NextResponse.json({error:'Online payments are not enabled for this restaurant.'},{status:403});
    if(total<=0)return NextResponse.json({error:'Order total must be greater than zero.'},{status:400});

    if(razorpayOrderId){
      return NextResponse.json({razorpayOrderId,amount:Math.round(total*100),currency:'INR',keyId:keys.keyId});
    }

    const rzp=await createRazorpayOrder({amountInPaise:Math.round(total*100),receipt:`tablely-pay-${paymentAttemptId??'legacy'}`,notes:paymentAttemptId?{tablely_payment_attempt_id:paymentAttemptId}:{tablely_legacy_payment:'true'}},{keyId:keys.keyId,keySecret:keys.secret});
    if(paymentAttemptId){
      const{data:set,error:setErr}=await admin.rpc('set_payment_attempt_razorpay_order',{p_payment_attempt_id:paymentAttemptId,p_attempt_token:parsed.data.attemptToken,p_razorpay_order_id:rzp.id});
      if(setErr||set!==true)return NextResponse.json({error:'Payment session expired. Please place a new order.'},{status:409});
    }else{
      const{error:updateError}=await admin.from('orders').update({razorpay_order_id:rzp.id}).eq('id',parsed.data.orderId).eq('status','NEW').eq('payment_status','PENDING');
      if(updateError)return NextResponse.json({error:'Could not create payment order.'},{status:500});
    }
    return NextResponse.json({razorpayOrderId:rzp.id,amount:rzp.amount,currency:rzp.currency,keyId:keys.keyId});
  }catch(e:unknown){console.error('payments/create: unexpected error',e);return NextResponse.json({error:'Could not create payment order.'},{status:500})}
}
