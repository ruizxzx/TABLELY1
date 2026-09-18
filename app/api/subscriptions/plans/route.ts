import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';
export async function GET(){
  const s=await getSupabaseServerClient();
  if(!s)return NextResponse.json({error:'Server configuration is incomplete.'},{status:500});
  const {data,error}=await s.rpc('get_active_plan_catalog_v2');
  if(error)return NextResponse.json({error:error.message},{status:500});
  return NextResponse.json({plans:data??[]});
}
