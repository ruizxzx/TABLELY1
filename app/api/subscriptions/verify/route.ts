import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { verifyTablelySubscriptionSignature, fetchTablelySubscription, unixToIso } from '@/lib/tablely-billing';
const schema=z.object({paymentId:z.string().min(4),subscriptionId:z.string().min(4),signature:z.string().min(10)});
export async function POST(request:Request){
  const parsed=schema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:'Invalid payment verification request.'},{status:400});
  const s=await getSupabaseServerClient();
  if(!s)return NextResponse.json({error:'Authentication is not configured.'},{status:500});
  const {data:{user},error:userError}=await s.auth.getUser();
  if(userError||!user)return NextResponse.json({error:'Not authenticated.'},{status:401});
  if(!verifyTablelySubscriptionSignature(parsed.data))return NextResponse.json({error:'Payment verification failed.'},{status:400});
  // The caller must own the subscription they are confirming. confirm_subscription_payment_v2
  // is service-role only and keyed on the provider id alone, so this is the ownership check.
  const {data:current,error:currentError}=await s.rpc('get_current_subscription');
  if(currentError)return NextResponse.json({error:'Could not resolve the current subscription.'},{status:403});
  if(!current?.provider_subscription_id||current.provider_subscription_id!==parsed.data.subscriptionId)return NextResponse.json({error:'This subscription does not belong to your restaurant.'},{status:403});
  const admin=getSupabaseAdminClient();
  if(!admin)return NextResponse.json({error:'Server database configuration is incomplete.'},{status:503});
  try{
    const provider=await fetchTablelySubscription(parsed.data.subscriptionId);
    const normalizedStatus=String(provider.status??'').toLowerCase();
    if(!['authenticated','active'].includes(normalizedStatus))return NextResponse.json({error:'Provider subscription is not in an authorized state yet.'},{status:409});
    const {data:state,error}=await admin.rpc('confirm_subscription_payment_v2',{p_provider_subscription_id:parsed.data.subscriptionId,p_provider_payment_id:parsed.data.paymentId,p_provider_period_start:unixToIso(provider.current_start),p_provider_period_end:unixToIso(provider.current_end)});
    if(error)return NextResponse.json({error:error.message},{status:403});
    return NextResponse.json({ok:true,subscription:{providerStatus:provider.status,currentPeriodEnd:unixToIso(provider.current_end)},state:state??null});
  }catch(error:unknown){return NextResponse.json({error:error instanceof Error?error.message:'Payment verification failed.'},{status:502});}
}
