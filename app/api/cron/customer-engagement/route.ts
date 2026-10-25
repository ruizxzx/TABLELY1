import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { decryptSecret } from '@/lib/restaurant-payment';

export const dynamic='force-dynamic';
function authorized(req:Request){const secret=(process.env.CRON_SECRET||process.env.SELLORA_CRON_SECRET||'').trim();return Boolean(secret)&&(req.headers.get('authorization')===`Bearer ${secret}`||req.headers.get('x-cron-secret')===secret)}
export async function GET(req:Request){
 if(!authorized(req))return NextResponse.json({error:'Unauthorized'},{status:401});
 const db=getSupabaseAdminClient(),version=process.env.META_GRAPH_API_VERSION?.trim();if(!db)return NextResponse.json({error:'Server configuration unavailable.'},{status:503});if(!version)return NextResponse.json({error:'META_GRAPH_API_VERSION is not configured.'},{status:503});
 const now=new Date().toISOString();const{data:rows,error}=await db.from('restaurant_notification_queue').select('id,organization_id,branch_id,order_id,event_key,payload,attempts').eq('channel','WHATSAPP').in('status',['QUEUED','FAILED']).lte('next_attempt_at',now).lt('attempts',3).order('created_at').limit(40);if(error)return NextResponse.json({error:'Could not read notification queue.'},{status:500});
 const summary={checked:rows?.length??0,sent:0,failed:0,skipped:0};
 for(const row of rows??[]){
  try{
   const{data:connection}=await db.from('restaurant_whatsapp_connections').select('phone_number_id,access_token_encrypted,status').eq('organization_id',row.organization_id).maybeSingle();
   if(!connection||connection.status!=='CONNECTED'){summary.skipped++;continue}
   const{data:branch,error:branchError}=await db.from('branches').select('id').eq('id',row.branch_id).eq('organization_id',row.organization_id).maybeSingle();if(branchError)throw branchError;if(!branch)throw new Error('notification_branch_mismatch');
   const{data:order,error:orderError}=await db.from('orders').select('branch_id,customer_phone,customer_profile_id').eq('id',row.order_id).eq('branch_id',row.branch_id).maybeSingle();if(orderError)throw orderError;if(!order?.customer_phone)throw new Error('recipient_missing');
   const localPhone=order.customer_phone.replace(/[^0-9]/g,'').slice(-10);if(localPhone.length!==10)throw new Error('recipient_invalid');const phone=localPhone.length===10?`91${localPhone}`:localPhone;
   const{data:preference,error:preferenceError}=await db.from('restaurant_customer_preferences').select('whatsapp_service,feedback_messages,withdrawn_at').eq('organization_id',row.organization_id).eq(order.customer_profile_id?'customer_id':'phone',order.customer_profile_id??order.customer_phone.replace(/[^0-9]/g,'').slice(-10)).maybeSingle();if(preferenceError)throw preferenceError;
   const feedbackMessage=row.event_key==='FEEDBACK_REQUEST'||row.event_key==='GOOGLE_REVIEW_INVITATION';if(!preference||(feedbackMessage?!preference.feedback_messages:!preference.whatsapp_service)||preference.withdrawn_at){const{error:cancelError}=await db.from('restaurant_notification_queue').update({status:'CANCELLED',updated_at:new Date().toISOString()}).eq('id',row.id).eq('organization_id',row.organization_id).eq('branch_id',row.branch_id);if(cancelError)throw cancelError;summary.skipped++;continue}
   const{data:config}=await db.from('restaurant_notification_preferences').select('template_name,template_language').eq('organization_id',row.organization_id).eq('event_key',row.event_key).maybeSingle();
   const template=config?.template_name||(row.event_key==='FEEDBACK_REQUEST'?process.env.META_FEEDBACK_TEMPLATE_NAME:row.event_key==='GOOGLE_REVIEW_INVITATION'?process.env.META_REVIEW_TEMPLATE_NAME:null);if(!template)throw new Error('template_missing');
   const token=decryptSecret(connection.access_token_encrypted);if(!token)throw new Error('token_unavailable');
    const payload=row.payload??{},origin=process.env.NEXT_PUBLIC_SITE_URL||process.env.NEXT_PUBLIC_APP_URL||process.env.APP_URL||'',feedbackUrl=String(payload.feedbackUrl??''),reviewUrl=String(payload.reviewUrl??'');const contractTemplate="[payload.customerName?.'Customer',payload.orderNumber??'']";const vals=feedbackMessage?[payload.customerName??'Customer',`${origin}${row.event_key==='FEEDBACK_REQUEST'?feedbackUrl:reviewUrl}`]:[payload.customerName??'Customer',payload.orderNumber??'',payload.restaurantName??'Restaurant',payload.orderStatus??row.event_key,String(payload.orderAmount??'')];
   const{data:claim,error:claimError}=await db.from('restaurant_notification_queue').update({status:'SENDING',updated_at:new Date().toISOString()}).eq('id',row.id).in('status',['QUEUED','FAILED']).select('id').maybeSingle();if(claimError)throw claimError;if(!claim){summary.skipped++;continue}
   const response=await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(connection.phone_number_id)}/messages`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'template',template:{name:template,language:{code:config?.template_language??'en'},components:[{type:'body',parameters:vals.map(text=>({type:'text',text:String(text)}))}]}}),cache:'no-store'});
   const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`meta_${result?.error?.code??response.status}`);
   const providerId=result?.messages?.[0]?.id??null;const{error:sentError}=await db.from('restaurant_notification_queue').update({status:'SENT',provider_message_id:providerId,attempts:row.attempts+1,error_code:null,updated_at:new Date().toISOString()}).eq('id',row.id).eq('organization_id',row.organization_id).eq('branch_id',row.branch_id).eq('status','SENDING');if(sentError)throw sentError;summary.sent++;
  }catch(error){const attempts=row.attempts+1;const code=error instanceof Error?error.message.slice(0,80):'send_failed';const{error:failureError}=await db.from('restaurant_notification_queue').update({status:attempts>=3?'FAILED':'QUEUED',attempts,error_code:code,next_attempt_at:new Date(Date.now()+Math.min(60,2**attempts)*60000).toISOString(),updated_at:new Date().toISOString()}).eq('id',row.id).eq('organization_id',row.organization_id).eq('branch_id',row.branch_id).eq('status','SENDING');if(failureError){console.error('WhatsApp notification state could not be saved',failureError);return NextResponse.json({error:'Notification processing state could not be saved.'},{status:503})}summary.failed++;}
 }
 return NextResponse.json({ok:true,...summary});
}
export async function POST(req:Request){return GET(req)}
