import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const schema = z.object({
  staffId: z.string().uuid(),
  // Optional: owner types their own replacement password. If omitted we
  // generate a strong one and return it so the owner can share it.
  password: z.string().min(8).max(72).optional(),
});

function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let out = '';
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const s = await getSupabaseServerClient();
  if (!s) {
    return NextResponse.json({ error: 'Authentication is not configured.' }, { status: 500 });
  }

  const { data: { user }, error: userError } = await s.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const { data: owner, error: ownerError } = await s
    .from('staff')
    .select('organization_id,role,active,branch_id')
    .eq('user_id', user.id)
    .eq('active', true)
    .eq('role', 'OWNER')
    .limit(1)
    .maybeSingle();
  if (ownerError) return NextResponse.json({ error: ownerError.message }, { status: 500 });

  // Read the target staff row through the authenticated (RLS-respecting)
  // client -- not the service role -- so we never touch a row outside the
  // caller's own organization.
  const { data: target, error: targetError } = await s
    .from('staff')
    .select('id,user_id,role,organization_id,branch_id,display_name')
    .eq('id', parsed.data.staffId)
    .maybeSingle();
  if (targetError) return NextResponse.json({ error: targetError.message }, { status: 500 });
  if (!target) return NextResponse.json({ error: 'Staff member not found.' }, { status: 404 });

  let authorized = false;
  if (owner && target.organization_id === owner.organization_id) {
    // True owner: any staff row in the org (except the owner's own login, below).
    authorized = true;
  } else if (target.role === 'WAITER' || target.role === 'KITCHEN') {
    // Not the owner -- check for a delegated Branch Manager instead:
    // STAFF_MANAGEMENT permission, own branch only, Waiter/Kitchen only.
    const { data: canDelegate, error: delegateError } = await s.rpc('is_branch_manager_with_permission', {
      target_branch: target.branch_id,
      p_permission: 'STAFF_MANAGEMENT',
    });
    if (delegateError) return NextResponse.json({ error: delegateError.message }, { status: 500 });
    authorized = Boolean(canDelegate);
  }
  if (!authorized) {
    return NextResponse.json({ error: 'Only the owner or a branch manager with staff-management access can reset this login.' }, { status: 403 });
  }
  if (target.role === 'OWNER') {
    return NextResponse.json({ error: 'The owner login cannot be reset from here.' }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ error: 'Admin access is not configured on the server.' }, { status: 500 });
  }

  const password = parsed.data.password ?? generatePassword();
  const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(target.user_id, {
    password,
    email_confirm: true,
  });
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    email: updated.user?.email ?? null,
    password,
    message: 'New password set. Share it with the staff member yourself.',
  });
}
