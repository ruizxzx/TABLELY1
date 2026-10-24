import { NextResponse } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';

export async function GET() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Sign in to view the partner dashboard.' }, { status: 401 });
  const { data, error } = await supabase.rpc('tablely_partner_dashboard');
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === 'P0002' ? 404 : 400 });
  return NextResponse.json({ data });
}
