import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient, User } from '@supabase/supabase-js';

export type RestaurantContext = {
  organization: { id: string; name: string; slug: string };
  branch: { id: string; name: string; address: string | null };
  staff: { id: string; role: 'OWNER' | 'MANAGER' | 'WAITER' | 'KITCHEN'; can_kitchen: boolean; can_waiter: boolean };
  user: User;
};

let browserClient: SupabaseClient | undefined;

export function getSupabasePublicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  // Supabase's current public browser key is the publishable key.
  // Keep the legacy anon variable as a compatibility fallback during migration.
  const key = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  return { url, key };
}

export function isSupabaseConfigured() {
  const { url, key } = getSupabasePublicConfig();
  return Boolean(url && key && !key.startsWith('sb_secret_'));
}

export function getSupabaseConfigurationError() {
  const { url, key } = getSupabasePublicConfig();
  if (!url || !key) return 'Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY to .env.local.';
  if (key.startsWith('sb_secret_')) return 'A Supabase secret key was placed in a browser environment variable. Use the Publishable key from Supabase Settings → API Keys instead. Never put a secret/service-role key in NEXT_PUBLIC_* variables.';
  return null;
}

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  const { url, key } = getSupabasePublicConfig();
  if (!url || !key) return null;
  if (!browserClient) browserClient = createBrowserClient(url, key);
  return browserClient;
}
