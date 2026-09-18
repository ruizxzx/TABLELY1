import { NextResponse } from 'next/server';
import { requireSubscriptionViewer } from '@/lib/subscription-access';
export async function GET(){try{const x=await requireSubscriptionViewer();if('error' in x)return x.error;const{data,error}=await x.supabase.rpc('get_subscription_payment_history');if(error)return NextResponse.json({error:'Could not load subscription history.'},{status:500});return NextResponse.json({history:data??[]});}catch(error:unknown){console.error('subscriptions/history failed',error);return NextResponse.json({error:'Could not load subscription history.'},{status:500});}}
