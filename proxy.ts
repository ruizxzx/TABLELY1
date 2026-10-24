import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const protectedPrefixes = ['/dashboard', '/orders', '/tables', '/qr', '/menu', '/kitchen', '/service-requests', '/payments', '/bills', '/staff', '/settings', '/onboarding', '/customer/account'];
const adminPrefix = '/admin';

function isProtected(pathname: string) {
  return protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isAdminRoute(pathname: string) {
  return pathname === adminPrefix || pathname.startsWith(`${adminPrefix}/`);
}

function withSecurityHeaders(response: NextResponse, pathname: string) {
  const isPreview = pathname === '/bento-preview';
  response.headers.set('X-Frame-Options', isPreview ? 'SAMEORIGIN' : 'DENY');
  response.headers.set('Content-Security-Policy', `${response.headers.get('Content-Security-Policy') || ''}; frame-ancestors '${isPreview ? 'self' : 'none'}'`);
  return response;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const response = NextResponse.next({ request });
  const needsSupabase = isProtected(pathname) || isAdminRoute(pathname) || pathname.startsWith('/table/');

  if (!needsSupabase) {
    return withSecurityHeaders(response, pathname);
  }

  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();

  // A publishable key is intended for browser/client use. A secret key must never be
  // supplied through NEXT_PUBLIC_*; Supabase deliberately rejects secret keys in browsers.
  if (!rawUrl || !key || key.startsWith('sb_secret_') || rawUrl.includes('YOUR_PROJECT') || rawUrl.includes('your-project')) {
    return withSecurityHeaders(response, pathname);
  }

  let url: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) {
      return withSecurityHeaders(response, pathname);
    }
    url = parsed.toString().replace(/\/$/, '');
  } catch {
    return withSecurityHeaders(response, pathname);
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  if (isProtected(pathname) || isAdminRoute(pathname)) {
    const { data: { user } } = await supabase.auth.getUser();

    if (isProtected(pathname) && !user) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('next', pathname);
      return withSecurityHeaders(NextResponse.redirect(loginUrl), pathname);
    }

    if (isAdminRoute(pathname)) {
      if (!user) {
        const adminLoginUrl = request.nextUrl.clone();
        adminLoginUrl.pathname = '/admin-access';
        adminLoginUrl.searchParams.set('next', pathname);
        return withSecurityHeaders(NextResponse.redirect(adminLoginUrl), pathname);
      }
      // Platform admin status is intentionally independent from restaurant
      // staff roles, and is re-checked here (not just client-side) so a
      // logged-in restaurant owner can never even load the admin shell.
      const { data: isAdmin } = await supabase.rpc('is_platform_admin');
      if (!isAdmin) {
        const adminLoginUrl = request.nextUrl.clone();
        adminLoginUrl.pathname = '/admin-access';
        adminLoginUrl.searchParams.set('next', pathname);
        adminLoginUrl.searchParams.set('denied', '1');
        return withSecurityHeaders(NextResponse.redirect(adminLoginUrl), pathname);
      }
    }
  }

  const appHost = request.nextUrl.hostname;
  const configuredHost = (() => { try { return process.env.NEXT_PUBLIC_APP_URL ? new URL(process.env.NEXT_PUBLIC_APP_URL).hostname : ''; } catch { return ''; } })();
  const isAppHost = !configuredHost || appHost === configuredHost || appHost === 'localhost' || appHost.endsWith('.vercel.app');
  if (!isAppHost && pathname.startsWith('/table/')) {
    const code = pathname.split('/')[2] || '';
    if (code) {
      const { data: slug } = await supabase.rpc('get_organization_slug_by_domain', { p_hostname: appHost });
      if (slug) {
        const rewrite = request.nextUrl.clone();
        rewrite.pathname = `/r/${slug}/table/${code}`;
        return withSecurityHeaders(NextResponse.rewrite(rewrite, response), pathname);
      }
    }
  }

  return withSecurityHeaders(response, pathname);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
