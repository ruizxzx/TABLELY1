import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const schema = z.object({
  fullName: z.string().trim().min(2).max(120), city: z.string().trim().min(2).max(100), state: z.string().trim().min(2).max(100),
  category: z.enum(['STUDENT', 'FREELANCER', 'AGENCY', 'CONSULTANT', 'OTHER']), company: z.string().max(160).optional(),
  website: z.string().max(300).optional(), source: z.string().max(300).optional(), address: z.string().max(500).optional(), agreement: z.literal(true),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Complete the required fields and accept the partner agreement.' }, { status: 400 });
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 });
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Verify your email before submitting a partner application.' }, { status: 401 });
  const values = parsed.data;
  const { data, error } = await supabase.rpc('tablely_partner_register', {
    p_full_name: values.fullName, p_city: values.city, p_state: values.state, p_category: values.category,
    p_company: values.company ?? '', p_website: values.website ?? '', p_source: values.source ?? '', p_address: values.address ?? '',
  });
  if (error?.message.toLowerCase().includes('email and phone')) {
    console.error('[partners/register] Database still enforces phone verification; apply the partner email-only auth migration.');
    return NextResponse.json({
      error: 'Partner applications now require email verification only. The database update for email-only partner verification has not been applied yet.',
    }, { status: 503 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: error.code === '42501' ? 403 : 400 });
  return NextResponse.json({ ok: true, partner: data }, { status: 201 });
}
