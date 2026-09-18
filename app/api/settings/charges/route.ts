import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';
import type { SupabaseClient } from '@supabase/supabase-js';

const schema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  charge_type: z.enum(['TAX','FEE']),
  calculation_type: z.enum(['PERCENT','FIXED']),
  value: z.number().finite().min(0).max(1000000),
  enabled: z.boolean(),
  sort_order: z.number().int().min(0).max(1000),
  scope: z.enum(['branch','organization']).default('branch'),
  branchId: z.string().uuid().optional(),
});

async function resolveContext(){
  const supabase=await getSupabaseServerClient();const admin=getSupabaseAdminClient();
  if(!supabase||!admin)return {error:NextResponse.json({error:'Server not configured.'},{status:503})};
  const{data:context,error}=await getCurrentRestaurantContext(supabase);
  if(error||!context)return {error:NextResponse.json({error:error?.message==='Not authenticated'?'Not authenticated.':'Restaurant workspace could not be resolved.'},{status:error?.message==='Not authenticated'?401:403})};
  return {supabase,admin,context};
}
function resolveBranch(context:CurrentRestaurantContext|null,requested?:string){
  if(!context) return null;
  if(context.staff.role!=='OWNER')return context.branch.id;
  return requested||context.branch.id;
}
type ContextBundle={supabase:SupabaseClient;admin:SupabaseClient;context:CurrentRestaurantContext};
async function authorizeBranch(x:ContextBundle,branchId:string){
  if(!x.context.branches.some(b=>b.id===branchId))return {error:NextResponse.json({error:'Branch access denied.'},{status:403})};
  if(x.context.staff.role==='OWNER')return x;
  const{data:allowed,error}=await x.supabase.rpc('current_user_has_permission_for_branch',{p_branch_id:branchId,p_permission:'CHARGES'});
  if(error||allowed!==true)return {error:NextResponse.json({error:'Charge management permission required.'},{status:403})};
  return x;
}
type ChargeDbRow={id:string;organization_id:string;branch_id:string|null;source_charge_id:string|null;name:string;charge_type:'TAX'|'FEE';calculation_type:'PERCENT'|'FIXED';value:number|string;enabled:boolean;sort_order:number;updated_at?:string;created_at?:string};
async function initializeBranchOverrides(admin:SupabaseClient,organizationId:string,branchId:string){
  const{count,error:countError}=await admin.from('restaurant_charge_settings').select('id',{count:'exact',head:true}).eq('organization_id',organizationId).eq('branch_id',branchId);
  if(countError)throw countError;
  if(Number(count??0)>0)return;
  const{data:defaults,error}=await admin.from('restaurant_charge_settings').select('id,organization_id,name,charge_type,calculation_type,value,enabled,sort_order').eq('organization_id',organizationId).is('branch_id',null).order('sort_order').order('created_at');
  if(error)throw error;if(!defaults?.length)return;
  const clones=(defaults as unknown as ChargeDbRow[]).map((r)=>({organization_id:r.organization_id,branch_id:branchId,source_charge_id:r.id,name:r.name,charge_type:r.charge_type,calculation_type:r.calculation_type,value:r.value,enabled:r.enabled,sort_order:r.sort_order}));
  const{error:insertError}=await admin.from('restaurant_charge_settings').insert(clones);
  if(insertError)throw insertError;
}

