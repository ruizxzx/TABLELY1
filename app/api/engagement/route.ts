import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';
import { decryptSecret, encryptSecret } from '@/lib/restaurant-payment';

const feedbackQuestionSchema=z.object({
 key:z.enum(['rating','food_quality','service_quality','cleanliness','waiting_time','value_for_money','comment']),
 type:z.enum(['rating','text']),
 required:z.boolean(),
});
const feedbackQuestionsSchema=z.array(feedbackQuestionSchema).min(1).max(7);

const saveSchema = z.discriminatedUnion('action', [
 z.object({action:z.literal('whatsapp'),businessAccountId:z.string().trim().min(3).max(120),phoneNumberId:z.string().trim().min(3).max(120),businessName:z.string().trim().max(160).optional(),displayPhone:z.string().trim().max(40).optional(),accessToken:z.string().trim().min(20).max(4096)}),
 z.object({action:z.literal('disconnect_whatsapp')}),
 z.object({action:z.literal('test_whatsapp')}),
 z.object({action:z.literal('loyalty'),enabled:z.boolean(),pointsPerCurrency:z.number().min(0).max(100),currencyPerPoint:z.number().min(0).max(100),minimumRedemptionPoints:z.number().int().min(0).max(10000000),pointsExpireDays:z.number().int().min(1).max(3650).nullable()}),
 z.object({action:z.literal('feedback'),enabled:z.boolean(),delayMinutes:z.number().int().min(0).max(10080),channel:z.enum(['IN_APP','WHATSAPP','EMAIL']),questions:feedbackQuestionsSchema.optional()}),
 z.object({action:z.literal('languages'),defaultLanguage:z.enum(['en','hi','bn']),enabledLanguages:z.array(z.enum(['en','hi','bn'])).min(1).max(3)}),
 z.object({action:z.literal('notifications'),events:z.array(z.object({eventKey:z.enum(['ORDER_RECEIVED','ORDER_CONFIRMED','ORDER_REJECTED','PREPARATION_STARTED','ORDER_READY','ORDER_COMPLETED','PAYMENT_CONFIRMED','RECEIPT_AVAILABLE','ORDER_CANCELLED']),enabled:z.boolean(),templateName:z.string().trim().max(512).nullable(),templateLanguage:z.enum(['en','hi','bn'])})).max(9)}),
 z.object({action:z.literal('review_link'),branchId:z.string().uuid(),reviewUrl:z.string().url().max(1000).nullable(),invitationEnabled:z.boolean(),inviteChannel:z.enum(['WHATSAPP','QR'])}),
 z.object({action:z.literal('feedback_triage'),feedbackId:z.string().uuid(),status:z.enum(['NEW','IN_PROGRESS','RESOLVED','ARCHIVED']),resolutionNote:z.string().max(3000).optional()}),
]);

async function context(){
 const supabase=await getSupabaseServerClient();const admin=getSupabaseAdminClient();
 if(!supabase||!admin)return{error:NextResponse.json({error:'Server configuration is unavailable.'},{status:503})};
 const{data,error}=await getCurrentRestaurantContext(supabase);
 if(error||!data)return{error:NextResponse.json({error:error?.message==='Not authenticated'?'Not authenticated.':'Restaurant workspace not found.'},{status:error?.message==='Not authenticated'?401:403})};
 return{supabase,admin,ctx:data};
}
type Bundle=Extract<Awaited<ReturnType<typeof context>>,{admin:unknown}>;
async function ownerOnly(x:Bundle){if(x.ctx.staff.role==='OWNER')return true;const{data}=await x.supabase.rpc('current_user_has_permission_for_branch',{p_branch_id:x.ctx.branch.id,p_permission:'SETTINGS'});return data===true;}

