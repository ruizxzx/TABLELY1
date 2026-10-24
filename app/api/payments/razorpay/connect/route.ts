import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../../../lib/server-admin';
import { assertSameOrigin, getBearerUser, withRateLimit } from '../../../../lib/server-security';
import { encryptPaymentSecret, fingerprintPaymentSecret } from '../../../../lib/payments/credentials';

export const dynamic = 'force-dynamic';

const RAZORPAY_API = 'https://api.razorpay.com/v1';
const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]+$/;
const WEBHOOK_SECRET_MAX = 256;

function fail(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

function inferMode(keyId: string): 'test' | 'live' {
  return keyId.startsWith('rzp_live_') ? 'live' : 'test';
}

async function verifyRazorpayCredentials(keyId: string, keySecret: string) {
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const response = await fetch(`${RAZORPAY_API}/orders?count=1`, {
    method: 'GET',
    headers: { Authorization: `Basic ${auth}` },
    cache: 'no-store',
  });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const detail = body?.error?.description || 'Razorpay rejected these credentials.';
    throw new Error(detail);
  }
  return body;
}

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'razorpay-connect-credentials', 10);
  if (limited) return limited;

  try {
    assertSameOrigin(request);
    const user = await getBearerUser(request);
    if (!user) return fail('Unauthorized.', 401);

    const body = await request.json().catch(() => ({})) as {
      keyId?: unknown;
      keySecret?: unknown;
      webhookSecret?: unknown;
    };

    const keyId = typeof body.keyId === 'string' ? body.keyId.trim() : '';
    const keySecret = typeof body.keySecret === 'string' ? body.keySecret.trim() : '';
    const webhookSecret = typeof body.webhookSecret === 'string' ? body.webhookSecret.trim() : '';

    if (!KEY_ID_RE.test(keyId)) return fail('Enter a valid Razorpay Key ID (rzp_test_... or rzp_live_...).');
    if (keySecret.length < 8 || keySecret.length > 512) return fail('Enter a valid Razorpay Key Secret.');
    if (webhookSecret.length > WEBHOOK_SECRET_MAX) return fail('Webhook secret is too long.');

    const mode = inferMode(keyId);
    if (mode === 'live' && process.env.PAYMENTS_LIVE_ENABLED !== 'true') {
      return fail('Live Razorpay credentials are disabled. Enable live payments only after production setup is complete.', 403);
    }

    const admin = getAdminSupabase();
    const { data: store, error: storeError } = await admin
      .from('stores')
      .select('id')
      .eq('owner_id', user.id)
      .maybeSingle();
    if (storeError) throw storeError;
    if (!store) return fail('Create your storefront before connecting Razorpay.', 409);

    // Validate before replacing an existing connection.
    await verifyRazorpayCredentials(keyId, keySecret);

    const now = new Date().toISOString();
    const { data: previousCurrent, error: previousError } = await admin
      .from('payment_accounts')
      .select('id')
      .eq('creator_id', user.id)
      .eq('store_id', store.id)
      .eq('provider', 'razorpay')
      .eq('payment_model', 'creator_connected')
      .eq('is_current', true)
      .maybeSingle();
    if (previousError) throw previousError;

    // Create the new account as non-current first. This keeps the existing
    // connection usable if database/credential persistence fails halfway through.
    const { data: account, error: accountError } = await admin
      .from('payment_accounts')
      .insert({
        creator_id: user.id,
        store_id: store.id,
        provider: 'razorpay',
        payment_model: 'creator_connected',
        provider_account_id: keyId,
        status: 'connected',
        is_current: false,
        capabilities: {
          orders: true,
          payments: true,
          refunds: true,
          webhooks: Boolean(webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET),
        },
        country: 'IN',
        default_currency: 'INR',
        metadata: {
          connection_method: 'api_credentials',
          mode,
          key_id_fingerprint: fingerprintPaymentSecret(keyId).slice(0, 16),
          updated_from: 'creator_settings',
        },
        last_synced_at: now,
        updated_at: now,
      })
      .select('id,provider,status,provider_account_id,metadata,last_synced_at')
      .single();
    if (accountError) throw accountError;

    const encryptedKeySecret = encryptPaymentSecret(keySecret);
    const encryptedWebhookSecret = webhookSecret ? encryptPaymentSecret(webhookSecret) : null;
    const { error: credentialsError } = await admin
      .from('payment_account_credentials')
      .insert({
        payment_account_id: account.id,
        key_id: keyId,
        encrypted_key_secret: encryptedKeySecret,
        encrypted_webhook_secret: encryptedWebhookSecret,
        mode,
      });
    if (credentialsError) {
      await admin.from('payment_accounts').delete().eq('id', account.id);
      throw credentialsError;
    }

    // Retire the previous current account only after the new credentials are safely stored.
    const { error: retireError } = await admin
      .from('payment_accounts')
      .update({ is_current: false, status: 'disconnected', updated_at: now })
      .eq('creator_id', user.id)
      .eq('store_id', store.id)
      .eq('provider', 'razorpay')
      .eq('payment_model', 'creator_connected')
      .eq('is_current', true)
      .neq('id', account.id);
    if (retireError) {
      await admin.from('payment_account_credentials').delete().eq('payment_account_id', account.id);
      await admin.from('payment_accounts').delete().eq('id', account.id);
      throw retireError;
    }

    const { error: activateError } = await admin
      .from('payment_accounts')
      .update({ is_current: true, status: 'connected', updated_at: now })
      .eq('id', account.id)
      .eq('is_current', false);
    if (activateError) {
      if (previousCurrent?.id) {
        const { error: restoreError } = await admin.from('payment_accounts').update({ is_current: true, status: 'connected', updated_at: new Date().toISOString() }).eq('id', previousCurrent.id);
        if (restoreError) console.error('[razorpay-connect-restore]', restoreError);
      }
      await admin.from('payment_account_credentials').delete().eq('payment_account_id', account.id);
      await admin.from('payment_accounts').delete().eq('id', account.id);
      throw activateError;
    }

    // Legacy OAuth material is not used by Build 3, but historical material remains preserved.

    return NextResponse.json({
      ok: true,
      data: {
        provider: 'razorpay',
        status: 'connected',
        keyId,
        mode,
        webhookConfigured: Boolean(webhookSecret || process.env.RAZORPAY_WEBHOOK_SECRET),
      },
    });
  } catch (error) {
    console.error('[razorpay-connect-credentials]', error);
    return fail(error instanceof Error ? error.message : 'Could not connect Razorpay.', 500);
  }
}
