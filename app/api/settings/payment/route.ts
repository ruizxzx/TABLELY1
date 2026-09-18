import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptSecret } from '@/lib/restaurant-payment';

const schema = z.object({
  scope: z.enum(['branch','organization']).default('branch'),
  branchId: z.string().uuid().optional(),
  enabled: z.boolean(),
  payAtCounterEnabled: z.boolean().default(true),
  payLaterEnabled: z.boolean().default(false),
  razorpayKeyId: z.string().trim().max(120).optional().default(''),
  razorpayKeySecret: z.string().max(300).optional().default(''),
  razorpayWebhookSecret: z.string().max(300).optional().default(''),
});

async function resolveContext(){
  const supabase=await getSupabaseServerClient(); const admin=getSupabaseAdminClient();
  if(!supabase||!admin)return {error:NextResponse.json({error:'Server not configured.'},{status:503})};
  const{data:context,error}=await getCurrentRestaurantContext(supabase);
  if(error||!context)return {error:NextResponse.json({error:error?.message==='Not authenticated'?'Not authenticated.':'Restaurant workspace could not be resolved.'},{status:error?.message==='Not authenticated'?401:403})};
  return {supabase,admin,context};
}

type ContextBundle={supabase:SupabaseClient;admin:SupabaseClient;context:CurrentRestaurantContext};
async function authorizeBranch(x:ContextBundle,branchId:string,permission:'PAYMENTS') {
  if('error' in x)return x;
  const{context}=x;
  const branch=context.branches.find(b=>b.id===branchId);
  if(!branch)return {error:NextResponse.json({error:'Branch access denied.'},{status:403})};
  if(context.staff.role==='OWNER')return x;
  const{data:allowed,error}=await x.supabase.rpc('current_user_has_permission_for_branch',{p_branch_id:branchId,p_permission:permission});
  if(error||allowed!==true)return {error:NextResponse.json({error:'Payment management permission required.'},{status:403})};
  return x;
}

async function featureAllowed(supabase:NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,organizationId:string){
  const{data,error}=await supabase.rpc('organization_has_feature',{p_organization_id:organizationId,p_feature:'ONLINE_PAYMENTS'});
  if(error)throw error;
  return data===true;
}

function branchFromRequest(x:ContextBundle,requested?:string){
  const context=x.context;
  if(context.staff.role!=='OWNER')return context.branch.id;
  return requested||context.branch.id;
}

export async function GET(request:Request){
  const x=await resolveContext(); if('error' in x)return x.error;
  const url=new URL(request.url); const scope=(url.searchParams.get('scope')||'branch') as 'branch'|'organization'; const requestedBranch=url.searchParams.get('branchId')||undefined;
  try{
    if(!(await featureAllowed(x.supabase,x.context.organization.id)))return NextResponse.json({error:'Online payments are not available on the current Tablely plan.'},{status:403});
    if(scope==='organization'){
      if(x.context.staff.role!=='OWNER')return NextResponse.json({error:'Owner access required for organization defaults.'},{status:403});
      const{data,error}=await x.admin.from('restaurant_payment_settings').select('organization_id,enabled,pay_at_counter_enabled,pay_later_enabled,razorpay_key_id').eq('organization_id',x.context.organization.id).maybeSingle();
      if(error)throw error;
      return NextResponse.json({enabled:Boolean(data?.enabled),payAtCounterEnabled:data?.pay_at_counter_enabled!==false,payLaterEnabled:Boolean(data?.pay_later_enabled),razorpayKeyId:data?.razorpay_key_id??'',inheritedFromOrganization:false,scope:'organization'});
    }
    const branchId=branchFromRequest(x,requestedBranch); const auth=await authorizeBranch(x,branchId,'PAYMENTS'); if('error' in auth)return auth.error;
    const{data:branchSettings,error:branchError}=await x.admin.from('restaurant_branch_payment_settings').select('branch_id,organization_id,enabled,pay_at_counter_enabled,pay_later_enabled,razorpay_key_id').eq('organization_id',x.context.organization.id).eq('branch_id',branchId).maybeSingle();
    if(branchError)throw branchError;
    if(branchSettings)return NextResponse.json({enabled:Boolean(branchSettings.enabled),payAtCounterEnabled:branchSettings.pay_at_counter_enabled!==false,payLaterEnabled:Boolean(branchSettings.pay_later_enabled),razorpayKeyId:branchSettings.razorpay_key_id??'',inheritedFromOrganization:false,scope:'branch',branchId});
    const{data:orgSettings,error:orgError}=await x.admin.from('restaurant_payment_settings').select('enabled,pay_at_counter_enabled,pay_later_enabled,razorpay_key_id').eq('organization_id',x.context.organization.id).maybeSingle();
    if(orgError)throw orgError;
    return NextResponse.json({enabled:Boolean(orgSettings?.enabled),payAtCounterEnabled:orgSettings?.pay_at_counter_enabled!==false,payLaterEnabled:Boolean(orgSettings?.pay_later_enabled),razorpayKeyId:orgSettings?.razorpay_key_id??'',inheritedFromOrganization:true,scope:'branch',branchId});
  }catch(error:unknown){console.error('settings/payment GET failed',error);return NextResponse.json({error:'Could not load payment settings.'},{status:500})}
}

