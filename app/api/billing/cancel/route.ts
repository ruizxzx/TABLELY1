import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit, writeAudit } from '../../../lib/server-security';
import { cancelBillingSubscription } from '../../../lib/billing';
import { persistProviderSubscription } from '../../../lib/billing-service';

export const dynamic = 'force-dynamic';
const fail=(error:string,status=400)=>NextResponse.json({ok:false,error},{status});

export async function POST(request:Request){
 const limited=withRateLimit(request,'billing-cancel',10);if(limited)return limited;
 try{
  assertSameOrigin(request); const user=await getBearerUser(request); if(!user)return fail('Please sign in again.',401);
  const db=getAdminSupabase(); const environment = process.env.SELLORA_BILLING_RAZORPAY_MODE === 'live' ? 'live' : 'test'; const {data:sub,error}=await db.from('sellora_subscriptions').select('*').eq('creator_id',user.id).eq('environment', environment).in('status',['authenticated','active','pending','paused','halted']).order('created_at',{ascending:false}).limit(1).maybeSingle(); if(error)throw error;
  if(!sub)return fail('No active TABLELY subscription was found.',409);
  const remote=await cancelBillingSubscription(sub.provider_subscription_id,true);
  await persistProviderSubscription(sub.id,remote);
  const { error: patchError } = await db.from('sellora_subscriptions').update({
    pending_plan_key:'free',
    pending_plan_version_id:null,
    pending_change_at:'cycle_end',
    cancel_at_period_end:true,
    cancelled_at:null,
    updated_at:new Date().toISOString(),
  }).eq('id',sub.id);
  if (patchError) throw patchError;
  await writeAudit({actorUserId:user.id,action:'subscription.cancel_scheduled',entityType:'subscription',entityId:sub.id,before:{status:sub.status,planKey:sub.plan_key},after:{cancelAtPeriodEnd:true,pendingPlanKey:'free'}});
  return NextResponse.json({ok:true,data:{...remote,cancelAtPeriodEnd:true}});
 }catch(error){console.error('[billing/cancel]',error);return fail(error instanceof Error?error.message:'Could not cancel subscription.',500);}
}
