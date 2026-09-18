import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

type PaymentSettings={organization_id:string;branch_id?:string|null;enabled:boolean;razorpay_key_id:string|null;razorpay_key_secret_encrypted:string|null;razorpay_webhook_secret_encrypted:string|null};
function key(){const raw=process.env.TABLELY_ENCRYPTION_KEY?.trim();if(!raw)return null;try{const b=Buffer.from(raw,'base64');return b.length===32?b:null}catch{return null}}
export function encryptSecret(value:string){const k=key();if(!k)throw new Error('TABLELY_ENCRYPTION_KEY is not configured.');const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',k,iv);const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);const tag=cipher.getAuthTag();return [iv,tag,data].map(x=>x.toString('base64')).join('.')}
export function decryptSecret(value:string|null){if(!value)return null;const k=key();if(!k)return null;try{const [iv,tag,data]=value.split('.').map(x=>Buffer.from(x,'base64'));const decipher=crypto.createDecipheriv('aes-256-gcm',k,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8')}catch{return null}}
export async function getRestaurantPaymentSettings(admin:SupabaseClient,organizationId:string,branchId?:string){
  if(branchId){
    const{data:branch,error:branchError}=await admin.from('restaurant_branch_payment_settings').select('*').eq('organization_id',organizationId).eq('branch_id',branchId).maybeSingle();
    if(branchError)throw branchError;
    if(branch)return branch as PaymentSettings;
  }
  const{data,error}=await admin.from('restaurant_payment_settings').select('*').eq('organization_id',organizationId).maybeSingle();
  if(error)throw error;
  return data as PaymentSettings|null;
}
export function resolveRazorpayCredentials(settings: PaymentSettings | null) {
  const keyId = settings?.razorpay_key_id?.trim() || '';
  const secret = decryptSecret(settings?.razorpay_key_secret_encrypted ?? null) || '';
  const webhook = decryptSecret(settings?.razorpay_webhook_secret_encrypted ?? null) || '';
  return {keyId,secret,webhook,enabled:Boolean(settings?.enabled)&&Boolean(keyId&&secret)};
}
