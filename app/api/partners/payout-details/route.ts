import { NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptPartnerPayoutDetails } from '@/lib/partner-payout-crypto';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const schema=z.object({accountName:z.string().trim().min(2).max(120),upiId:z.string().trim().max(160).optional(),accountNumber:z.string().trim().max(40).optional(),ifsc:z.string().trim().max(20).optional(),pan:z.string().trim().max(20).optional()}).refine(v=>Boolean(v.upiId)||Boolean(v.accountNumber&&v.ifsc),{message:'Provide a UPI ID or bank account number and IFSC.'});

export async function POST(request:Request){
 const parsed=schema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0]?.message??'Check payout details.'},{status:400});
 const supabase=await getSupabaseServerClient();const admin=getSupabaseAdminClient();if(!supabase||!admin)return NextResponse.json({error:'Payout details require configured Supabase server credentials.'},{status:503});
 const{data:{user}}=await supabase.auth.getUser();if(!user)return NextResponse.json({error:'Sign in to save payout details.'},{status:401});
 const{data:partner,error:partnerError}=await admin.from('tablely_partners').select('id').eq('user_id',user.id).maybeSingle();if(partnerError||!partner)return NextResponse.json({error:'Partner account not found.'},{status:404});
 let encrypted:string;try{encrypted=encryptPartnerPayoutDetails(parsed.data)}catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Payout encryption is unavailable.'},{status:503});}
 const{error}=await admin.from('tablely_partners').update({payout_details:{encrypted,has_details:true},payout_details_status:'PENDING',updated_at:new Date().toISOString()}).eq('id',partner.id);
 if(error)return NextResponse.json({error:error.message},{status:400});
 return NextResponse.json({ok:true,status:'PENDING'});
}
