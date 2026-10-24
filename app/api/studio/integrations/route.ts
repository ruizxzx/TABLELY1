import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../lib/server-admin';
import { assertSameOrigin, getBearerUser, withRateLimit } from '../../../lib/server-security';
import { getCreatorEntitlements, featureDenied } from '../../../lib/server-entitlements';

const providers = new Set(['google_analytics', 'meta_pixel', 'tiktok_pixel']);
export async function GET(request: Request) {
  const limited = withRateLimit(request, 'studio-integrations-read', 30); if (limited) return limited;
  const user = await getBearerUser(request); if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  const entitlements = await getCreatorEntitlements(user.id); if (!entitlements.features.analytics_integrations) return NextResponse.json(featureDenied(entitlements, 'analytics_integrations', 'max'), { status: 403 });
  const db = getAdminSupabase(); const { data: store } = await db.from('stores').select('id').eq('owner_id', user.id).maybeSingle();
  const { data, error } = store ? await db.from('analytics_integrations').select('provider,measurement_id,enabled').eq('store_id', store.id) : { data: [], error: null };
  if (error) return NextResponse.json({ ok: false, error: 'Could not load integrations.' }, { status: 500 });
  return NextResponse.json({ ok: true, data: data || [] });
}
export async function POST(request: Request) {
  const limited = withRateLimit(request, 'studio-integrations-write', 20); if (limited) return limited;
  try {
    assertSameOrigin(request); const user = await getBearerUser(request); if (!user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const entitlements = await getCreatorEntitlements(user.id); if (!entitlements.features.analytics_integrations) return NextResponse.json(featureDenied(entitlements, 'analytics_integrations', 'max'), { status: 403 });
    const body = await request.json() as Record<string, unknown>; const provider = String(body.provider || ''); const measurementId = String(body.measurementId || '').trim().slice(0, 160); if (!providers.has(provider) || !measurementId) return NextResponse.json({ ok: false, error: 'Choose a supported provider and measurement ID.' }, { status: 400 });
    const db = getAdminSupabase(); const { data: store } = await db.from('stores').select('id').eq('owner_id', user.id).maybeSingle(); if (!store) return NextResponse.json({ ok: false, error: 'Store not found.' }, { status: 404 });
    const { data, error } = await db.from('analytics_integrations').upsert({ store_id: store.id, provider, measurement_id: measurementId, enabled: body.enabled !== false, updated_at: new Date().toISOString() }, { onConflict: 'store_id,provider' }).select('provider,measurement_id,enabled').single();
    if (error) throw error; return NextResponse.json({ ok: true, data });
  } catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Could not save integration.' }, { status: 500 }); }
}