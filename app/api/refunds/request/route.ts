import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { withRateLimit } from '../../../lib/server-security';

export async function POST(request: Request) {
  const limited=withRateLimit(request,'refund-request',10); if(limited)return limited;
  try{
    const body=await request.json();
    const orderId=String(body.orderId||''), email=String(body.email||'').trim().toLowerCase(), reason=String(body.reason||'').trim();
    if(!orderId||!email||!reason)return NextResponse.json({ok:false,error:'Order, email and reason are required.'},{status:400});
    const db=getAdminSupabase();
    const {data:order,error}=await db.from('orders').select('id,buyer_email,gross_amount,gross_amount_minor,currency,status,creator_id,refund_amount_minor').eq('id',orderId).maybeSingle();
    if(error)throw error;
    if(!order)return NextResponse.json({ok:false,error:'Order not found.'},{status:404});
    if(order.buyer_email.toLowerCase()!==email)return NextResponse.json({ok:false,error:'Email does not match the order.'},{status:403});
    if(!['paid','partially_refunded'].includes(order.status))return NextResponse.json({ok:false,error:'Refunds are only available for paid orders.'},{status:409});
    const remaining=Number(order.gross_amount_minor||Number(order.gross_amount)*100)-Number(order.refund_amount_minor||0);
    if(remaining<=0)return NextResponse.json({ok:false,error:'This order is already fully refunded.'},{status:409});
    const {data:existing}=await db.from('refunds').select('id').eq('order_id',orderId).in('status',['requested','approved','processing']).limit(1);
    if(existing?.length)return NextResponse.json({ok:false,error:'A refund request is already under review.'},{status:409});
    const {data:refund,error:insertError}=await db.from('refunds').insert({order_id:order.id,creator_id:order.creator_id,requested_amount_minor:remaining,approved_amount_minor:0,currency:order.currency,status:'requested',reason,requested_by_email:email}).select('id,status').single();
    if(insertError)throw insertError;
    return NextResponse.json({ok:true,data:refund});
  }catch(error){return NextResponse.json({ok:false,error:error instanceof Error?error.message:'Refund request failed.'},{status:500});}
}
