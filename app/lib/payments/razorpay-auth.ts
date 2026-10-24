import { getAdminSupabase } from '../server-admin';
import { decryptPaymentSecret } from './credentials';
import type { ProviderAuth } from './types';

/**
 * Returns the active server-side credential set for a creator payment account.
 * Build 3 uses creator-provided API credentials only. OAuth is intentionally deferred.
 */
export async function getCreatorAuth(paymentAccountId: string): Promise<ProviderAuth> {
  const admin = getAdminSupabase();
  const { data: apiCreds, error } = await admin
    .from('payment_account_credentials')
    .select('key_id,encrypted_key_secret,encrypted_webhook_secret,mode')
    .eq('payment_account_id', paymentAccountId)
    .maybeSingle();

  if (error) throw error;

  if (apiCreds) {
    let keySecret: string;
    let webhookSecret: string | undefined;
    try {
      keySecret = decryptPaymentSecret(String(apiCreds.encrypted_key_secret));
      if (apiCreds.encrypted_webhook_secret) {
        webhookSecret = decryptPaymentSecret(String(apiCreds.encrypted_webhook_secret));
      }
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'Stored Razorpay credentials could not be decrypted.');
    }
    if (!apiCreds.key_id || !keySecret) throw new Error('Razorpay API credentials are incomplete. Reconnect Razorpay.');
    return {
      apiKeyId: String(apiCreds.key_id),
      apiKeySecret: keySecret,
      webhookSecret,
      authMode: 'api_credentials',
    };
  }

  throw new Error('PAYMENT_ACCOUNT_NOT_CONNECTED');
}
