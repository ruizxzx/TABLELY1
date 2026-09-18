import { NextResponse } from 'next/server';
import { resolveTxt } from 'node:dns/promises';
import { getSupabaseServerClient } from '@/lib/supabase-server';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { domainId?: string } | null;
  if (!body?.domainId) return NextResponse.json({ error: 'domainId is required.' }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: 'Authentication is not configured.' }, { status: 500 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  const { data: owner } = await supabase.from('staff').select('organization_id,role').eq('user_id', user.id).eq('role', 'OWNER').eq('active', true).limit(1).maybeSingle();
  if (!owner) return NextResponse.json({ error: 'Only the owner can verify domains.' }, { status: 403 });
  const { data: domain, error } = await supabase.from('organization_domains').select('id,hostname,verification_token,organization_id,status').eq('id', body.domainId).eq('organization_id', owner.organization_id).maybeSingle();
  if (error || !domain) return NextResponse.json({ error: error?.message ?? 'Domain not found.' }, { status: 404 });
  if (domain.status === 'VERIFIED') return NextResponse.json({ ok: true, status: 'VERIFIED' });
  const record = `_tablely-verification.${domain.hostname}`;
  try {
    const values = await resolveTxt(record);
    const flat = values.flat().map((v) => v.replace(/^"|"$/g, ''));
    if (!flat.includes(domain.verification_token)) return NextResponse.json({ error: `TXT record not found at ${record}.` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: `DNS lookup failed for ${record}. Check the TXT record and try again.` }, { status: 400 });
  }
  const { data: verified, error: verifyError } = await supabase.rpc('mark_domain_verified', { p_domain_id: domain.id });
  if (verifyError) return NextResponse.json({ error: verifyError.message }, { status: 500 });
  return NextResponse.json({ ok: true, status: Array.isArray(verified) ? verified[0]?.status : verified?.status });
}
