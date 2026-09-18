import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { createTablelySubscription, fetchTablelySubscription, cancelTablelySubscription, getTablelyBillingConfigStatus } from '@/lib/tablely-billing';
const schema=z.object({planId:z.enum(['STARTER','GROWTH','PRO']),interval:z.enum(['month','year']).default('month')});
export async function POST(request:Request){
  const parsed=schema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:'Invalid subscription request.'},{status:400});
  const s=await getSupabaseServerClient();
  if(!s)return NextResponse.json({error:'Authentication is not configured.'},{status:500});
  const {data:{user},error:userError}=await s.auth.getUser();
  if(userError||!user)return NextResponse.json({error:'Not authenticated.'},{status:401});
  const {data:context,error:contextError}=await s.rpc('begin_subscription_checkout_v2',{p_plan_id:parsed.data.planId,p_billing_interval:parsed.data.interval});
  if(contextError)return NextResponse.json({error:contextError.message},{status:403});
  if(!context?.organization_id||!context?.provider_plan_id)return NextResponse.json({error:'Tablely billing plan is not configured for this plan.'},{status:503});
  const billing=getTablelyBillingConfigStatus();
  if(!billing.configured)return NextResponse.json({error:'Tablely subscription billing is not configured on the server.'},{status:503});
  const admin=getSupabaseAdminClient();
  if(!admin)return NextResponse.json({error:'Server database configuration is incomplete.'},{status:503});
  try{
    const existingProviderId=context.provider_subscription_id as string|null;
    if(existingProviderId){
      const provider=await fetchTablelySubscription(existingProviderId);
      if(provider.status&&!['cancelled','completed','expired'].includes(provider.status.toLowerCase()))return NextResponse.json({error:'An active Tablely subscription already exists.',providerSubscriptionId:existingProviderId},{status:409});
    }
    const created=await createTablelySubscription({providerPlanId:context.provider_plan_id,organizationId:context.organization_id,planId:parsed.data.planId,interval:parsed.data.interval,customerNotify:false});
    const {error:recordError}=await admin.rpc('record_subscription_provider_creation_v2',{p_organization_id:context.organization_id,p_plan_id:parsed.data.planId,p_provider_subscription_id:created.id,p_billing_interval:parsed.data.interval});
    if(recordError){
      try{await cancelTablelySubscription(created.id);}catch{}
      return NextResponse.json({error:recordError.message},{status:500});
    }
    return NextResponse.json({providerSubscriptionId:created.id,status:created.status??'created',keyId:billing.publicKey,interval:parsed.data.interval});
  }catch(error:unknown){return NextResponse.json({error:error instanceof Error?error.message:'Could not create the Tablely subscription.'},{status:502});}
}
