import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../lib/server-admin';
import { withRateLimit } from '../../lib/server-security';

export async function POST(request:Request){
 const limited=withRateLimit(request,'disputes',10); if(limited)return limited;
 try{
  const b=await request.json();const orderId=String(b.orderId||''),email=String(b.email||'').trim().toLowerCase(),reason=String(b.reason||'').trim();
  if(!orderId||!email||!reason)return NextResponse.json({ok:false,error:'Order, email and reason are required.'},{status:400});
  const db=getAdminSupabase();const{data:order,error}=await db.from('orders').select('id,buyer_email,creator_id,status,payment_provider').eq('id',orderId).maybeSingle();if(error)throw error;
  if(!order)return NextResponse.json({ok:false,error:'Order not found.'},{status:404});if(order.buyer_email.toLowerCase()!==email)return NextResponse.json({ok:false,error:'Email does not match the order.'},{status:403});
  if(!['paid','partially_refunded'].includes(order.status))return NextResponse.json({ok:false,error:'Only completed purchases can be disputed.'},{status:409});
  const{data:dispute,error:insertError}=await db.from('disputes').insert({order_id:order.id,creator_id:order.creator_id,status:'open',provider:order.payment_provider,reason}).select('id,status').single();if(insertError)throw insertError;
  await db.from('orders').update({status:'disputed',disputed_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('id',order.id);
  return NextResponse.json({ok:true,data:dispute});
 }catch(e){return NextResponse.json({ok:false,error:e instanceof Error?e.message:'Dispute request failed.'},{status:500});}
}
