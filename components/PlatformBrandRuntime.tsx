'use client';

import { useEffect } from 'react';
import { PLATFORM_BRAND_EVENT, PLATFORM_BRAND_STORAGE_KEY } from '@/components/Brand';
import { getSupabaseBrowserClient } from '@/lib/supabase';

const FALLBACK_TITLE = 'Tablely — Restaurant Ordering OS';
const FALLBACK_ICON = '/icon.svg';

function applyFavicon(logoUrl: string | null) {
  if (typeof document === 'undefined') return;
  const href = logoUrl || FALLBACK_ICON;
  const rels = ['icon', 'shortcut icon', 'apple-touch-icon'];
  for (const rel of rels) {
    let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
    if (!link) {
      link = document.createElement('link');
      link.rel = rel;
      document.head.appendChild(link);
    }
    link.href = href;
  }
}

export function PlatformBrandRuntime() {
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.rpc('get_public_platform_brand');
      const row = Array.isArray(data) ? data[0] : data;
      if (cancelled) return;
      const title = typeof row?.site_title === 'string' && row.site_title.trim()
        ? row.site_title.trim()
        : FALLBACK_TITLE;
      document.title = title;
      applyFavicon(typeof row?.logo_url === 'string' && row.logo_url.trim() ? row.logo_url.trim() : null);
    };

    void load();
    const onChange = () => { void load(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === PLATFORM_BRAND_STORAGE_KEY) void load();
    };
    window.addEventListener(PLATFORM_BRAND_EVENT, onChange);
    window.addEventListener('storage', onStorage);


    return () => {
      cancelled = true;
      window.removeEventListener(PLATFORM_BRAND_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return null;
}
