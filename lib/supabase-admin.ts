import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function getSupabaseAdminClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key || !key.startsWith('sb_secret_') && !key.startsWith('eyJ')) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