export async function GET(request:Request){
  const x=await resolveContext();if('error' in x)return x.error;
  const url=new URL(request.url);const scope=(url.searchParams.get('scope')||'branch') as 'branch'|'organization';
  try{
    if(scope==='organization'){
      if(x.context.staff.role!=='OWNER')return NextResponse.json({error:'Owner access required for organization defaults.'},{status:403});
      const{data,error}=await x.admin.from('restaurant_charge_settings').select('id,name,charge_type,calculation_type,value,enabled,sort_order,updated_at,branch_id').eq('organization_id',x.context.organization.id).is('branch_id',null).order('sort_order').order('created_at');if(error)throw error;
      return NextResponse.json({charges:(data??[]).map((r)=>({...r as ChargeDbRow,inherited:false})),scope:'organization'});
    }
    const branchId=resolveBranch(x.context,url.searchParams.get('branchId')||undefined);if(!branchId)return NextResponse.json({error:'Branch not found.'},{status:404});const auth=await authorizeBranch(x,branchId);if('error' in auth)return auth.error;
    const{data:branchRows,error:branchError}=await x.admin.from('restaurant_charge_settings').select('id,name,charge_type,calculation_type,value,enabled,sort_order,updated_at,branch_id').eq('organization_id',x.context.organization.id).eq('branch_id',branchId).order('sort_order').order('created_at');if(branchError)throw branchError;
    if(branchRows?.length)return NextResponse.json({charges:branchRows.map((r)=>({...r as ChargeDbRow,inherited:false})),scope:'branch',branchId});
    const{data:defaults,error:defaultError}=await x.admin.from('restaurant_charge_settings').select('id,name,charge_type,calculation_type,value,enabled,sort_order,updated_at,branch_id').eq('organization_id',x.context.organization.id).is('branch_id',null).order('sort_order').order('created_at');if(defaultError)throw defaultError;
    return NextResponse.json({charges:(defaults??[]).map((r)=>({...r as ChargeDbRow,inherited:true})),scope:'branch',branchId});
  }catch(error:unknown){console.error('settings/charges GET failed',error);return NextResponse.json({error:'Could not load charges.'},{status:500})}
}

export async function POST(req:Request){
 const p=schema.safeParse(await req.json().catch(()=>({})));if(!p.success)return NextResponse.json({error:'Invalid charge settings.'},{status:400});const x=await resolveContext();if('error' in x)return x.error;
 try{
  const body=p.data;
  if(body.scope==='organization'){
    if(x.context.staff.role!=='OWNER')return NextResponse.json({error:'Owner access required for organization defaults.'},{status:403});
    if(body.id){const{data:existing,error}=await x.admin.from('restaurant_charge_settings').select('id,branch_id').eq('id',body.id).eq('organization_id',x.context.organization.id).maybeSingle();if(error)throw error;if(!existing||existing.branch_id!==null)return NextResponse.json({error:'Charge not found.'},{status:404});}
    const payload={name:body.name,charge_type:body.charge_type,calculation_type:body.calculation_type,value:body.value,enabled:body.enabled,sort_order:body.sort_order,organization_id:x.context.organization.id,branch_id:null};
    const result=body.id?await x.admin.from('restaurant_charge_settings').update(payload).eq('id',body.id).eq('organization_id',x.context.organization.id).select('id,name,charge_type,calculation_type,value,enabled,sort_order,updated_at,branch_id').single():await x.admin.from('restaurant_charge_settings').insert(payload).select('id,name,charge_type,calculation_type,value,enabled,sort_order,updated_at,branch_id').single();if(result.error)throw result.error;
    return NextResponse.json({charge:result.data,scope:'organization'});
  }
  const branchId=resolveBranch(x.context,body.branchId);if(!branchId)return NextResponse.json({error:'Branch not found.'},{status:404});const auth=await authorizeBranch(x,branchId);if('error' in auth)return auth.error;
  if(body.id){
    const{data:existing,error:existingError}=await x.admin.from('restaurant_charge_settings').select('id,branch_id,source_charge_id').eq('id',body.id).eq('organization_id',x.context.organization.id).maybeSingle();if(existingError)throw existingError;if(!existing)return NextResponse.json({error:'Charge not found.'},{status:404});
    if(existing.branch_id===null){
      await initializeBranchOverrides(x.admin,x.context.organization.id,branchId);
      const{data:clone,error:cloneError}=await x.admin.from('restaurant_charge_settings').select('id').eq('organization_id',x.context.organization.id).eq('branch_id',branchId).eq('source_charge_id',body.id).maybeSingle();if(cloneError)throw cloneError;if(!clone)return NextResponse.json({error:'Could not create branch-specific charge.'},{status:500});
      const result=await x.admin.from('restaurant_charge_settings').update({name:body.name,charge_type:body.charge_type,calculation_type:body.calculation_type,value:body.value,enabled:body.enabled,sort_order:body.sort_order,updated_at:new Date().toISOString()}).eq('id',clone.id).eq('organization_id',x.context.organization.id).eq('branch_id',branchId).select('id,name,charge_type,calculation_type,value,enabled,sort_order,updated_at,branch_id').single();if(result.error)throw result.error;return NextResponse.json({charge:result.data,scope:'branch',branchId});
    }
    if(existing.branch_id!==branchId)return NextResponse.json({error:'Charge belongs to another branch.'},{status:403});
    const result=await x.admin.from('restaurant_charge_settings').update({name:body.name,charge_type:body.charge_type,calculation_type:body.calculation_type,value:body.value,enabled:body.enabled,sort_order:body.sort_order,updated_at:new Date().toISOString()}).eq('id',body.id).eq('organization_id',x.context.organization.id).eq('branch_id',branchId).select('id,name,charge_type,calculation_type,value,enabled,sort_order,updated_at,branch_id').single();if(result.error)throw result.error;return NextResponse.json({charge:result.data,scope:'branch',branchId});
  }
  await initializeBranchOverrides(x.admin,x.context.organization.id,branchId);
  const result=await x.admin.from('restaurant_charge_settings').insert({organization_id:x.context.organization.id,branch_id:branchId,source_charge_id:null,name:body.name,charge_type:body.charge_type,calculation_type:body.calculation_type,value:body.value,enabled:body.enabled,sort_order:body.sort_order}).select('id,name,charge_type,calculation_type,value,enabled,sort_order,updated_at,branch_id').single();if(result.error)throw result.error;return NextResponse.json({charge:result.data,scope:'branch',branchId});
 }catch(error:unknown){console.error('settings/charges POST failed',error);return NextResponse.json({error:'Could not save charge.'},{status:500})}
}

