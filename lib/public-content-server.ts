import { getSupabaseServerClient } from '@/lib/supabase-server';

export async function getPublishedContent<T>(slug: 'contact' | 'vision' | 'privacy' | 'terms', fallback: T): Promise<T> {
  try {
    const client = await getSupabaseServerClient();
    if (!client) return fallback;
    const { data, error } = await client.rpc('get_public_content_page', { p_slug: slug });
    if (error || !data || typeof data !== 'object' || !('content' in data)) return fallback;
    return data.content as T;
  } catch {
    return fallback;
  }
}
