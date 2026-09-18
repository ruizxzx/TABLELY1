import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

export async function requireSubscriptionViewer(){
  const s=await getSupabaseServerClient();
  if(!s)return {error:NextResponse.json({error:'Authentication is not configured.'},{status:500})};
  const{data:{user},error:userError}=await s.auth.getUser();
  if(userError||!user)return {error:NextResponse.json({error:'Not authenticated.'},{status:401})};
  const{data:context,error:contextError}=await getCurrentRestaurantContext(s);
  if(contextError||!context)return {error:NextResponse.json({error:'Restaurant workspace could not be resolved.'},{status:403})};
  if(context.staff.role==='OWNER')return {supabase:s,context};
  const{data:allowed,error}=await s.rpc('current_user_has_permission_for_branch',{p_branch_id:context.branch.id,p_permission:'SUBSCRIPTION_MANAGEMENT'});
  if(error||allowed!==true)return {error:NextResponse.json({error:'Subscription management permission required.'},{status:403})};
  return {supabase:s,context};
}
