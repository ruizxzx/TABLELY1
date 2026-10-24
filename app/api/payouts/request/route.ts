import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getCreatorBalance } from '../../../lib/server-finance';
import { withRateLimit } from '../../../lib/server-security';

export async function POST(request:Request){
  const limited=withRateLimit(request,'creator-payout-request',10);if(limited)return limited;
  try{
    const auth=request.headers.get('authorization')||'';
    if(!auth.startsWith('Bearer '))return NextResponse.json({ok:false,error:'Unauthorized'},{status:401});
    const db=getAdminSupabase();
    const {data:{user},error}=await db.auth.getUser(auth.slice(7));
    if(error||!user)return NextResponse.json({ok:false,error:'Unauthorized'},{status:401});
    const body=await request.json();const amount=Number(body.amount);
    if(!Number.isFinite(amount)||amount<=0)return NextResponse.json({ok:false,error:'Enter a valid payout amount.'},{status:400});
    const balance=await getCreatorBalance(user.id);
    const {data:rules}=await db.from('platform_settings').select('minimum_payout_minor,payout_hold_days').eq('id',1).maybeSingle();
    const amountMinor=Math.round(amount*100);
    const minimum=Math.max(0,Number(rules?.minimum_payout_minor||0));
    if(amountMinor<minimum)return NextResponse.json({ok:false,error:`Minimum payout is ₹${Math.round(minimum/100).toLocaleString('en-IN')}.`},{status:409});
    if(amountMinor>balance.available)return NextResponse.json({ok:false,error:'Payout exceeds your available balance.'},{status:409});
    const {data:existing}=await db.from('payouts').select('id').eq('creator_id',user.id).in('status',['pending','processing','held']).limit(1);
    if(existing?.length)return NextResponse.json({ok:false,error:'You already have a payout being processed or held.'},{status:409});
    const {data:payout,error:pe}=await db.from('payouts').insert({
      creator_id:user.id,amount_minor:amountMinor,currency:balance.currency,status:'pending',
      method:'provider_pending_setup',provider:null,metadata:{requested_by:'creator',hold_days:Number(rules?.payout_hold_days||0)}
    }).select('*').single();
    if(pe)throw pe;
    return NextResponse.json({ok:true,data:payout});
  }catch(e){return NextResponse.json({ok:false,error:e instanceof Error?e.message:'Could not request payout.'},{status:500});}
}