export async function DELETE(req:Request){
 const x=await resolveContext();if('error' in x)return x.error;const url=new URL(req.url);const id=url.searchParams.get('id');const scope=(url.searchParams.get('scope')||'branch') as 'branch'|'organization';if(!id)return NextResponse.json({error:'Charge id is required.'},{status:400});
 try{
  if(scope==='organization'){if(x.context.staff.role!=='OWNER')return NextResponse.json({error:'Owner access required for organization defaults.'},{status:403});const{error}=await x.admin.from('restaurant_charge_settings').delete().eq('id',id).eq('organization_id',x.context.organization.id).is('branch_id',null);if(error)throw error;return NextResponse.json({ok:true});}
  const branchId=resolveBranch(x.context,url.searchParams.get('branchId')||undefined);if(!branchId)return NextResponse.json({error:'Branch not found.'},{status:404});const auth=await authorizeBranch(x,branchId);if('error' in auth)return auth.error;
  const{data:existing,error:existingError}=await x.admin.from('restaurant_charge_settings').select('id,branch_id').eq('id',id).eq('organization_id',x.context.organization.id).maybeSingle();if(existingError)throw existingError;if(!existing)return NextResponse.json({error:'Charge not found.'},{status:404});
  if(existing.branch_id===null){await initializeBranchOverrides(x.admin,x.context.organization.id,branchId);const{data:clone,error:cloneError}=await x.admin.from('restaurant_charge_settings').select('id').eq('organization_id',x.context.organization.id).eq('branch_id',branchId).eq('source_charge_id',id).maybeSingle();if(cloneError)throw cloneError;if(!clone)return NextResponse.json({error:'Could not create branch-specific charge.'},{status:500});const{error}=await x.admin.from('restaurant_charge_settings').delete().eq('id',clone.id).eq('organization_id',x.context.organization.id).eq('branch_id',branchId);if(error)throw error;return NextResponse.json({ok:true});}
  if(existing.branch_id!==branchId)return NextResponse.json({error:'Charge belongs to another branch.'},{status:403});const{error}=await x.admin.from('restaurant_charge_settings').delete().eq('id',id).eq('organization_id',x.context.organization.id).eq('branch_id',branchId);if(error)throw error;return NextResponse.json({ok:true});
 }catch(error:unknown){console.error('settings/charges DELETE failed',error);return NextResponse.json({error:'Could not delete charge.'},{status:500})}
}
