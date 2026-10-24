import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const protectedPrefixes = ['/dashboard', '/orders', '/tables', '/qr', '/menu', '/kitchen', '/service-requests', '/payments', '/bills', '/staff', '/settings', '/onboarding', '/customer/account'];
const adminPrefix = '/admin';

function isProtected(pathname: string) {
  return protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function isAdminRoute(pathname: string) {
  return pathname === adminPrefix || pathname.startsWith(`${adminPrefix}/`);
}

export async function middleware(request: NextRequest) {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();

  // A publishable key is intended for browser/client use. A secret key must never be
  // supplied through NEXT_PUBLIC_*; Supabase deliberately rejects secret keys in browsers.
  if (!rawUrl || !key || key.startsWith('sb_secret_') || rawUrl.includes('YOUR_PROJECT') || rawUrl.includes('your-project')) {
    return NextResponse.next();
  }

  let url: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost')) {
      return NextResponse.next();
    }
    url = parsed.toString().replace(/\/$/, '');
  } catch {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });
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

  const { data: { user } } = await supabase.auth.getUser();

  if (isProtected(request.nextUrl.pathname) && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAdminRoute(request.nextUrl.pathname)) {
    if (!user) {
      const adminLoginUrl = request.nextUrl.clone();
      adminLoginUrl.pathname = '/admin-access';
      adminLoginUrl.searchParams.set('next', request.nextUrl.pathname);
      return NextResponse.redirect(adminLoginUrl);
    }
    // Platform admin status is intentionally independent from restaurant
    // staff roles, and is re-checked here (not just client-side) so a
    // logged-in restaurant owner can never even load the admin shell.
    const { data: isAdmin } = await supabase.rpc('is_platform_admin');
    if (!isAdmin) {
      const adminLoginUrl = request.nextUrl.clone();
      adminLoginUrl.pathname = '/admin-access';
      adminLoginUrl.searchParams.set('next', request.nextUrl.pathname);
      adminLoginUrl.searchParams.set('denied', '1');
      return NextResponse.redirect(adminLoginUrl);
    }
  }

  const pathname = request.nextUrl.pathname;
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
        return NextResponse.rewrite(rewrite, response);
      }
    }
  }

  return response;
}

export const config = {
  matcher: ['/table/:path*', '/dashboard/:path*', '/orders/:path*', '/tables/:path*', '/qr/:path*', '/menu/:path*', '/kitchen/:path*', '/service-requests/:path*', '/payments/:path*', '/bills/:path*', '/staff/:path*', '/settings/:path*', '/admin/:path*', '/admin-access', '/onboarding/:path*', '/login', '/signup', '/customer/:path*'],
};
