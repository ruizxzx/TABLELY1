import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getAdminSupabase } from '../server-admin';
import { getAppBaseUrl } from '../site';

const AUTH_BASE = 'https://auth.razorpay.com';
export function oauthConfig() {
  const clientId = process.env.RAZORPAY_OAUTH_CLIENT_ID;
  const clientSecret = process.env.RAZORPAY_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Razorpay OAuth is not configured. Add RAZORPAY_OAUTH_CLIENT_ID and RAZORPAY_OAUTH_CLIENT_SECRET.');
  return {
    clientId,
    clientSecret,
    redirectUri: process.env.RAZORPAY_OAUTH_REDIRECT_URI || `${getAppBaseUrl()}/api/payments/razorpay/callback`,
    mode: process.env.RAZORPAY_OAUTH_MODE === 'live' ? 'live' : 'test',
  } as const;
}
export function hashState(state:string){return createHash('sha256').update(state).digest('hex');}
export function buildAuthorizationUrl(state:string){const c=oauthConfig();const u=new URL(`${AUTH_BASE}/authorize`);u.searchParams.set('response_type','code');u.searchParams.set('client_id',c.clientId);u.searchParams.set('redirect_uri',c.redirectUri);u.searchParams.set('scope','read_write');u.searchParams.set('state',state);return u.toString();}
async function tokenRequest(body:Record<string,string>){const c=oauthConfig();const res=await fetch(`${AUTH_BASE}/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,...body}).toString(),cache:'no-store'});const text=await res.text();let data:any=null;try{data=text?JSON.parse(text):null;}catch{data={message:text};}if(!res.ok)throw new Error(`Razorpay OAuth error: ${data?.error_description||data?.message||res.statusText}`);return data as {access_token:string;public_token:string;refresh_token:string;expires_in?:number;razorpay_account_id:string};}
export async function exchangeCode(code:string){const c=oauthConfig();return tokenRequest({grant_type:'authorization_code',redirect_uri:c.redirectUri,mode:c.mode,code:decodeURIComponent(code)});}
export async function refreshToken(refresh_token:string){return tokenRequest({grant_type:'refresh_token',refresh_token});}
export async function revokeAccessToken(token:string){const c=oauthConfig();const res=await fetch(`${AUTH_BASE}/revoke`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:c.clientId,client_secret:c.clientSecret,token_type_hint:'access_token',token}),cache:'no-store'});if(!res.ok)throw new Error(`Razorpay revoke failed: ${await res.text()}`);}
export function verifyCheckoutSignature(orderId:string,paymentId:string,signature:string){const c=oauthConfig();const digest=createHmac('sha256',c.clientSecret).update(`${orderId}|${paymentId}`).digest('hex');const a=Buffer.from(digest),b=Buffer.from(signature);return a.length===b.length&&timingSafeEqual(a,b);}
export async function getCreatorAuth(paymentAccountId:string){const admin=getAdminSupabase();const{data:secret,error}=await admin.from('payment_account_secrets').select('*').eq('payment_account_id',paymentAccountId).maybeSingle();if(error)throw error;if(!secret)throw new Error('Payment account authorization is missing. Reconnect Razorpay.');let accessToken=String(secret.access_token),publicToken=String(secret.public_token);const expiresAt=secret.access_token_expires_at?Date.parse(secret.access_token_expires_at):0;if(!accessToken||!publicToken||!secret.refresh_token)throw new Error('Payment account authorization is incomplete.');if(expiresAt&&expiresAt<=Date.now()+5*60*1000){const refreshed=await refreshToken(String(secret.refresh_token));const nextExpiry=new Date(Date.now()+Number(refreshed.expires_in||90*86400)*1000).toISOString();const{error:updateError}=await admin.from('payment_account_secrets').update({access_token:refreshed.access_token,public_token:refreshed.public_token,refresh_token:refreshed.refresh_token,access_token_expires_at:nextExpiry,updated_at:new Date().toISOString()}).eq('payment_account_id',paymentAccountId);if(updateError)throw updateError;accessToken=refreshed.access_token;publicToken=refreshed.public_token;}return{accessToken,publicToken};}
