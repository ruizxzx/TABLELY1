import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getAdminSupabase } from '../../../lib/server-admin';
import { validateBillingWebhook, fetchBillingPayment, fetchBillingSubscription, unixToIso } from '../../../lib/billing';
import { persistProviderSubscription, persistSubscriptionPayment } from '../../../lib/billing-service';
import { sendSubscriptionConfirmationEmail, sendSubscriptionRenewalEmail, sendSubscriptionFailureEmail, sendSubscriptionCancellationEmail } from '../../../lib/server-email';

export const dynamic = 'force-dynamic';

function eventId(raw: string, headers: Headers) {
  return headers.get('x-razorpay-event-id') || `body-sha256-${createHash('sha256').update(raw).digest('hex')}`;
}
function subscriptionEntity(payload: any) { return payload?.payload?.subscription?.entity || null; }
function paymentEntity(payload: any) { return payload?.payload?.payment?.entity || null; }

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 2_000_000) return NextResponse.json({ ok:false, error:'Webhook payload too large.' }, { status:413 });
  const signature = request.headers.get('x-razorpay-signature');
  if (!validateBillingWebhook(raw, signature)) return NextResponse.json({ ok:false, error:'Invalid billing webhook signature.' }, { status:401 });

  let payload:any;
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ ok:false, error:'Invalid webhook JSON.' }, { status:400 }); }

  const admin=getAdminSupabase();
  const providerEventId=eventId(raw,request.headers);
  const eventType=String(payload?.event||'unknown');
  const subEntity=subscriptionEntity(payload);
  const payEntity=paymentEntity(payload);
  const providerSubscriptionId=String(subEntity?.id||payEntity?.subscription_id||'').trim()||null;
  const providerPaymentId=String(payEntity?.id||'').trim()||null;

  const {data:inserted,error:insertError}=await admin.from('sellora_subscription_events').insert({provider:'razorpay',provider_event_id:providerEventId,event_type:eventType,provider_subscription_id:providerSubscriptionId,provider_payment_id:providerPaymentId,signature_verified:true,payload}).select('id,processed_at,received_at').maybeSingle();
  if(insertError&&String((insertError as any).code)!=='23505'){
    console.error('[billing-webhook-event-insert]',insertError);
    return NextResponse.json({ok:false,error:'Could not record webhook event.'},{status:500});
  }
  if(!inserted){
    const {data:existing}=await admin.from('sellora_subscription_events').select('id,processed_at').eq('provider','razorpay').eq('provider_event_id',providerEventId).maybeSingle();
    if(existing?.processed_at)return NextResponse.json({ok:true,duplicate:true});
    return NextResponse.json({ok:true,duplicate_in_progress:true});
  }

  try{
    if(!providerSubscriptionId){
      await admin.from('sellora_subscription_events').update({processed_at:new Date().toISOString()}).eq('provider','razorpay').eq('provider_event_id',providerEventId);
      return NextResponse.json({ok:true,ignored:true});
    }
    const {data:local,error:localError}=await admin.from('sellora_subscriptions').select('id,creator_id,provider_subscription_id').eq('provider_subscription_id',providerSubscriptionId).maybeSingle();
    if(localError)throw localError;
    if(!local){
      await admin.from('sellora_subscription_events').update({processed_at:new Date().toISOString()}).eq('provider','razorpay').eq('provider_event_id',providerEventId);
      return NextResponse.json({ok:true,ignored:true});
    }

    const remoteSub=subEntity||await fetchBillingSubscription(providerSubscriptionId);
    await persistProviderSubscription(local.id,remoteSub,unixToIso(payload?.created_at)||new Date().toISOString());

    if(providerPaymentId&&['subscription.charged','payment.captured','payment.authorized'].includes(eventType)){
      const remotePayment=await fetchBillingPayment(providerPaymentId);
      const {data:existingPayment}=await admin.from('sellora_subscription_payments').select('id,renewal_email_sent_at,status').eq('provider_payment_id',providerPaymentId).maybeSingle();
      await persistSubscriptionPayment(local.id,remotePayment);
      if(eventType==='subscription.charged'&&String(remotePayment.status)==='captured'&&!existingPayment?.renewal_email_sent_at){
        await sendSubscriptionRenewalEmail(local.id,providerPaymentId).catch(error=>console.error('[subscription-renewal-email]',error));
      }
    }

    if(eventType==='subscription.activated'||eventType==='subscription.authenticated')await sendSubscriptionConfirmationEmail(local.id).catch(error=>console.error('[subscription-confirmation-email]',error));
    if(eventType==='subscription.halted')await sendSubscriptionFailureEmail(local.id).catch(error=>console.error('[subscription-failure-email]',error));
    if(eventType==='subscription.cancelled')await sendSubscriptionCancellationEmail(local.id).catch(error=>console.error('[subscription-cancellation-email]',error));

    await admin.from('sellora_subscription_events').update({processed_at:new Date().toISOString(),error_message:null}).eq('provider','razorpay').eq('provider_event_id',providerEventId);
    return NextResponse.json({ok:true});
  }catch(error){
    console.error('[billing-webhook]',error);
    await admin.from('sellora_subscription_events').update({error_message:error instanceof Error?error.message:'Webhook processing failed.'}).eq('provider','razorpay').eq('provider_event_id',providerEventId);
    return NextResponse.json({ok:false,error:'Webhook processing failed.'},{status:500});
  }
}
