import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../lib/server-admin';
import { createHmac } from 'node:crypto';
import { getBearerUser, withRateLimit } from '../../lib/server-security';
import { getCreatorEntitlements, featureDenied } from '../../lib/server-entitlements';

function secret(){return process.env.SELLORA_ACCESS_SECRET||process.env.SUPABASE_SECRET_KEY||'';}
export async function POST(request:Request){
 const limited=withRateLimit(request,'domains',20); if(limited)return limited;
 try{
    const user=await getBearerUser(request); if(!user)return NextResponse.json({ok:false,error:'Unauthorized'},{status:401});
    const entitlements=await getCreatorEntitlements(user.id); if(!entitlements.features.custom_domain)return NextResponse.json(featureDenied(entitlements,'custom_domain','pro'),{status:403});
    const db=getAdminSupabase();
  const b=await request.json(); const domain=String(b.domain||'').trim().toLowerCase().replace(/^https?:\/\//,'').replace(/\/.*$/,'');
  if(!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain))return NextResponse.json({ok:false,error:'Enter a valid domain.'},{status:400});
  const {data:store}=await db.from('stores').select('id').eq('owner_id',user.id).maybeSingle(); if(!store)return NextResponse.json({ok:false,error:'Store not found.'},{status:404});
  const token=createHmac('sha256',secret()).update(`${store.id}:${domain}`).digest('hex').slice(0,32);
  const {data,error}=await db.from('custom_domains').insert({store_id:store.id,domain,status:'pending_dns',verification_token:token}).select('id,domain,status,verification_token').single(); if(error)throw error;
  return NextResponse.json({ok:true,data});
 }catch(e){return NextResponse.json({ok:false,error:e instanceof Error?e.message:'Could not add domain.'},{status:500});}
}
