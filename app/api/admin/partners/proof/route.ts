import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const bucket='tablely-partner-payout-proofs';
const allowed=new Set(['image/jpeg','image/png','image/webp','application/pdf']);

export async function POST(request:Request){
 const supabase=await getSupabaseServerClient();const admin=getSupabaseAdminClient();if(!supabase||!admin)return NextResponse.json({error:'Supabase is not configured.'},{status:503});
 const{data:{user}}=await supabase.auth.getUser();if(!user)return NextResponse.json({error:'Sign in required.'},{status:401});
 const{data:isAdmin}=await supabase.rpc('is_platform_admin');if(isAdmin!==true)return NextResponse.json({error:'Platform admin access required.'},{status:403});
 const form=await request.formData();const payoutId=String(form.get('payoutId')||'');const file=form.get('file');
 if(!/^[0-9a-f-]{36}$/i.test(payoutId)||!(file instanceof File))return NextResponse.json({error:'Payout and proof file are required.'},{status:400});
 if(file.size<1||file.size>8*1024*1024||!allowed.has(file.type))return NextResponse.json({error:'Use a JPG, PNG, WEBP or PDF file up to 8 MB.'},{status:400});
 const{data:payout}=await admin.from('tablely_partner_payouts').select('id,partner_id,status').eq('id',payoutId).eq('status','APPROVED').maybeSingle();if(!payout)return NextResponse.json({error:'Approved payout not found.'},{status:404});
 const ext=file.type==='application/pdf'?'pdf':file.type==='image/png'?'png':file.type==='image/webp'?'webp':'jpg';const path=`${payout.partner_id}/${payout.id}/${randomUUID()}.${ext}`;
 const{error}=await admin.storage.from(bucket).upload(path,file,{contentType:file.type,upsert:false});if(error)return NextResponse.json({error:error.message},{status:400});
 return NextResponse.json({ok:true,storagePath:path});
}
