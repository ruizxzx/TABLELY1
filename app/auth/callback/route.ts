import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') || '/dashboard';

  if (!code) return NextResponse.redirect(`${origin}/login?error=missing_auth_code`);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  if (!supabaseUrl || !supabaseKey || supabaseKey.startsWith('sb_secret_')) {
    return NextResponse.redirect(`${origin}/login?error=supabase_not_configured`);
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    supabaseUrl,
    supabaseKey,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        },
      },
    },
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);

  if (next.startsWith('/customer') || next.startsWith('/r/')) {
    const { data: userData } = await supabase.auth.getUser();
    const metadata = userData.user?.user_metadata ?? {};
    const { error: customerError } = await supabase.rpc('activate_customer_account', {
      p_name: String(metadata.full_name ?? metadata.name ?? ''),
      p_phone: String(metadata.phone ?? ''),
    });
    if (customerError) {
      console.error('[auth/callback] Customer profile activation failed after successful OAuth:', customerError.message);
    }
  }

  return NextResponse.redirect(`${origin}${next.startsWith('/') ? next : '/dashboard'}`);
}