export async function POST(request:Request){
  const parsed=schema.safeParse(await request.json().catch(()=>({})));if(!parsed.success)return NextResponse.json({error:'Invalid payment settings.'},{status:400});
  const x=await resolveContext();if('error' in x)return x.error;
  try{
    if(!(await featureAllowed(x.supabase,x.context.organization.id)))return NextResponse.json({error:'Online payments are not available on the current Tablely plan.'},{status:403});
    const body=parsed.data;
    if(body.scope==='organization'){
      if(x.context.staff.role!=='OWNER')return NextResponse.json({error:'Owner access required for organization defaults.'},{status:403});
      let secretEnc:string|undefined;let webhookEnc:string|undefined;
      if(body.razorpayKeySecret.trim())secretEnc=encryptSecret(body.razorpayKeySecret.trim());
      if(body.razorpayWebhookSecret.trim())webhookEnc=encryptSecret(body.razorpayWebhookSecret.trim());
      const payload:{organization_id:string;enabled:boolean;pay_at_counter_enabled:boolean;pay_later_enabled:boolean;razorpay_key_id:string|null;razorpay_key_secret_encrypted?:string;razorpay_webhook_secret_encrypted?:string}={organization_id:x.context.organization.id,enabled:body.enabled,pay_at_counter_enabled:body.payAtCounterEnabled,pay_later_enabled:body.payLaterEnabled,razorpay_key_id:body.razorpayKeyId.trim()||null};
      if(secretEnc)payload.razorpay_key_secret_encrypted=secretEnc;if(webhookEnc)payload.razorpay_webhook_secret_encrypted=webhookEnc;
      const{error}=await x.admin.from('restaurant_payment_settings').upsert(payload,{onConflict:'organization_id'});if(error)throw error;
      return NextResponse.json({ok:true,scope:'organization'});
    }
    const branchId=branchFromRequest(x,body.branchId);const auth=await authorizeBranch(x,branchId,'PAYMENTS');if('error' in auth)return auth.error;
    const{data:branch,error:branchError}=await x.admin.from('branches').select('id,organization_id').eq('id',branchId).eq('organization_id',x.context.organization.id).maybeSingle();if(branchError)throw branchError;if(!branch)return NextResponse.json({error:'Branch not found.'},{status:404});
    const{data:existing,error:existingError}=await x.admin.from('restaurant_branch_payment_settings').select('branch_id,enabled,razorpay_key_id,razorpay_key_secret_encrypted,razorpay_webhook_secret_encrypted').eq('organization_id',x.context.organization.id).eq('branch_id',branchId).maybeSingle();if(existingError)throw existingError;
    let secretEnc:string|undefined;let webhookEnc:string|undefined;
    if(body.razorpayKeySecret.trim())secretEnc=encryptSecret(body.razorpayKeySecret.trim());
    if(body.razorpayWebhookSecret.trim())webhookEnc=encryptSecret(body.razorpayWebhookSecret.trim());
    let inheritedBase:{enabled:boolean;razorpay_key_id:string|null;razorpay_key_secret_encrypted:string|null;razorpay_webhook_secret_encrypted:string|null}|null=null;
    if(!existing){
      const{data:org,error:orgError}=await x.admin.from('restaurant_payment_settings').select('enabled,razorpay_key_id,razorpay_key_secret_encrypted,razorpay_webhook_secret_encrypted').eq('organization_id',x.context.organization.id).maybeSingle();if(orgError)throw orgError;inheritedBase=org??null;
    }
    const payload={
      organization_id:x.context.organization.id,
      branch_id:branchId,
      enabled:body.enabled,
      pay_at_counter_enabled:body.payAtCounterEnabled,
      pay_later_enabled:body.payLaterEnabled,
      razorpay_key_id:body.razorpayKeyId.trim() || existing?.razorpay_key_id || inheritedBase?.razorpay_key_id || null,
      razorpay_key_secret_encrypted:secretEnc || existing?.razorpay_key_secret_encrypted || inheritedBase?.razorpay_key_secret_encrypted || null,
      razorpay_webhook_secret_encrypted:webhookEnc || existing?.razorpay_webhook_secret_encrypted || inheritedBase?.razorpay_webhook_secret_encrypted || null,
    };
    const{error}=await x.admin.from('restaurant_branch_payment_settings').upsert(payload,{onConflict:'branch_id'});if(error)throw error;
    return NextResponse.json({ok:true,scope:'branch',branchId});
  }catch(error:unknown){console.error('settings/payment POST failed',error);return NextResponse.json({error:error instanceof Error&&error.message.includes('ENCRYPTION_KEY')?error.message:'Could not save payment settings.'},{status:error instanceof Error&&error.message.includes('ENCRYPTION_KEY')?503:500})}
}

export async function DELETE(request:Request){
  const x=await resolveContext();if('error' in x)return x.error;
  const url=new URL(request.url);const scope=url.searchParams.get('scope')||'branch';if(scope!=='branch')return NextResponse.json({error:'Organization defaults cannot be deleted.'},{status:400});
  const branchId=branchFromRequest(x,url.searchParams.get('branchId')||undefined);const auth=await authorizeBranch(x,branchId,'PAYMENTS');if('error' in auth)return auth.error;
  const{error}=await x.admin.from('restaurant_branch_payment_settings').delete().eq('organization_id',x.context.organization.id).eq('branch_id',branchId);
  if(error){console.error('settings/payment DELETE failed',error);return NextResponse.json({error:'Could not reset branch payment settings.'},{status:500});}
  return NextResponse.json({ok:true});
}
