import { NextResponse } from 'next/server';
import { getRestaurantPaymentSettings, resolveRazorpayCredentials } from '@/lib/restaurant-payment';
import { resolveServerRestaurantAccess } from '@/lib/server-restaurant';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { branchId?: string; scope?: 'branch' | 'organization'; keyId?: string; keySecret?: string; webhookSecret?: string };
  const scope = body.scope === 'organization' ? 'organization' : 'branch';
  const resolved = await resolveServerRestaurantAccess({ branchId: body.branchId, permission: 'PAYMENTS', ownerOnly: scope === 'organization' });
  if ('error' in resolved) return resolved.error;
  const { access } = resolved;
  if (scope === 'organization' && access.context.staff.role !== 'OWNER') return NextResponse.json({ error: 'Owner access is required.' }, { status: 403 });
  const { data: paymentFeature, error: entitlementError } = await access.supabase.rpc('organization_has_feature', { p_organization_id: access.context.organization.id, p_feature: 'ONLINE_PAYMENTS' });
  if (entitlementError || paymentFeature !== true) return NextResponse.json({ error: 'Online payment setup is not available on the current TABLELY plan.' }, { status: 403 });
  if (typeof body.keyId === 'string' && body.keyId.length > 120 || typeof body.keySecret === 'string' && body.keySecret.length > 300) return NextResponse.json({ error: 'Razorpay credentials exceed the allowed length.' }, { status: 400 });

  try {
    const settings = await getRestaurantPaymentSettings(access.admin, access.context.organization.id, scope === 'branch' ? access.branchId : undefined);
    const credentials = resolveRazorpayCredentials(settings);
    const keyId = String(body.keyId ?? credentials.keyId).trim();
    const secret = String(body.keySecret ?? '').trim() || credentials.secret;
    if (!keyId || !secret) {
      return NextResponse.json({ ok: false, credentialStatus: 'INCOMPLETE', webhookConfigured: Boolean(credentials.webhook),
      webhookSecretProvided: Boolean(String(body.webhookSecret ?? '').trim()), message: 'Save a Razorpay Key ID and Key Secret before testing the connection.' }, { status: 422 });
    }
    const authorization = Buffer.from(`${keyId}:${secret}`).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders?count=1', {
      method: 'GET',
      headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 401 || response.status === 403) {
      return NextResponse.json({ ok: false, credentialStatus: 'INVALID', webhookConfigured: Boolean(credentials.webhook),
      webhookSecretProvided: Boolean(String(body.webhookSecret ?? '').trim()), message: 'Razorpay rejected these credentials. Check the Key ID, Key Secret and environment.' }, { status: 422 });
    }
    if (!response.ok) {
      return NextResponse.json({ ok: false, credentialStatus: 'UNVERIFIED', webhookConfigured: Boolean(credentials.webhook),
      webhookSecretProvided: Boolean(String(body.webhookSecret ?? '').trim()), message: `Razorpay returned HTTP ${response.status}. Credentials could not be verified; check account access and try again.` }, { status: 503 });
    }
    return NextResponse.json({
      ok: true,
      credentialStatus: 'CONNECTED',
      environment: keyId.startsWith('rzp_test_') ? 'TEST' : keyId.startsWith('rzp_live_') ? 'LIVE' : 'UNKNOWN',
      webhookConfigured: Boolean(credentials.webhook),
      webhookSecretProvided: Boolean(String(body.webhookSecret ?? '').trim()),
      webhookStatus: 'NOT_TESTED',
      message: 'Razorpay API credentials are valid. Webhook delivery is configured separately and has not been tested by this request.',
    });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Razorpay did not respond before the connection test timed out.'
      : 'Could not reach Razorpay. Check server network access and try again.';
    return NextResponse.json({ ok: false, credentialStatus: 'UNVERIFIED', message }, { status: 503 });
  }
}
