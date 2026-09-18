import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServerClient } from '@/lib/supabase-server';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });

  const { orderId } = await params;
  const { data, error } = await supabase.rpc('get_my_customer_receipt', { p_order_id: orderId });
  if (error) return NextResponse.json({ error: 'Could not load this receipt.' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Receipt not found.' }, { status: 404 });
  return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
}
