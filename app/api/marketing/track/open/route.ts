import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';
import { verifySignedMarketingToken } from '../../../../lib/server-email';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = verifySignedMarketingToken(url.searchParams.get('token'), 'open');
  if (token && typeof token.recipientId === 'string') {
    const db = getAdminSupabase();
    const { data: recipient } = await db.from('email_campaign_recipients').select('id,campaign_id,subscriber_id').eq('id', token.recipientId).maybeSingle();
    if (recipient) {
      const { data: campaign } = await db.from('email_campaigns').select('store_id').eq('id', recipient.campaign_id).maybeSingle();
      const { data: subscriber } = await db.from('email_subscribers').select('id,store_id').eq('id', recipient.subscriber_id).maybeSingle();
      if (campaign && subscriber && subscriber.store_id === campaign.store_id) {
        await db.from('email_campaign_recipients').update({ opened_at: new Date().toISOString() }).eq('id', recipient.id).is('opened_at', null);
      }
    }
  }
  return new NextResponse(pixel, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
}