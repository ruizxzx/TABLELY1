import { getAdminSupabase } from './server-admin';

export type SiteBranding = {
  site_name: string;
  site_logo_url: string | null;
  site_favicon_url: string | null;
};

export async function getSiteBranding(): Promise<SiteBranding> {
  try {
    const db = getAdminSupabase();
    const { data, error } = await db
      .from('platform_settings')
      .select('site_name, site_logo_url, site_favicon_url')
      .eq('id', 1)
      .maybeSingle();

    if (error) throw error;
    const configuredName = String(data?.site_name || '').trim();
    return {
      site_name: configuredName && !/^(instaly|sellora)$/i.test(configuredName) ? configuredName : 'TABLELY',
      site_logo_url: data?.site_logo_url || null,
      site_favicon_url: data?.site_favicon_url || null,
    };
  } catch {
    return {
      site_name: 'TABLELY',
      site_logo_url: null,
      site_favicon_url: null,
    };
  }
}
