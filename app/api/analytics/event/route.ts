import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getAdminSupabase } from '../../../lib/server-admin';
import { classifySource } from '../../../lib/server-analytics';
import { withRateLimit } from '../../../lib/server-security';

const allowed = new Set(['visit','link_click','product_view','checkout_start']);
const obviousBotPattern = /bot\b|crawler|spider|slurp|bingpreview|facebookexternalhit|meta-externalagent|twitterbot|linkedinbot|embedly|headlesschrome|phantomjs|lighthouse/i;

function isObviousBot(userAgent: string) {
  return Boolean(userAgent && obviousBotPattern.test(userAgent));
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'analytics-event', 240);
  if (limited) return limited;
  try {
    const body = await request.json() as Record<string, unknown>;
    const storeId = typeof body.storeId === 'string' ? body.storeId : '';
    const productId = typeof body.productId === 'string' ? body.productId : null;
    const linkId = typeof body.linkId === 'string' ? body.linkId.slice(0, 80) : null;
    const eventType = typeof body.eventType === 'string' ? body.eventType : '';
    if (!storeId || !allowed.has(eventType)) return NextResponse.json({ ok: false, error: 'Invalid analytics event.' }, { status: 400 });

    const userAgent = request.headers.get('user-agent') || '';
    if (isObviousBot(userAgent)) return NextResponse.json({ ok: true, filtered: true });

    const admin = getAdminSupabase();
    const { data: store } = await admin.from('stores').select('id,status,link_hub_config').eq('id', storeId).maybeSingle();
    if (!store || store.status !== 'active') return NextResponse.json({ ok: false, error: 'Store unavailable.' }, { status: 404 });

    if (productId && (eventType === 'product_view' || eventType === 'checkout_start')) {
      const { data: product } = await admin.from('public_products').select('id').eq('id', productId).eq('store_id', storeId).maybeSingle();
      if (!product) return NextResponse.json({ ok: false, error: 'Unknown product.' }, { status: 400 });
    }

    const config = store.link_hub_config && typeof store.link_hub_config === 'object' ? store.link_hub_config as Record<string, unknown> : {};
    if (linkId && eventType === 'link_click') {
      const links = Array.isArray(config.links) ? config.links : [];
      const blocks = Array.isArray(config.blocks) ? config.blocks : [];
      const known = [...links, ...blocks].some((item: any) => String(item?.id || '') === linkId);
      if (!known) return NextResponse.json({ ok: false, error: 'Unknown link.' }, { status: 400 });
    }

    const eventId = typeof body.eventId === 'string' && body.eventId.trim() ? body.eventId.trim().slice(0, 160) : `api:${eventType}:${randomUUID()}`;
    const deviceType = /tablet/i.test(userAgent) ? 'tablet' : /mobile|android|iphone|ipad/i.test(userAgent) ? 'mobile' : 'desktop';
    const countryCode = request.headers.get('x-vercel-ip-country') || request.headers.get('cf-ipcountry') || null;
    const { error } = await admin.from('store_analytics_events').insert({
      store_id: storeId,
      product_id: productId,
      link_id: linkId,
      event_id: eventId,
      event_type: eventType,
      source: classifySource(typeof body.utmSource === 'string' ? body.utmSource : '', typeof body.referrer === 'string' ? body.referrer : null),
      utm_source: typeof body.utmSource === 'string' ? body.utmSource.slice(0,100) : null,
      utm_medium: typeof body.utmMedium === 'string' ? body.utmMedium.slice(0,100) : null,
      utm_campaign: typeof body.utmCampaign === 'string' ? body.utmCampaign.slice(0,100) : null,
      utm_content: typeof body.utmContent === 'string' ? body.utmContent.slice(0,100) : null,
      utm_term: typeof body.utmTerm === 'string' ? body.utmTerm.slice(0,100) : null,
      referrer: typeof body.referrer === 'string' ? body.referrer.slice(0,500) : null,
      visitor_id: typeof body.visitorId === 'string' ? body.visitorId.slice(0,120) : null,
      device_type: deviceType,
      country_code: countryCode?.slice(0,2).toUpperCase() || null,
      session_id: typeof body.sessionId === 'string' ? body.sessionId.slice(0,120) : null,
      checkout_id: typeof body.checkoutId === 'string' ? body.checkoutId.slice(0,120) : null,
    });
    if (error) {
      if (String((error as any).code || '') === '23505') return NextResponse.json({ ok: true, duplicate: true });
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true });
  }
}
