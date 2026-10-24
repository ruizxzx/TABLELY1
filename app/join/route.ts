import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const code = (request.nextUrl.searchParams.get('ref') ?? '').trim().toUpperCase();
  const destination = new URL('/signup', request.url);
  const admin = getSupabaseAdminClient();
  if (!admin || !/^TL-[A-F0-9]{10}$/.test(code)) return NextResponse.redirect(destination);
  const { data: partner } = await admin.from('tablely_partners').select('id,status').eq('partner_code', code).maybeSingle();
  if (!partner || partner.status !== 'APPROVED') return NextResponse.redirect(new URL('/partners?ref=inactive', request.url));

  const priorToken=request.cookies.get('tablely_referral_tracking')?.value;
  let firstPartyToken:string|null=null;
  if(priorToken){
    const {data:prior}=await admin.from('tablely_referral_clicks').select('tracking_id').eq('tracking_id',priorToken).gt('expires_at',new Date().toISOString()).is('claimed_at',null).maybeSingle();
    firstPartyToken=prior?.tracking_id??null;
  }
  const trackingId = crypto.randomUUID();
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const fingerprintSecret = process.env.TABLELY_REFERRAL_HASH_KEY ?? process.env.SUPABASE_SECRET_KEY ?? 'tablely-referral-v1';
  const ipFingerprint = forwarded ? createHash('sha256').update(`${fingerprintSecret}:${forwarded}`).digest('hex') : null;
  const query = Object.fromEntries([...request.nextUrl.searchParams.entries()].filter(([key]) => /^utm_(source|medium|campaign|term|content)$/.test(key)));
  const { error } = await admin.from('tablely_referral_clicks').insert({
    tracking_id: trackingId,
    partner_id: partner.id,
    landing_path: '/join',
    referrer_host: request.headers.get('referer') ? new URL(request.headers.get('referer')!).hostname : null,
    campaign: query,
    ip_fingerprint: ipFingerprint,
    user_agent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
  });
  if (error) return NextResponse.redirect(destination);
  const response = NextResponse.redirect(destination);
  if(!firstPartyToken)response.cookies.set('tablely_referral_tracking', trackingId, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
