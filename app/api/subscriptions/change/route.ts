import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { updateTablelySubscription } from '@/lib/tablely-billing';
const schema=z.object({planId:z.enum(['STARTER','GROWTH','PRO']),interval:z.enum(['month','year']).default('month')});
export async function POST(request:Request){
  const parsed=schema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return NextResponse.json({error:'Invalid plan change request.'},{status:400});
  const s=await getSupabaseServerClient();
  if(!s)return NextResponse.json({error:'Authentication is not configured.'},{status:500});
  const {data:{user},error:userError}=await s.auth.getUser();
  if(userError||!user)return NextResponse.json({error:'Not authenticated.'},{status:401});
  const {data:change,error}=await s.rpc('schedule_subscription_plan_change_v2',{p_plan_id:parsed.data.planId,p_billing_interval:parsed.data.interval});
  if(error)return NextResponse.json({error:error.message},{status:403});
  if(!change?.provider_subscription_id||!change?.provider_plan_id)return NextResponse.json({error:'This subscription cannot be changed through provider billing yet.'},{status:409});
  try{await updateTablelySubscription(change.provider_subscription_id,{planId:change.provider_plan_id,scheduleChangeAt:'now'});return NextResponse.json({ok:true,subscription:change});}
  catch(error:unknown){await s.rpc('clear_pending_subscription_plan_change');return NextResponse.json({error:error instanceof Error?error.message:'Could not schedule the plan change.'},{status:502});}
}
