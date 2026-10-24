import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';
import { verifySignedMarketingToken } from '../../../../lib/server-email';

function normaliseTarget(rawUrl: string | null) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = verifySignedMarketingToken(url.searchParams.get('token'), 'click');
  const target = normaliseTarget(url.searchParams.get('url'));
  if (!token || !target) return NextResponse.json({ ok: false, error: 'Invalid link.' }, { status: 400 });

  const recipientId = typeof token.recipientId === 'string' ? token.recipientId : null;
  const signedTarget = typeof token.url === 'string' ? normaliseTarget(token.url) : null;
  if (!recipientId || !signedTarget || signedTarget !== target) return NextResponse.json({ ok: false, error: 'Link signature mismatch.' }, { status: 400 });

  const db = getAdminSupabase();
  const { data: recipient } = await db.from('email_campaign_recipients').select('id,subscriber_id,campaign_id').eq('id', recipientId).maybeSingle();
  if (!recipient) return NextResponse.json({ ok: false, error: 'Link expired or invalid.' }, { status: 400 });
  const { data: campaign } = await db.from('email_campaigns').select('store_id').eq('id', recipient.campaign_id).maybeSingle();
  if (!campaign) return NextResponse.json({ ok: false, error: 'Campaign not found.' }, { status: 400 });
  const { data: subscriber } = await db.from('email_subscribers').select('id,store_id').eq('id', recipient.subscriber_id).maybeSingle();
  if (!subscriber || subscriber.store_id !== campaign.store_id) return NextResponse.json({ ok: false, error: 'Link is not valid for this store.' }, { status: 400 });

  await db.from('email_campaign_recipients').update({ clicked_at: new Date().toISOString() }).eq('id', recipient.id).is('clicked_at', null);
  return NextResponse.redirect(target);
}