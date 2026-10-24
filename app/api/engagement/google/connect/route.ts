import { createHmac, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

export async function GET(){
 const clientId=process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(),redirect=process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim(),secret=process.env.GOOGLE_OAUTH_STATE_SECRET?.trim();if(!clientId||!redirect||!secret)return NextResponse.json({error:'Google OAuth is not configured on this server.'},{status:503});
 const supabase=await getSupabaseServerClient();if(!supabase)return NextResponse.json({error:'Authentication unavailable.'},{status:503});const{data,error}=await getCurrentRestaurantContext(supabase);if(error||!data)return NextResponse.json({error:'Sign in as a restaurant owner first.'},{status:401});if(data.staff.role!=='OWNER')return NextResponse.json({error:'Only the restaurant owner can connect Google Business Profile.'},{status:403});
 const payload=Buffer.from(JSON.stringify({org:data.organization.id,user:data.userId,exp:Date.now()+10*60_000,nonce:randomBytes(16).toString('hex')})).toString('base64url'),sig=createHmac('sha256',secret).update(payload).digest('base64url'),state=`${payload}.${sig}`;
 const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.searchParams.set('client_id',clientId);url.searchParams.set('redirect_uri',redirect);url.searchParams.set('response_type','code');url.searchParams.set('scope','https://www.googleapis.com/auth/business.manage');url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');url.searchParams.set('include_granted_scopes','true');url.searchParams.set('state',state);
 return NextResponse.json({url:url.toString()},{headers:{'cache-control':'no-store'}});
}
