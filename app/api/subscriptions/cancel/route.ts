import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { cancelTablelySubscription } from '@/lib/tablely-billing';

export async function POST(){
  const s=await getSupabaseServerClient();
  if(!s)return NextResponse.json({error:'Authentication is not configured.'},{status:500});
  const {data:{user},error:userError}=await s.auth.getUser();
  if(userError||!user)return NextResponse.json({error:'Not authenticated.'},{status:401});
  const {data:current,error:currentError}=await s.rpc('get_current_subscription');
  if(currentError)return NextResponse.json({error:currentError.message},{status:403});
  if(!current?.provider_subscription_id)return NextResponse.json({error:'This subscription is not connected to Tablely billing.'},{status:409});
  try{
    await cancelTablelySubscription(current.provider_subscription_id,true);
    const {data:cancellation,error}=await s.rpc('schedule_subscription_cancellation');
    if(error)return NextResponse.json({error:error.message},{status:500});
    return NextResponse.json({ok:true,subscription:cancellation});
  }catch(error:unknown){return NextResponse.json({error:error instanceof Error?error.message:'Could not cancel the subscription.'},{status:502});}
}
