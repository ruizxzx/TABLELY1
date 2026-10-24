import { NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

export type SupportAdminContext = {
  admin: SupabaseClient;
  user: User;
};

export async function getSupportAdminContext(): Promise<
  { context: SupportAdminContext; error?: never } | { context?: never; error: NextResponse }
> {
  const supabase = await getSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  if (!supabase || !admin) {
    return { error: NextResponse.json({ error: 'Server configuration unavailable.' }, { status: 503 }) };
  }

  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError && !user) {
    return { error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) };
  }
  if (userError) {
    return { error: NextResponse.json({ error: 'Could not verify platform access.' }, { status: 503 }) };
  }
  if (!user) {
    return { error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) };
  }

  const { data: allowed, error: permissionError } = await supabase.rpc('is_platform_admin');
  if (permissionError) {
    return { error: NextResponse.json({ error: 'Could not verify platform access.' }, { status: 503 }) };
  }
  if (allowed !== true) {
    return { error: NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 }) };
  }

  return { context: { admin, user } };
}
