import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { getBearerUser, withRateLimit } from '../../../lib/server-security';
import { getCreatorEntitlements, featureDenied, analyticsRank } from '../../../lib/server-entitlements';

export const dynamic = 'force-dynamic';

function normalizeLabel(value: unknown, fallback: string) {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function getLinkNameMap(config: unknown) {
  const map = new Map<string, string>();
  const source = config && typeof config === 'object' ? config as Record<string, unknown> : {};
  const linkList = Array.isArray(source.links) ? source.links : [];
  const blockList = Array.isArray(source.blocks) ? source.blocks : [];

  for (const item of [...linkList, ...blockList]) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as Record<string, unknown>).id ?? '').trim();
    if (!id) continue;
    const label = normalizeLabel((item as Record<string, unknown>).label, '');
    const title = normalizeLabel((item as Record<string, unknown>).title, '');
    const name = normalizeLabel((item as Record<string, unknown>).name, '');
    const resolved = label || title || name || 'Unnamed link';
    map.set(id, resolved);
  }

  return map;
}

function asNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildTrendBuckets(events: Array<Record<string, unknown>>) {
  const buckets = new Map<string, { visits: number; clicks: number; checkouts: number; purchases: number; revenue: number }>();
  const today = new Date();
  const offset = 89;
  for (let index = 0; index <= offset; index += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - (offset - index));
    const key = date.toISOString().slice(0, 10);
    buckets.set(key, { visits: 0, clicks: 0, checkouts: 0, purchases: 0, revenue: 0 });
  }

  for (const event of events) {
    const eventType = String(event.event_type ?? '');
    const createdAt = String(event.created_at ?? '');
    const key = createdAt.slice(0, 10);
    if (!buckets.has(key)) {
      buckets.set(key, { visits: 0, clicks: 0, checkouts: 0, purchases: 0, revenue: 0 });
    }
    const bucket = buckets.get(key)!;
    if (eventType === 'visit') bucket.visits += 1;
    if (eventType === 'link_click') bucket.clicks += 1;
    if (eventType === 'checkout_start') bucket.checkouts += 1;
    if (eventType === 'purchase') bucket.purchases += 1;
  }

  return [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => ({ date, ...value }));
}

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'studio-analytics', 60);
  if (limited) return limited;
  try {
    const user = await getBearerUser(request);
    if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const entitlements = await getCreatorEntitlements(user.id);
    const days = Math.max(1, Math.min(90, Number(new URL(request.url).searchParams.get('days') || 30)));
    const requestedLevel = new URL(request.url).searchParams.get('level');
    const requested = requestedLevel === 'advanced' ? 'advanced' : requestedLevel === 'standard' ? 'standard' : 'basic';
    if (analyticsRank(entitlements.analyticsLevel) < analyticsRank(requested)) {
      return NextResponse.json(featureDenied(entitlements, 'analytics', requested === 'advanced' ? 'pro' : 'creator'), { status: 403 });
    }

    const db = getAdminSupabase();
    const { data: store, error: storeError } = await db.from('stores').select('id,link_hub_config').eq('owner_id', user.id).maybeSingle();
    if (storeError) throw storeError;
    if (!store) {
      return NextResponse.json({
        ok: true,
        data: {
          level: entitlements.analyticsLevel,
          events: [],
          orders: [],
          summary: {
            pageViews: 0,
            linkClicks: 0,
            ctr: null,
            productsSold: 0,
            revenue: 0,
            conversionRate: null,
            aov: null,
            uniqueVisitors: 0,
            devices: [],
            countries: [],
            sources: [],
            referrers: [],
            trend: [],
            topLinks: [],
            utmReport: [],
            linkPerformance: [],
            revenueBreakdown: { bySource: [], byLink: [], byCampaign: [], byProduct: [], unattributed: 0 },
            attribution: { model: 'visitor/session → source/link → checkout → purchase', notes: 'No attribution data is available yet.' }
          }
        }
      });
    }

    const since = new Date();
    if (days === 1) since.setHours(0, 0, 0, 0); else since.setDate(since.getDate() - days);

    const [{ data: events, error: eventError }, { data: orders, error: orderError }] = await Promise.all([
      db.from('store_analytics_events').select('event_type,link_id,product_id,source,utm_source,utm_medium,utm_campaign,utm_content,utm_term,referrer,visitor_id,session_id,device_type,country_code,order_id,created_at').eq('store_id', store.id).gte('created_at', since.toISOString()).order('created_at', { ascending: false }),
      db.from('orders').select('id,product_id,gross_amount,currency,status,created_at,products(title)').eq('store_id', store.id).gte('created_at', since.toISOString()).order('created_at', { ascending: false }),
    ]);

    if (eventError) throw eventError;
    if (orderError) throw orderError;

    const allowedEventTypes: Record<'basic' | 'standard' | 'advanced', Set<string> | null> = {
      basic: new Set(['visit', 'product_view']),
      standard: new Set(['visit', 'link_click', 'product_view', 'checkout_start', 'email_subscribe']),
      advanced: null,
    };

    const linkNameMap = getLinkNameMap(store.link_hub_config);
    const permittedEvents = (events || []).filter((event) => {
      const allowed = allowedEventTypes[entitlements.analyticsLevel];
      if (!allowed) return true;
      return allowed.has(String(event.event_type));
    });

    const paidOrders = (orders || []).filter((order: any) => String(order.status || '').toLowerCase() === 'paid');
    const totalRevenue = paidOrders.reduce((sum: number, order: any) => sum + asNumber(order.gross_amount), 0);
    const pageViews = permittedEvents.filter((event) => event.event_type === 'visit').length;
    const linkClicks = permittedEvents.filter((event) => event.event_type === 'link_click').length;
    const checkoutStarts = permittedEvents.filter((event) => event.event_type === 'checkout_start').length;
    const purchases = paidOrders.length;
    const ctr = pageViews ? (linkClicks / pageViews) * 100 : null;
    const conversionRate = checkoutStarts ? (purchases / checkoutStarts) * 100 : null;
    const aov = paidOrders.length ? totalRevenue / paidOrders.length : null;
    const uniqueVisitors = [...new Set(permittedEvents.map((event: any) => event.visitor_id).filter(Boolean))].length;

    const sourceMap = new Map<string, number>();
    const referrerMap = new Map<string, number>();
    const deviceMap = new Map<string, number>();
    const countryMap = new Map<string, number>();
    const linkClickMap = new Map<string, number>();
    const linkCheckoutMap = new Map<string, number>();
    const linkPurchaseMap = new Map<string, number>();
    const linkRevenueMap = new Map<string, number>();
    const productRevenueMap = new Map<string, number>();
    const productCountMap = new Map<string, number>();
    const sourceRevenueMap = new Map<string, number>();
    const campaignRevenueMap = new Map<string, number>();
    const sourceOrderCountMap = new Map<string, number>();
    const sourceOrderRevenueMap = new Map<string, number>();
    const utmMap = new Map<string, { visits: number; clicks: number; checkouts: number; purchases: number; revenue: number; }>();

    for (const event of permittedEvents) {
      const source = String(event.source || 'direct');
      const referrer = String(event.referrer || 'Direct / unknown');
      const device = String(event.device_type || 'unknown');
      const country = String(event.country_code || 'Unknown');

      sourceMap.set(source, (sourceMap.get(source) || 0) + 1);
      referrerMap.set(referrer, (referrerMap.get(referrer) || 0) + 1);
      deviceMap.set(device, (deviceMap.get(device) || 0) + 1);
      countryMap.set(country, (countryMap.get(country) || 0) + 1);

      if (event.event_type === 'link_click' && event.link_id) {
        const linkKey = String(event.link_id);
        const label = linkNameMap.get(linkKey) || 'Unlabeled link';
        linkClickMap.set(label, (linkClickMap.get(label) || 0) + 1);
      }

      if (event.event_type === 'checkout_start' && event.link_id) {
        const linkKey = String(event.link_id);
        const label = linkNameMap.get(linkKey) || 'Unlabeled link';
        linkCheckoutMap.set(label, (linkCheckoutMap.get(label) || 0) + 1);
      }

      if (event.event_type === 'purchase' && event.link_id) {
        const linkKey = String(event.link_id);
        const label = linkNameMap.get(linkKey) || 'Unlabeled link';
        linkPurchaseMap.set(label, (linkPurchaseMap.get(label) || 0) + 1);
      }

      const utmKey = `${event.utm_source || 'unknown'}|${event.utm_medium || 'unknown'}|${event.utm_campaign || 'none'}|${event.utm_content || 'none'}|${event.utm_term || 'none'}`;
      const utmEntry = utmMap.get(utmKey) || { visits: 0, clicks: 0, checkouts: 0, purchases: 0, revenue: 0 };
      if (event.event_type === 'visit') utmEntry.visits += 1;
      if (event.event_type === 'link_click') utmEntry.clicks += 1;
      if (event.event_type === 'checkout_start') utmEntry.checkouts += 1;
      if (event.event_type === 'purchase') utmEntry.purchases += 1;
      utmMap.set(utmKey, utmEntry);
    }

    const purchaseByOrder = new Map<string, { source: string; linkId: string | null; campaign: string | null; revenue: number; productId: string | null; }>();
    for (const event of permittedEvents) {
      if (event.event_type !== 'purchase' || !event.order_id) continue;
      const order = paidOrders.find((item: any) => String(item.id) === String(event.order_id));
      const revenueAmount = order ? asNumber(order.gross_amount) : 0;
      purchaseByOrder.set(String(event.order_id), {
        source: String(event.source || 'direct'),
        linkId: event.link_id ? String(event.link_id) : null,
        campaign: event.utm_campaign ? String(event.utm_campaign) : null,
        revenue: revenueAmount,
        productId: order ? (order.product_id ? String(order.product_id) : null) : null,
      });
    }

    for (const [orderId, purchase] of purchaseByOrder) {
      const revenueAmount = purchase.revenue;
      if (purchase.source) sourceRevenueMap.set(purchase.source, (sourceRevenueMap.get(purchase.source) || 0) + revenueAmount);
      if (purchase.campaign) campaignRevenueMap.set(purchase.campaign, (campaignRevenueMap.get(purchase.campaign) || 0) + revenueAmount);
      if (purchase.linkId) {
        const label = linkNameMap.get(String(purchase.linkId)) || 'Unlabeled link';
        linkRevenueMap.set(label, (linkRevenueMap.get(label) || 0) + revenueAmount);
      }
      if (purchase.productId) {
        const productOrder = paidOrders.find((order: any) => String(order.product_id) === String(purchase.productId));
        const productsValue = productOrder && (productOrder as any).products;
        const productTitleValue = Array.isArray(productsValue) ? (productsValue[0] as any)?.title : (productsValue as any)?.title;
        const productTitle = String(productTitleValue || 'Deleted product');
        productRevenueMap.set(productTitle, (productRevenueMap.get(productTitle) || 0) + revenueAmount);
        productCountMap.set(productTitle, (productCountMap.get(productTitle) || 0) + 1);
      }
    }

    for (const order of paidOrders) {
      const source = String((permittedEvents.find((event: any) => event.order_id === order.id && event.event_type === 'purchase') as any)?.source || 'direct');
      sourceOrderCountMap.set(source, (sourceOrderCountMap.get(source) || 0) + 1);
      sourceOrderRevenueMap.set(source, (sourceOrderRevenueMap.get(source) || 0) + asNumber(order.gross_amount));
    }

    const sortedSources = [...sourceMap.entries()].sort((a, b) => b[1] - a[1]);
    const sortedReferrers = [...referrerMap.entries()].sort((a, b) => b[1] - a[1]);
    const sortedDevices = [...deviceMap.entries()].sort((a, b) => b[1] - a[1]);
    const sortedCountries = [...countryMap.entries()].sort((a, b) => b[1] - a[1]);
    const sortedLinkClicks = [...linkClickMap.entries()].sort((a, b) => b[1] - a[1]);
    const totalClickVolume = sortedLinkClicks.reduce((sum, [, value]) => sum + value, 0);
    const topLinks = sortedLinkClicks.slice(0, 8).map(([label, clicks]) => ({ label, clicks, ctr: pageViews ? (clicks / Math.max(pageViews, 1)) * 100 : 0, checkouts: linkCheckoutMap.get(label) || 0, purchases: linkPurchaseMap.get(label) || 0, revenue: linkRevenueMap.get(label) || 0 }));

    const utmReport = [...utmMap.entries()].map(([key, values]) => {
      const [utmSource, utmMedium, utmCampaign, utmContent, utmTerm] = key.split('|');
      const totalVisits = values.visits || 0;
      const totalClicks = values.clicks || 0;
      const conversion = totalClicks ? (values.purchases / totalClicks) * 100 : totalVisits ? (values.purchases / totalVisits) * 100 : 0;
      return {
        utm_source: utmSource || 'unknown',
        utm_medium: utmMedium || 'unknown',
        utm_campaign: utmCampaign || 'none',
        utm_content: utmContent || 'none',
        utm_term: utmTerm || 'none',
        visits: totalVisits,
        clicks: totalClicks,
        checkouts: values.checkouts,
        purchases: values.purchases,
        revenue: values.revenue,
        conversion: Number.isFinite(conversion) ? conversion : 0,
      };
    }).sort((a, b) => b.revenue - a.revenue || b.purchases - a.purchases);

    const earningsBySource = [...sourceRevenueMap.entries()].sort((a, b) => b[1] - a[1]).map(([source, revenue]) => ({ source, revenue, share: totalRevenue ? (revenue / totalRevenue) * 100 : 0, orders: sourceOrderCountMap.get(source) || 0 }));
    const earningsByLink = [...linkRevenueMap.entries()].sort((a, b) => b[1] - a[1]).map(([label, revenue]) => ({ label, revenue, share: totalRevenue ? (revenue / totalRevenue) * 100 : 0, purchases: linkPurchaseMap.get(label) || 0 }));
    const earningsByCampaign = [...campaignRevenueMap.entries()].sort((a, b) => b[1] - a[1]).map(([campaign, revenue]) => ({ campaign: campaign || 'Untitled campaign', revenue, share: totalRevenue ? (revenue / totalRevenue) * 100 : 0, purchases: utmReport.filter((row) => row.utm_campaign === campaign).reduce((sum, row) => sum + row.purchases, 0) }));
    const earningsByProduct = [...productRevenueMap.entries()].sort((a, b) => b[1] - a[1]).map(([title, revenue]) => ({ title, revenue, share: totalRevenue ? (revenue / totalRevenue) * 100 : 0, units: productCountMap.get(title) || 0 }));

    const unattributedRevenue = paidOrders.reduce((sum: number, order: any) => {
      const orderEvents = permittedEvents.filter((event: any) => event.order_id === order.id && event.event_type === 'purchase');
      const hasSource = orderEvents.some((event: any) => event.source && String(event.source).trim() && String(event.source) !== 'direct');
      const hasLink = orderEvents.some((event: any) => event.link_id && String(event.link_id).trim());
      const hasCampaign = orderEvents.some((event: any) => event.utm_campaign && String(event.utm_campaign).trim());
      if (!hasSource && !hasLink && !hasCampaign) return sum + asNumber(order.gross_amount);
      return sum;
    }, 0);

    const hybridRows = sortedLinkClicks.map(([label, clicks]) => ({
      label,
      clicks,
      ctr: totalClickVolume ? (clicks / totalClickVolume) * 100 : 0,
      checkouts: linkCheckoutMap.get(label) || 0,
      purchases: linkPurchaseMap.get(label) || 0,
      revenue: linkRevenueMap.get(label) || 0,
    }));

    const summary = {
      pageViews,
      linkClicks,
      ctr,
      productsSold: paidOrders.length,
      revenue: totalRevenue,
      conversionRate,
      aov,
      uniqueVisitors,
      devices: sortedDevices,
      countries: sortedCountries,
      sources: sortedSources,
      referrers: sortedReferrers,
      trend: buildTrendBuckets(permittedEvents as Array<Record<string, unknown>>),
      topLinks: topLinks,
      utmReport,
      linkPerformance: hybridRows,
      revenueBreakdown: {
        bySource: earningsBySource,
        byLink: earningsByLink,
        byCampaign: earningsByCampaign,
        byProduct: earningsByProduct,
        unattributed: unattributedRevenue,
      },
      attribution: {
        model: 'visitor/session → source/link → checkout → purchase',
        notes: purchases === 0 ? 'No completed purchases were attributed in the selected window.' : 'Attribution uses the stored source, link, and order metadata captured at checkout and purchase time.',
      }
    };

    return NextResponse.json({
      ok: true,
      data: {
        planKey: entitlements.planKey,
        level: entitlements.analyticsLevel,
        events: permittedEvents,
        orders: orders || [],
        summary,
      }
    });
  } catch (error) {
    console.error('[studio/analytics]', error);
    return NextResponse.json({ ok: false, error: 'Could not load analytics.' }, { status: 500 });
  }
}
