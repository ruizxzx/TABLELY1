import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

const answerSchema=z.union([z.number().int().min(1).max(5),z.string().trim().max(5000)]);
const schema=z.object({rating:z.number().int().min(1).max(5),comment:z.string().trim().max(5000).optional().default(''),answers:z.record(z.string(),answerSchema).optional().default({})});
const supportedQuestions=new Map([
 ['rating',{key:'rating',type:'rating',required:true,label:'Overall experience'}],
 ['food_quality',{key:'food_quality',type:'rating',required:false,label:'Food quality'}],
 ['service_quality',{key:'service_quality',type:'rating',required:false,label:'Service quality'}],
 ['cleanliness',{key:'cleanliness',type:'rating',required:false,label:'Cleanliness'}],
 ['waiting_time',{key:'waiting_time',type:'rating',required:false,label:'Waiting time'}],
 ['value_for_money',{key:'value_for_money',type:'rating',required:false,label:'Value for money'}],
 ['comment',{key:'comment',type:'text',required:false,label:'Written comment'}],
]);
const defaultQuestions=[
 {key:'rating',type:'rating',required:true,label:'Overall experience'},
 {key:'comment',type:'text',required:false,label:'Written comment'},
];
function getQuestions(value:unknown):Array<{key:string;type:string;required:boolean;label:string}>{
 if(!Array.isArray(value))return defaultQuestions;
 const questions=value.flatMap((question)=>{
  if(!question||typeof question!=='object'||!('key'in question))return [];
  const valid=supportedQuestions.get(String(question.key));
  return valid&&'type'in question&&question.type===valid.type
   ?[{...valid,required:valid.key==='rating'||('required'in question&&question.required===true)}]
   :[];
 });
 return questions.some(question=>question.key==='rating')?questions:defaultQuestions;
}
function privateJson(body:unknown,status=200){return NextResponse.json(body,{status,headers:{'Cache-Control':'private, no-store'}})}
export async function GET(_request:Request,{params}:{params:Promise<{invitationId:string}>}){
 const{invitationId}=await params;if(!/^[0-9a-f-]{36}$/i.test(invitationId))return NextResponse.json({error:'Feedback invitation not found.'},{status:404});
 const db=getSupabaseAdminClient();if(!db)return NextResponse.json({error:'Feedback is temporarily unavailable.'},{status:503});
 const{data:invite,error}=await db.from('restaurant_feedback_invitations').select('id,organization_id,branch_id,order_id,status,restaurant_feedback_settings(questions),organizations(name)').eq('id',invitationId).maybeSingle();
 if(error)return privateJson({error:'Feedback invitation could not be loaded.'},503);
 if(!invite)return privateJson({error:'Feedback invitation not found.'},404);
 const[{data:order,error:orderError},{data:review,error:reviewError}]=await Promise.all([
  db.from('orders').select('branch_id,status,payment_status').eq('id',invite.order_id).eq('branch_id',invite.branch_id).maybeSingle(),
  db.from('restaurant_review_invitations').select('id').eq('organization_id',invite.organization_id).eq('branch_id',invite.branch_id).eq('order_id',invite.order_id).maybeSingle(),
 ]);
 if(orderError||reviewError)return privateJson({error:'Feedback invitation could not be loaded.'},503);
 if(order?.status!=='COMPLETED'||order.payment_status!=='PAID')return privateJson({error:'Feedback is available after a completed paid order.'},403);
 const org=Array.isArray(invite.organizations)?invite.organizations[0]:invite.organizations;const setting=Array.isArray(invite.restaurant_feedback_settings)?invite.restaurant_feedback_settings[0]:invite.restaurant_feedback_settings;
 return privateJson({invitationId:invite.id,restaurantName:org?.name??'Restaurant',questions:getQuestions(setting?.questions),reviewUrl:review?`/api/public-review-invitations/${review.id}`:null,submitted:invite.status==='SUBMITTED'});
}
export async function POST(request:Request,{params}:{params:Promise<{invitationId:string}>}){
 const{invitationId}=await params;if(!/^[0-9a-f-]{36}$/i.test(invitationId))return privateJson({error:'Feedback invitation not found.'},404);
 const parsed=schema.safeParse(await request.json().catch(()=>null));if(!parsed.success)return privateJson({error:'Please provide a valid overall rating and answers.'},400);
 const db=getSupabaseAdminClient();if(!db)return privateJson({error:'Feedback is temporarily unavailable.'},503);
 const{data:invite,error}=await db.from('restaurant_feedback_invitations').select('id,organization_id,branch_id,order_id,customer_id,status,restaurant_feedback_settings(questions)').eq('id',invitationId).maybeSingle();
 if(error)return privateJson({error:'Feedback invitation could not be loaded.'},503);
 if(!invite)return privateJson({error:'Feedback invitation not found.'},404);
 if(invite.status==='SUBMITTED')return privateJson({error:'Feedback has already been submitted.'},409);
 const{data:order,error:orderError}=await db.from('orders').select('branch_id,status,payment_status').eq('id',invite.order_id).eq('branch_id',invite.branch_id).maybeSingle();
 if(orderError)return privateJson({error:'Feedback could not be verified.'},503);
 if(order?.status!=='COMPLETED'||order.payment_status!=='PAID')return privateJson({error:'Feedback is available after a completed paid order.'},403);
 const setting=Array.isArray(invite.restaurant_feedback_settings)?invite.restaurant_feedback_settings[0]:invite.restaurant_feedback_settings;
 const questions=getQuestions(setting?.questions);
 const enabled=new Map(questions.map(question=>[question.key,question]));
 const unexpected=Object.keys(parsed.data.answers).find(key=>!enabled.has(key));
 if(unexpected)return privateJson({error:'An answer was provided for a disabled survey question.'},400);
 if(parsed.data.answers.rating!==undefined&&parsed.data.answers.rating!==parsed.data.rating)return privateJson({error:'Overall rating answers do not match.'},400);
 const missingRequired=questions.find(question=>question.required&&question.key!=='rating'&&parsed.data.answers[question.key]===undefined);
 if(missingRequired)return privateJson({error:`Please answer: ${missingRequired.label}.`},400);
 const commentQuestion=enabled.get('comment');
 const answerComment=parsed.data.answers.comment;
 if(answerComment!==undefined&&typeof answerComment!=='string')return privateJson({error:'Written feedback must be text.'},400);
 if(!commentQuestion&&parsed.data.comment)return privateJson({error:'Written comments are not enabled for this survey.'},400);
 const comment=typeof answerComment==='string'?answerComment:parsed.data.comment;
 const answers:Record<string,number>={};
 for(const[key,value]of Object.entries(parsed.data.answers)){
  if(key==='comment'||key==='rating')continue;
  const question=enabled.get(key);
  if(question?.type!=='rating'||typeof value!=='number')return privateJson({error:'A survey answer has the wrong type.'},400);
  answers[key]=value;
 }
 const{error:insertError}=await db.from('restaurant_customer_feedback').insert({organization_id:invite.organization_id,branch_id:invite.branch_id,order_id:invite.order_id,customer_id:invite.customer_id,invitation_id:invite.id,rating:parsed.data.rating,comment:comment||null,answers,is_private:true,status:'NEW'});
 if(insertError)return privateJson({error:insertError.code==='23505'?'Feedback has already been submitted.':'Could not submit feedback.'},insertError.code==='23505'?409:500);
 const{error:updateError}=await db.from('restaurant_feedback_invitations').update({status:'SUBMITTED'}).eq('id',invite.id);
 if(updateError){console.error('feedback invitation status update',updateError);return privateJson({error:'Feedback was saved but its invitation status could not be updated.'},503)}
 const{data:review,error:reviewError}=await db.from('restaurant_review_invitations').select('id').eq('order_id',invite.order_id).maybeSingle();
 if(reviewError){console.error('feedback saved but review invitation lookup failed',reviewError);return privateJson({error:'Feedback was saved, but the review option could not be loaded.'},503)}
 return privateJson({ok:true,reviewUrl:review?`/api/public-review-invitations/${review.id}`:null});
}
