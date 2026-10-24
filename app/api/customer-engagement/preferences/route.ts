import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const schema=z.object({orderId:z.string().uuid(),trackingToken:z.string().min(20).max(200),whatsappService:z.boolean(),whatsappMarketing:z.boolean(),feedbackMessages:z.boolean(),feedbackEmail:z.boolean().optional(),emailNotifications:z.boolean(),email:z.string().email().max(320).nullable().optional(),languageCode:z.enum(['en','hi','bn']).default('en')}).refine(value=>!value.feedbackEmail||Boolean(value.email),{message:'Add an email address before enabling private feedback by email.'});
export async function POST(request:Request){
 const body=schema.safeParse(await request.json().catch(()=>null));if(!body.success)return NextResponse.json({error:'Invalid communication preferences.'},{status:400});
 const db=getSupabaseAdminClient();if(!db)return NextResponse.json({error:'Server configuration unavailable.'},{status:503});
 const{data:order,error}=await db.from('orders').select('id,branch_id,customer_profile_id,customer_phone,tracking_token,status,payment_status,total,order_number').eq('id',body.data.orderId).eq('tracking_token',body.data.trackingToken).maybeSingle();
 if(error)return NextResponse.json({error:'Could not verify this order.'},{status:503});if(!order)return NextResponse.json({error:'Order session could not be verified.'},{status:403});
 const{data:branch}=await db.from('branches').select('organization_id').eq('id',order.branch_id).maybeSingle();if(!branch)return NextResponse.json({error:'Restaurant not found.'},{status:404});
 const normalizedPhone=order.customer_phone?.replace(/\D/g,'').slice(-10)??null;
 if(!order.customer_profile_id&&!normalizedPhone)return NextResponse.json({error:'A valid customer phone is required to save order preferences.'},{status:400});
 const consentAt=new Date().toISOString();
 const values={organization_id:branch.organization_id,customer_id:order.customer_profile_id,phone:normalizedPhone,email:body.data.email??null,whatsapp_service:body.data.whatsappService,whatsapp_marketing:body.data.whatsappMarketing,feedback_messages:body.data.feedbackMessages,email_notifications:body.data.emailNotifications,language_code:body.data.languageCode,consent_source:'ORDER_CHECKOUT',consented_at:consentAt,withdrawn_at:body.data.whatsappService||body.data.whatsappMarketing||body.data.feedbackMessages||body.data.emailNotifications||body.data.feedbackEmail?null:consentAt,updated_at:consentAt,...(body.data.feedbackEmail===undefined?{}:body.data.feedbackEmail?{feedback_email:true,feedback_email_consent_at:consentAt,feedback_email_withdrawn_at:null,feedback_email_consent_version:'feedback-email-v1',feedback_email_consent_source:'ORDER_CHECKOUT'}:{feedback_email:false,feedback_email_withdrawn_at:consentAt})};
 try{
  if(order.customer_profile_id){const{error:saveError}=await db.from('restaurant_customer_preferences').upsert(values,{onConflict:'organization_id,customer_id'});if(saveError)throw saveError;}
  else {const{error:saveError}=await db.from('restaurant_customer_preferences').upsert(values,{onConflict:'organization_id,anonymous_phone_key'});if(saveError)throw saveError;}
  if(body.data.feedbackEmail&&order.status==='COMPLETED'&&order.payment_status==='PAID'){
   const{data:settings,error:settingsError}=await db.from('restaurant_feedback_settings').select('enabled,channel,delay_minutes').eq('organization_id',branch.organization_id).maybeSingle();if(settingsError)throw settingsError;
   if(settings?.enabled&&settings.channel==='EMAIL'){
    const{error:inviteError}=await db.from('restaurant_feedback_invitations').upsert({organization_id:branch.organization_id,branch_id:order.branch_id,order_id:order.id,customer_id:order.customer_profile_id,channel:'EMAIL',status:'QUEUED'},{onConflict:'order_id',ignoreDuplicates:true});if(inviteError)throw inviteError;
    const{data:invitation,error:invitationError}=await db.from('restaurant_feedback_invitations').select('id,channel,status').eq('order_id',order.id).maybeSingle();if(invitationError)throw invitationError;
    if(invitation?.channel==='EMAIL'&&invitation.status==='QUEUED'){
     const email=body.data.email?.trim().toLowerCase();if(!email)throw new Error('Feedback email consent requires a current email address.');
     const{error:queueError}=await db.from('restaurant_notification_queue').upsert({organization_id:branch.organization_id,branch_id:order.branch_id,order_id:order.id,event_key:'FEEDBACK_REQUEST',channel:'EMAIL',recipient_hash:createHash('sha256').update(`${branch.organization_id}:${email}`).digest('hex'),payload:{feedbackUrl:`/feedback/${invitation.id}`},idempotency_key:`order:${order.id}:FEEDBACK_EMAIL`,next_attempt_at:new Date(Date.now()+Number(settings.delay_minutes??0)*60_000).toISOString()},{onConflict:'idempotency_key',ignoreDuplicates:true});if(queueError)throw queueError;
    }
   }
  }
  if(body.data.whatsappService&&order.status==='NEW'){
   const{data:connection}=await db.from('restaurant_whatsapp_connections').select('status').eq('organization_id',branch.organization_id).maybeSingle();
   const{data:pref}=await db.from('restaurant_notification_preferences').select('enabled').eq('organization_id',branch.organization_id).eq('event_key','ORDER_RECEIVED').maybeSingle();
   if(connection?.status==='CONNECTED'&&pref?.enabled!==false){const{data:organization}=await db.from('organizations').select('name').eq('id',branch.organization_id).maybeSingle();await db.from('restaurant_notification_queue').upsert({organization_id:branch.organization_id,branch_id:order.branch_id,order_id:order.id,event_key:'ORDER_RECEIVED',channel:'WHATSAPP',recipient_hash:createHash('sha256').update(`${branch.organization_id}:${normalizedPhone}`).digest('hex'),payload:{restaurantName:organization?.name??'Restaurant',customerName:'Customer',orderNumber:order.order_number,orderAmount:order.total,orderStatus:'NEW'},idempotency_key:`order:${order.id}:ORDER_RECEIVED`},{onConflict:'idempotency_key',ignoreDuplicates:true});}
  }
  return NextResponse.json({ok:true});
 }catch(error){console.error('save customer consent',error);return NextResponse.json({error:'Could not save preferences.'},{status:500})}
}
