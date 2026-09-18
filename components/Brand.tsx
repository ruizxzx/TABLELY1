'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

export const PLATFORM_BRAND_EVENT = 'tablely-brand-change';
export const PLATFORM_BRAND_STORAGE_KEY = 'tablely-platform-brand-change';

export type PublicPlatformBrand = {
  logo_url: string | null;
  site_title: string | null;
};

export function notifyPlatformBrandChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(PLATFORM_BRAND_EVENT));
  try {
    window.localStorage.setItem(PLATFORM_BRAND_STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

function usePlatformBrand() {
  const [brand, setBrand] = useState<PublicPlatformBrand>({ logo_url: null, site_title: null });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.rpc('get_public_platform_brand');
      const row = Array.isArray(data) ? data[0] : data;
      if (!cancelled) {
        setBrand({
          logo_url: row?.logo_url ?? null,
          site_title: row?.site_title ?? null,
        });
      }
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

  return brand;
}

export function PlatformLogo({ className = 'brand-logo', alt = '' }: { className?: string; alt?: string }) {
  const brand = usePlatformBrand();
  return brand.logo_url
    ? <img className={className} src={brand.logo_url} alt={alt} />
    : <span className="brand-mark">T</span>;
}

export function Brand({ light = false }: { light?: boolean }) {
  const brand = usePlatformBrand();

  return (
    <Link className={`brand ${light ? 'brand-light' : ''}`} href="/">
      {brand.logo_url ? <img className="brand-logo" src={brand.logo_url} alt="Tablely" /> : <span className="brand-mark">T</span>}
      <span className={brand.logo_url ? 'brand-name-with-logo' : undefined}>Tablely</span>
    </Link>
  );
}
