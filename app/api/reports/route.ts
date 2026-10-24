import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../lib/server-admin';
import { withRateLimit } from '../../lib/server-security';
export async function POST(request:Request){
 const limited=withRateLimit(request,'reports',10); if(limited)return limited;
 try{
  const b=await request.json(); const type=b.type==='creator'?'creator_reports':'product_reports'; const reason=String(b.reason||'').trim();
  if(!reason)return NextResponse.json({ok:false,error:'Reason is required.'},{status:400});
  const db=getAdminSupabase();
  const row:any={reason,details:String(b.details||''),reporter_email:String(b.reporterEmail||'').trim()||null};
  if(type==='product_reports') row.product_id=String(b.productId||''); else row.creator_id=String(b.creatorId||'');
  if(!row[type==='product_reports'?'product_id':'creator_id'])return NextResponse.json({ok:false,error:'Target is required.'},{status:400});
  const {data,error}=await db.from(type).insert(row).select('id,status').single(); if(error)throw error;
  return NextResponse.json({ok:true,data});
 }catch(e){return NextResponse.json({ok:false,error:e instanceof Error?e.message:'Report failed.'},{status:500});}
}