export async function GET(){
 const x=await context();if('error'in x)return x.error;
 if(!(await ownerOnly(x)))return NextResponse.json({error:'Owner or settings permission required.'},{status:403});
 const org=x.ctx.organization.id,branch=x.ctx.branch.id,db=x.admin;
 try{
  const [wa,loyalty,feedback,languages,notifications,reviewSettings,googleConnection,googleLocations,feedbackRows,ledger,invites,feedbackInvites,reviews,queue,metrics]=await Promise.all([
   db.from('restaurant_whatsapp_connections').select('business_account_id,phone_number_id,business_name,display_phone,status,webhook_status,token_expires_at,last_error_code,last_error_at,connected_at').eq('organization_id',org).maybeSingle(),
   db.from('restaurant_loyalty_programs').select('*').eq('organization_id',org).maybeSingle(),
   db.from('restaurant_feedback_settings').select('*').eq('organization_id',org).maybeSingle(),
   db.from('restaurant_language_settings').select('*').eq('organization_id',org).maybeSingle(),
   db.from('restaurant_notification_preferences').select('*').eq('organization_id',org),
   db.from('restaurant_google_review_settings').select('*').eq('organization_id',org).eq('branch_id',branch),
   db.from('restaurant_google_connections').select('google_account_id,status,connected_at,last_sync_at,last_sync_status,last_sync_error').eq('organization_id',org).maybeSingle(),
   db.from('restaurant_google_locations').select('id,branch_id,google_location_name,display_name,verified').eq('organization_id',org).eq('branch_id',branch),
   db.from('restaurant_customer_feedback').select('id,branch_id,order_id,rating,comment,answers,is_private,status,assigned_to,resolution_note,created_at').eq('organization_id',org).eq('branch_id',branch).order('created_at',{ascending:false}).limit(100),
   db.from('restaurant_loyalty_ledger').select('points,entry_type,created_at,branch_id,customer_id').eq('organization_id',org).eq('branch_id',branch).order('created_at',{ascending:false}).limit(500),
   db.from('restaurant_review_invitations').select('id,branch_id,status,channel,clicked_at,created_at').eq('organization_id',org).eq('branch_id',branch).order('created_at',{ascending:false}).limit(200),
   db.from('restaurant_feedback_invitations').select('id,branch_id,order_id,status,channel,sent_at,created_at').eq('organization_id',org).eq('branch_id',branch).order('created_at',{ascending:false}).limit(200),
   db.from('restaurant_google_reviews').select('id,branch_id,star_rating,review_text,reviewer_name,review_created_at,owner_reply,reply_status').eq('organization_id',org).eq('branch_id',branch).order('review_created_at',{ascending:false}).limit(200),
   db.from('restaurant_notification_queue').select('status,created_at,branch_id').eq('organization_id',org).eq('branch_id',branch).eq('channel','WHATSAPP').order('created_at',{ascending:false}).limit(500),
   db.rpc('restaurant_engagement_branch_metrics',{p_organization_id:org,p_branch_id:branch}),
  ]);
  const error=[wa,loyalty,feedback,languages,notifications,reviewSettings,googleConnection,googleLocations,feedbackRows,ledger,invites,feedbackInvites,reviews,queue,metrics].find(r=>r.error)?.error;if(error)throw error;
  return NextResponse.json({branchId:branch,branches:x.ctx.branches,whatsapp:wa.data,loyalty:loyalty.data,feedbackSettings:feedback.data,languages:languages.data,notifications:notifications.data??[],reviewSettings:reviewSettings.data??[],googleConnection:googleConnection.data,googleLocations:googleLocations.data??[],feedback:feedbackRows.data??[],feedbackInvitations:feedbackInvites.data??[],ledger:ledger.data??[],reviewInvitations:invites.data??[],googleReviews:reviews.data??[],metrics:metrics.data??{}});
 }catch(e){console.error('engagement GET',e);return NextResponse.json({error:'Customer engagement data could not be loaded. Apply the Build 32 migration if it is pending.'},{status:503})}
}

