import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { verifyTablelyWebhookSignature } from '@/lib/tablely-billing';
export const dynamic='force-dynamic';
export async function POST(request:Request){
  const raw=await request.text();
  const signature=request.headers.get('x-razorpay-signature')||'';
  if(!verifyTablelyWebhookSignature(raw,signature))return NextResponse.json({error:'Invalid webhook signature.'},{status:401});
  const admin=getSupabaseAdminClient();
  if(!admin)return NextResponse.json({error:'Server database configuration is incomplete.'},{status:503});
  let payload:unknown;
  try{payload=JSON.parse(raw);}catch{return NextResponse.json({error:'Invalid webhook payload.'},{status:400});}
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const nested = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const subscriptionEntity = nested(nested(p.payload).subscription).entity;
  const paymentEntity = nested(nested(p.payload).payment).entity;
  const subscription: Record<string, unknown> | null = subscriptionEntity && typeof subscriptionEntity === 'object' ? subscriptionEntity as Record<string, unknown> : null;
  const payment: Record<string, unknown> | null = paymentEntity && typeof paymentEntity === 'object' ? paymentEntity as Record<string, unknown> : null;
  const eventId=request.headers.get('x-razorpay-event-id')||String(p.id || '')||null;
  if(!eventId)return NextResponse.json({error:'Webhook event id is required.'},{status:400});
  const eventType=String(p.event||'unknown');
  const providerSubscriptionId=subscription ? String(subscription.id || '') : (payment ? String(payment.subscription_id || '') : null);
  const {data:recorded,error:recordError}=await admin.rpc('record_subscription_webhook_event',{p_provider_event_id:String(eventId),p_event_type:eventType,p_provider_subscription_id:providerSubscriptionId,p_payload:p});
  if(recordError){console.error('subscriptions/webhook: record failed',recordError);return NextResponse.json({error:'Webhook processing failed.'},{status:500});}
  if(recorded?.duplicate)return NextResponse.json({ok:true,duplicate:true});
  if(providerSubscriptionId){const {error:syncError}=await admin.rpc('apply_provider_subscription_event',{p_provider_subscription_id:providerSubscriptionId,p_event_type:eventType,p_status:subscription ? String(subscription.status || '') : null,p_provider_plan_id:subscription ? String(subscription.plan_id || '') : null,p_payment_id:payment ? String(payment.id || '') : null,p_payload:p});if(syncError){console.error('subscriptions/webhook: sync failed',syncError);return NextResponse.json({error:'Webhook processing failed.'},{status:500});}}
  return NextResponse.json({ok:true});
}
