import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';
import { getBearerUser, withRateLimit } from '../../../../lib/server-security';
import { getCreatorEntitlements, featureDenied } from '../../../../lib/server-entitlements';
import { hasAnalyticsLevel } from '../../../../lib/entitlements';

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: Request) {
  const limited = withRateLimit(request, 'studio-analytics-export', 10);
  if (limited) return limited;
  try {
    const user = await getBearerUser(request);
    if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const entitlements = await getCreatorEntitlements(user.id);
    if (!hasAnalyticsLevel(entitlements, 'advanced')) return NextResponse.json(featureDenied(entitlements, 'analytics', 'pro'), { status: 403 });
    const url = new URL(request.url);
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days') || 30)));
    const since = new Date();
    since.setDate(since.getDate() - days);
    const db = getAdminSupabase();
    const { data: store } = await db.from('stores').select('id').eq('owner_id', user.id).maybeSingle();
    if (!store) return new NextResponse('event_type,link_id,source,utm_source,utm_medium,utm_campaign,created_at\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8' } });
    const { data, error } = await db.from('store_analytics_events').select('event_type,link_id,product_id,source,utm_source,utm_medium,utm_campaign,utm_content,utm_term,referrer,visitor_id,device_type,country_code,session_id,order_id,created_at').eq('store_id', store.id).gte('created_at', since.toISOString()).order('created_at', { ascending: false }).limit(10000);
    if (error) throw error;
    const headers = ['event_type', 'link_id', 'product_id', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'referrer', 'visitor_id', 'device_type', 'country_code', 'session_id', 'order_id', 'created_at'];
    const rows = [headers, ...(data || []).map(row => headers.map(header => csvCell((row as Record<string, unknown>)[header])))].map(row => row.join(','));
    return new NextResponse(`${rows.join('\n')}\n`, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tablely-analytics-${days}d.csv"`, 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[studio/analytics/export]', error);
    return NextResponse.json({ ok: false, error: 'Could not export analytics.' }, { status: 500 });
  }
}
