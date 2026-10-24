'use client';

import { useEffect, useRef } from 'react';
import { createAnalyticsEventId, getAnalyticsAttribution, getAnalyticsIdentity } from '../lib/analytics-client';

export default function BentoPublicViewBeacon({ storeId }: { storeId: string }) {
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    const { visitorId, sessionId } = getAnalyticsIdentity();
    const attribution = getAnalyticsAttribution();
    const body = JSON.stringify({
      storeId,
      eventType: 'visit',
      eventId: createAnalyticsEventId('visit'),
      ...attribution,
      sessionId,
      visitorId,
    });
    try {
      if (navigator.sendBeacon) {
        const queued = navigator.sendBeacon('/api/analytics/event', new Blob([body], { type: 'application/json' }));
        if (queued) return;
      }
    } catch {}
    void fetch('/api/analytics/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => undefined);
  }, [storeId]);
  return null;
}
