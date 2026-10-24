'use client';

import { useEffect, useState } from 'react';

const FALLBACK_NAME = 'TABLELY';

export default function Logo({ light = false }: { light?: boolean }) {
  const [brandName, setBrandName] = useState(FALLBACK_NAME);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/site/branding', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        if (!payload?.ok || !active) return;
        setBrandName(payload.data?.site_name || FALLBACK_NAME);
        setLogoUrl(payload.data?.site_logo_url || null);
      })
      .catch(() => undefined);

    return () => { active = false; };
  }, []);

  return (
    <div className="logo" style={light ? { color: '#fff' } : undefined}>
      {logoUrl ? <img src={logoUrl} alt={brandName} className="logo-image" /> : <span className="logo-mark" />}
      <span>{brandName}</span>
    </div>
  );
}
