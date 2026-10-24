import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { verifySignedMarketingToken } from '../../../lib/server-email';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = verifySignedMarketingToken(url.searchParams.get('token'), 'unsubscribe');
  if (!token || typeof token.subscriberId !== 'string' || typeof token.storeId !== 'string') {
    return new NextResponse('Invalid unsubscribe link.', { status: 400 });
  }

  const db = getAdminSupabase();
  const { data: subscriber } = await db.from('email_subscribers').select('id,store_id').eq('id', token.subscriberId).eq('store_id', token.storeId).maybeSingle();
  if (!subscriber) return new NextResponse('Invalid unsubscribe link.', { status: 400 });

  const { error } = await db.from('email_subscribers').update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() }).eq('id', subscriber.id).eq('store_id', subscriber.store_id);
  if (error) return new NextResponse('Could not process unsubscribe.', { status: 500 });
  return new NextResponse('<!doctype html><html><body><h1>You are unsubscribed</h1><p>You will not receive further marketing emails from this creator.</p></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}