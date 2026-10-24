import { randomUUID } from 'node:crypto';
import { getAdminSupabase } from './server-admin';

export function classifySource(value: string | null | undefined, referrer: string | null | undefined) {
  const raw = `${value || ''}`.toLowerCase();
  if (raw.includes('instagram')) return 'instagram';
  if (raw.includes('whatsapp')) return 'whatsapp';
  if (raw.includes('telegram')) return 'telegram';
  if (raw.includes('youtube')) return 'youtube';
  if (raw) return raw.slice(0, 40);
  try {
    if (referrer) { const host = new URL(referrer).hostname.toLowerCase(); if (host.includes('instagram')) return 'instagram'; if (host.includes('whatsapp')) return 'whatsapp'; if (host.includes('telegram')) return 'telegram'; if (host.includes('youtube')) return 'youtube'; }
  } catch {}
  return 'direct';
}

export async function trackEvent(input: { storeId: string; productId?: string | null; linkId?: string | null; eventType: 'visit'|'link_click'|'product_view'|'checkout_start'|'purchase'|'email_subscribe'; source?: string; utmSource?: string | null; utmMedium?: string | null; utmCampaign?: string | null; utmContent?: string | null; utmTerm?: string | null; referrer?: string | null; visitorId?: string | null; deviceType?: string | null; countryCode?: string | null; sessionId?: string | null; orderId?: string | null; checkoutId?: string | null; eventId?: string | null }) {
  const admin = getAdminSupabase();
  const { error } = await admin.from('store_analytics_events').insert({ store_id: input.storeId, product_id: input.productId || null, link_id: input.linkId || null, event_id: input.eventId || `server:${input.eventType}:${randomUUID()}`, event_type: input.eventType, source: input.source || 'direct', utm_source: input.utmSource || null, utm_medium: input.utmMedium || null, utm_campaign: input.utmCampaign || null, utm_content: input.utmContent || null, utm_term: input.utmTerm || null, referrer: input.referrer || null, visitor_id: input.visitorId || null, device_type: input.deviceType || null, country_code: input.countryCode || null, session_id: input.sessionId || null, order_id: input.orderId || null, checkout_id: input.checkoutId || null });
  if (error) throw error;
}
