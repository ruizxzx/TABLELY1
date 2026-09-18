'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase';

export function Brand({ light = false }: { light?: boolean }) {
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;
      const { data } = await supabase.rpc('get_public_platform_brand');
      const row = Array.isArray(data) ? data[0] : data;
      if (!cancelled) setLogoUrl(row?.logo_url ?? null);
    };
    void load();
    window.addEventListener('tablely-brand-change', load);
    return () => { cancelled = true; window.removeEventListener('tablely-brand-change', load); };
  }, []);

  return (
    <Link className={`brand ${light ? 'brand-light' : ''}`} href="/">
      {logoUrl ? <img className="brand-logo" src={logoUrl} alt="Tablely" /> : <span className="brand-mark">T</span>}
      <span className={logoUrl ? 'brand-name-with-logo' : undefined}>Tablely</span>
    </Link>
  );
}
