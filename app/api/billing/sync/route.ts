import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, assertSameOrigin, withRateLimit } from '../../../lib/server-security';
import { syncSubscriptionFromProvider } from '../../../lib/billing-service';

export const dynamic='force-dynamic';
const fail=(error:string,status=400)=>NextResponse.json({ok:false,error},{status});

export async function POST(request:Request){
 const limited=withRateLimit(request,'billing-sync',15);if(limited)return limited;
 try{
  assertSameOrigin(request); const user=await getBearerUser(request); if(!user)return fail('Please sign in again.',401);
    const db=getAdminSupabase(); const environment = process.env.SELLORA_BILLING_RAZORPAY_MODE === 'live' ? 'live' : 'test'; const {data:sub,error}=await db.from('sellora_subscriptions').select('provider_subscription_id').eq('creator_id',user.id).eq('environment', environment).in('status',['authenticated','active','pending','paused','halted']).order('created_at',{ascending:false}).limit(1).maybeSingle(); if(error)throw error;
  if(!sub?.provider_subscription_id)return fail('No provider subscription is connected.',409);
  const remote=await syncSubscriptionFromProvider(sub.provider_subscription_id);
  return NextResponse.json({ok:true,data:remote});
 }catch(error){console.error('[billing/sync]',error);return fail(error instanceof Error?error.message:'Could not sync subscription.',500);}
}
