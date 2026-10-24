import { NextResponse } from 'next/server';
import { getAdminSupabase } from '../../lib/server-admin';
import { withRateLimit } from '../../lib/server-security';

const clean = (value: unknown, max: number) => String(value || '').trim().slice(0, max);

export async function POST(request: Request) {
  const limited = withRateLimit(request, 'creator-verification', 10);
  if (limited) return limited;

  try {
    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const db = getAdminSupabase();
    const { data: { user }, error: userError } = await db.auth.getUser(authorization.slice(7));
    if (userError || !user) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const details = {
      fullName: clean(body.fullName, 120), username: clean(body.username, 80), category: clean(body.category, 100),
      country: clean(body.country, 80), audience: clean(body.audience, 80), reason: clean(body.reason, 1000),
      links: Array.isArray(body.links) ? body.links.map((value: unknown) => clean(value, 500)).filter(Boolean).slice(0, 8) : [],
    };
    if (!details.fullName || !details.username || !details.category || !details.country || !details.reason || !details.links.length) {
      return NextResponse.json({ ok: false, error: 'Complete your name, username, category, country, reason and at least one public link.' }, { status: 400 });
    }

    const { data: existing } = await db
      .from('creator_verifications')
      .select('status')
      .eq('creator_id', user.id)
      .maybeSingle();

    if (existing?.status === 'pending') {
      return NextResponse.json({ ok: true, status: 'pending' });
    }
    if (existing?.status === 'verified') {
      return NextResponse.json({ ok: true, status: 'verified' });
    }

    const now = new Date().toISOString();
    const { error } = await db.from('creator_verifications').upsert({
      creator_id: user.id,
      status: 'pending',
      verification_details: details,
      submitted_at: now,
      updated_at: now,
      notes: null,
    }, { onConflict: 'creator_id' });
    if (error) throw error;
    await db.from('stores').update({ verified_badge: false, updated_at: now }).eq('owner_id', user.id);

    return NextResponse.json({ ok: true, status: 'pending' });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Could not submit verification request.',
    }, { status: 500 });
  }
}
