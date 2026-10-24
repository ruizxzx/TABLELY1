import { NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';

export const dynamic = 'force-dynamic';

function isAuthorized(request: Request) {
  const secret = (process.env.CRON_SECRET || process.env.SELLORA_CRON_SECRET || '').trim();
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Server configuration is unavailable.' }, { status: 503 });

  const { data, error } = await db.rpc('process_restaurant_loyalty_expiry', { p_limit: 500 });
  if (error) {
    console.error('[cron/loyalty-expiry] Expiry batch failed:', error.message);
    return NextResponse.json({ error: 'Loyalty expiry processing failed.' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, expiredEntries: data });
}
