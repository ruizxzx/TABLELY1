import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null | undefined;

function createSecretKeyClient(url: string, secretKey: string) {
  // Supabase's new sb_secret_* keys are API keys, not JWT bearer tokens.
  // supabase-js can still use them through createClient, but the secret key
  // must be sent in the apikey header instead of Authorization: Bearer <key>.
  const fetchWithSecretKey: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const authorization = headers.get('authorization');
    if (authorization && authorization.toLowerCase() === `bearer ${secretKey}`.toLowerCase()) {
      headers.delete('authorization');
    }
    headers.set('apikey', secretKey);
    return fetch(input, { ...init, headers });
  };

  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: fetchWithSecretKey },
  });
}

export function getAdminSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const legacyServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const serviceKey = legacyServiceKey || secretKey;
  if (!url || !serviceKey) {
    throw new Error('Server Supabase credentials are not configured. Add SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) to the server environment.');
  }

  cached = serviceKey.startsWith('sb_secret_')
    ? createSecretKeyClient(url, serviceKey)
    : createClient(url, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });

  return cached;
}