export async function POST(request:Request){
 const x=await context();if('error'in x)return x.error;
 const parsed=saveSchema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return NextResponse.json({error:'Invalid customer engagement request.'},{status:400});
 const b=parsed.data,org=x.ctx.organization.id,branch=x.ctx.branch.id,db=x.admin;
 try{
  if(!(await ownerOnly(x)))return NextResponse.json({error:'Owner or settings permission required.'},{status:403});
  if(b.action==='whatsapp'){
   const encrypted=encryptSecret(b.accessToken);
   const{error}=await db.from('restaurant_whatsapp_connections').upsert({organization_id:org,business_account_id:b.businessAccountId,phone_number_id:b.phoneNumberId,business_name:b.businessName||null,display_phone:b.displayPhone||null,access_token_encrypted:encrypted,status:'PENDING',webhook_status:'UNKNOWN',connected_by:x.ctx.userId,updated_at:new Date().toISOString()},{onConflict:'organization_id'});if(error)throw error;
   await db.from('restaurant_engagement_audit').insert({organization_id:org,actor_user_id:x.ctx.userId,action:'WHATSAPP_CREDENTIALS_SAVED',entity_type:'WHATSAPP_CONNECTION'});
  }else if(b.action==='disconnect_whatsapp'){
   const{error}=await db.from('restaurant_whatsapp_connections').update({status:'DISCONNECTED',access_token_encrypted:'',updated_at:new Date().toISOString()}).eq('organization_id',org);if(error)throw error;
   await db.from('restaurant_engagement_audit').insert({organization_id:org,actor_user_id:x.ctx.userId,action:'WHATSAPP_DISCONNECTED',entity_type:'WHATSAPP_CONNECTION'});
  }else if(b.action==='test_whatsapp'){
   const version=process.env.META_GRAPH_API_VERSION?.trim();if(!version)return NextResponse.json({error:'Set META_GRAPH_API_VERSION on the server before testing WhatsApp.'},{status:503});
   const{data:connection,error}=await db.from('restaurant_whatsapp_connections').select('phone_number_id,access_token_encrypted').eq('organization_id',org).maybeSingle();if(error)throw error;if(!connection)return NextResponse.json({error:'Save the restaurant WhatsApp credentials first.'},{status:404});
   const token=decryptSecret(connection.access_token_encrypted);if(!token)return NextResponse.json({error:'Could not decrypt the stored token. Check TABLELY_ENCRYPTION_KEY.'},{status:503});
   const response=await fetch(`https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(connection.phone_number_id)}?fields=id,display_phone_number,verified_name`,{headers:{authorization:`Bearer ${token}`},cache:'no-store'});const result=await response.json().catch(()=>({}));
   if(!response.ok){await db.from('restaurant_whatsapp_connections').update({status:'ERROR',last_error_code:String(result?.error?.code??'provider_error'),last_error_at:new Date().toISOString()}).eq('organization_id',org);return NextResponse.json({error:'Meta could not verify this phone number. Check its token, ID and permissions.'},{status:502});}
   const{error:updateError}=await db.from('restaurant_whatsapp_connections').update({status:'CONNECTED',display_phone:result.display_phone_number??null,business_name:result.verified_name??null,last_error_code:null,last_error_at:null,connected_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq('organization_id',org);if(updateError)throw updateError;
  }else if(b.action==='loyalty'){
   const{error}=await db.from('restaurant_loyalty_programs').upsert({organization_id:org,enabled:b.enabled,points_per_currency:b.pointsPerCurrency,currency_per_point:b.currencyPerPoint,minimum_redemption_points:b.minimumRedemptionPoints,points_expire_days:b.pointsExpireDays,updated_by:x.ctx.userId,updated_at:new Date().toISOString()},{onConflict:'organization_id'});if(error)throw error;
  }else if(b.action==='feedback'){
   const{data:existing,error:existingError}=await db.from('restaurant_feedback_settings').select('questions').eq('organization_id',org).maybeSingle();if(existingError)throw existingError;
   const parsedQuestions=feedbackQuestionsSchema.safeParse(b.questions??existing?.questions??[{key:'rating',type:'rating',required:true},{key:'comment',type:'text',required:false}]);
   if(!parsedQuestions.success)return NextResponse.json({error:'Saved feedback questions are invalid. Reconfigure the survey questions before saving.'},{status:409});
   const questions=[...new Map(parsedQuestions.data.map(question=>[question.key,question])).values()];
   if(!questions.some(question=>question.key==='rating'))return NextResponse.json({error:'Overall experience must remain enabled.'},{status:400});
   const expectedTypes:Record<string,string>={rating:'rating',food_quality:'rating',service_quality:'rating',cleanliness:'rating',waiting_time:'rating',value_for_money:'rating',comment:'text'};
   if(questions.some(question=>expectedTypes[question.key]!==question.type))return NextResponse.json({error:'A feedback question has an invalid type.'},{status:400});
   const{error}=await db.from('restaurant_feedback_settings').upsert({organization_id:org,enabled:b.enabled,delay_minutes:b.delayMinutes,channel:b.channel,questions,updated_by:x.ctx.userId,updated_at:new Date().toISOString()},{onConflict:'organization_id'});if(error)throw error;
  }else if(b.action==='languages'){
   if(!b.enabledLanguages.includes(b.defaultLanguage))return NextResponse.json({error:'Default language must be enabled.'},{status:400});
   const{error}=await db.from('restaurant_language_settings').upsert({organization_id:org,default_language:b.defaultLanguage,enabled_languages:[...new Set(b.enabledLanguages)],auto_translate:false,updated_by:x.ctx.userId,updated_at:new Date().toISOString()},{onConflict:'organization_id'});if(error)throw error;
  }else if(b.action==='notifications'){
   const rows=b.events.map(e=>({organization_id:org,event_key:e.eventKey,enabled:e.enabled,template_name:e.templateName,template_language:e.templateLanguage,updated_by:x.ctx.userId,updated_at:new Date().toISOString()}));
   if(rows.length){const{error}=await db.from('restaurant_notification_preferences').upsert(rows,{onConflict:'organization_id,event_key'});if(error)throw error;}
  }else if(b.action==='review_link'){
   if(!x.ctx.branches.some(v=>v.id===b.branchId))return NextResponse.json({error:'Branch access denied.'},{status:403});
   if(b.reviewUrl&&!/^https:\/\/(?:g\.page|maps\.app\.goo\.gl|search\.google\.com|www\.google\.com)\//i.test(b.reviewUrl))return NextResponse.json({error:'Use a valid Google review or Maps URL.'},{status:400});
   const{error}=await db.from('restaurant_google_review_settings').upsert({organization_id:org,branch_id:b.branchId,review_url:b.reviewUrl,invitation_enabled:b.invitationEnabled,invite_channel:b.inviteChannel,updated_by:x.ctx.userId,updated_at:new Date().toISOString()},{onConflict:'branch_id'});if(error)throw error;
  }else if(b.action==='feedback_triage'){
   if(x.ctx.staff.role!=='OWNER'&&x.ctx.staff.role!=='MANAGER')return NextResponse.json({error:'Manager access required.'},{status:403});
   const{data:updated,error}=await db.from('restaurant_customer_feedback').update({status:b.status,assigned_to:x.ctx.userId,resolution_note:b.resolutionNote??null,resolved_at:b.status==='RESOLVED'?new Date().toISOString():null}).eq('id',b.feedbackId).eq('organization_id',org).eq('branch_id',branch).select('id').maybeSingle();if(error)throw error;if(!updated)return NextResponse.json({error:'Feedback not found in the selected branch.'},{status:404});
  }
  return NextResponse.json({ok:true});
 }catch(e){console.error('engagement POST',e);return NextResponse.json({error:e instanceof Error&&e.message.includes('ENCRYPTION_KEY')?e.message:'Could not save engagement settings.'},{status:e instanceof Error&&e.message.includes('ENCRYPTION_KEY')?503:500})}
}
