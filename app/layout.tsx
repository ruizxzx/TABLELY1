import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { PlatformBrandRuntime } from '@/components/PlatformBrandRuntime';
import { Analytics } from '@vercel/analytics/next';

const FALLBACK_TITLE = 'Tablely — Restaurant Ordering OS';
const FALLBACK_DESCRIPTION = 'QR ordering, restaurant operations and kitchen workflow in one system.';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export async function generateMetadata(): Promise<Metadata> {
  try {
    const supabase = await getSupabaseServerClient();
    if (supabase) {
      const { data } = await supabase.rpc('get_public_platform_brand');
      const row = Array.isArray(data) ? data[0] : data;
      const title = typeof row?.site_title === 'string' && row.site_title.trim()
        ? row.site_title.trim()
        : FALLBACK_TITLE;
      const logoUrl = typeof row?.logo_url === 'string' && row.logo_url.trim()
        ? row.logo_url.trim()
        : null;

      return {
        title,
        description: FALLBACK_DESCRIPTION,
        icons: logoUrl
          ? { icon: logoUrl, shortcut: logoUrl, apple: logoUrl }
          : { icon: '/icon.svg', shortcut: '/icon.svg', apple: '/icon.svg' },
      };
    }
  } catch {
    // Use safe static defaults when the public branding endpoint is unavailable.
  }

  return {
    title: FALLBACK_TITLE,
    description: FALLBACK_DESCRIPTION,
    icons: { icon: '/icon.svg', shortcut: '/icon.svg', apple: '/icon.svg' },
  };
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <PlatformBrandRuntime />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
