'use client';
import { useEffect, useRef } from 'react';
import { createAnalyticsEventId, getAnalyticsAttribution, getAnalyticsIdentity } from '../lib/analytics-client';

export default function AnalyticsBeacon({ storeId, productId, eventType, capture = false }: { storeId: string; productId?: string; eventType: 'visit'|'product_view'|'checkout_start'; capture?: boolean }) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    const { visitorId, sessionId } = getAnalyticsIdentity();
    const { utmSource, utmMedium, utmCampaign, utmContent, utmTerm, referrer } = getAnalyticsAttribution();
    const raw = `${utmSource || ''} ${referrer || ''}`.toLowerCase();
    const source = raw.includes('instagram') ? 'instagram' : raw.includes('whatsapp') ? 'whatsapp' : raw.includes('telegram') ? 'telegram' : raw.includes('youtube') ? 'youtube' : utmSource || 'direct';
    void fetch('/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeId,
        productId: productId || null,
        eventType,
        eventId: createAnalyticsEventId(eventType),
        source,
        utmSource,
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        referrer,
        visitorId,
        sessionId,
      }),
    }).catch(() => undefined);
  }, [storeId, productId, eventType]);

  void capture;
  return null;
}
