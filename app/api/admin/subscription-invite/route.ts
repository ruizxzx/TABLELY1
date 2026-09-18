import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const schema = z.object({
  email: z.string().email(),
  planId: z.enum(['STARTER', 'GROWTH', 'PRO']),
  days: z.number().int().min(1).max(3650),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: 'Enter a valid email, plan and duration.' }, { status: 400 });

  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured.' }, { status: 503 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const email = parsed.data.email.trim().toLowerCase();
  const { data: created, error: createError } = await supabase.rpc('admin_create_subscription_invite', {
    p_email: email,
    p_plan_id: parsed.data.planId,
    p_days: parsed.data.days,
    p_start_at: new Date().toISOString(),
  });
  if (createError) return NextResponse.json({ error: createError.message }, { status: createError.code === '42501' ? 403 : 400 });

  const { data: applied, error: applyError } = await supabase.rpc('admin_apply_invite_to_existing_owner', { p_email: email });
  if (applyError) return NextResponse.json({ error: applyError.message }, { status: applyError.code === '42501' ? 403 : 400 });
  if (applied) {
    return NextResponse.json({ ok: true, appliedImmediately: true, invite: created, message: 'Existing restaurant account updated with the invited plan and trial window.' });
  }

  const signupUrl = `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'http://localhost:3001'}/signup`;
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ ok: true, invite: created, emailSent: false, signupUrl, message: 'Trial invitation saved. Server email configuration is not available, so send the signup link manually.' });
  }

  const { data: users, error: existingError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (existingError && !/not found|user not found/i.test(existingError.message)) {
    return NextResponse.json({ ok: true, invite: created, emailSent: false, signupUrl, message: 'Trial invitation saved, but the account lookup could not be completed.' });
  }
  if (users?.users.some((candidate) => candidate.email?.toLowerCase() === email)) {
    return NextResponse.json({ ok: true, invite: created, emailSent: false, signupUrl, message: 'Trial invitation saved. This email already has an account; ask the owner to sign in and complete restaurant setup.' });
  }

  const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'http://localhost:3001'}/auth/callback?next=/onboarding`;
  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (inviteError) {
    return NextResponse.json({ ok: true, invite: created, emailSent: false, signupUrl, message: `Trial invitation saved, but the email invite could not be sent: ${inviteError.message}` });
  }

  return NextResponse.json({ ok: true, invite: created, emailSent: Boolean(invited.user), message: 'Trial invitation created and email invitation sent.' });
}
