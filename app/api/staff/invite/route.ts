import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

const schema = z.object({
  email: z.string().trim().email(),
  role: z.enum(['MANAGER', 'WAITER', 'KITCHEN']),
  canKitchen: z.boolean().optional(),
  canWaiter: z.boolean().optional(),
  branchId: z.string().uuid(),
  // Optional: owner can set the staff login password themselves. If omitted
  // we generate a strong one and hand it back so the owner can share it.
  password: z.string().min(8).max(72).optional(),
});

function inviteLink(token: string) {
  const base = (process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3001').replace(/\/$/, '');
  return `${base}/join-staff/${encodeURIComponent(token)}`;
}

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
    return NextResponse.json({ error: 'Invalid staff invitation.' }, { status: 400 });
  }

  const s = await getSupabaseServerClient();
  if (!s) {
    return NextResponse.json({ error: 'Authentication is not configured.' }, { status: 500 });
  }

  const { data: { user }, error: userError } = await s.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  // Verify ownership using the authenticated session first. Do not trust the branch ID from the client.
  const { data: owner, error: ownerError } = await s
    .from('staff')
    .select('organization_id,role,active')
    .eq('user_id', user.id)
    .eq('active', true)
    .eq('role', 'OWNER')
    .limit(1)
    .maybeSingle();

  if (ownerError) {
    return NextResponse.json({ error: ownerError.message }, { status: 500 });
  }

  const { data: branch, error: branchError } = await s
    .from('branches')
    .select('id,organization_id')
    .eq('id', parsed.data.branchId)
    .maybeSingle();

  if (branchError) {
    return NextResponse.json({ error: branchError.message }, { status: 500 });
  }
  if (!branch) {
    return NextResponse.json({ error: 'Invalid branch.' }, { status: 403 });
  }

  let organizationId: string;

  if (owner && branch.organization_id === owner.organization_id) {
    // True org owner: unrestricted, any role, any branch in their org.
    organizationId = owner.organization_id;
  } else {
    // Not the owner (or owner of a different org) -- check for a delegated
    // Branch Manager instead: STAFF_MANAGEMENT permission, own branch only,
    // Waiter/Kitchen only. The database RPC re-checks all of this itself,
    // this is just an early, friendlier rejection.
    if (parsed.data.role === 'MANAGER') {
      return NextResponse.json({ error: 'Branch managers can only invite Waiter or Kitchen staff.' }, { status: 403 });
    }
    const { data: canDelegate, error: delegateError } = await s.rpc('is_branch_manager_with_permission', {
      target_branch: branch.id,
      p_permission: 'STAFF_MANAGEMENT',
    });
    if (delegateError) return NextResponse.json({ error: delegateError.message }, { status: 500 });
    if (!canDelegate) {
      return NextResponse.json({ error: 'Only the owner or a branch manager with staff-management access can invite staff.' }, { status: 403 });
    }
    organizationId = branch.organization_id;
  }

  const { data: canAddStaff, error: staffLimitError } = await s.rpc('organization_can_add_staff_for_branch', {
    p_organization_id: organizationId,
    p_branch_id: branch.id,
  });
  if (staffLimitError) return NextResponse.json({ error: staffLimitError.message }, { status: 500 });
  if (!canAddStaff) return NextResponse.json({ error: 'Your current Tablely plan has reached its staff limit. Upgrade to add more staff.' }, { status: 403 });

  const admin = getSupabaseAdminClient();

  // Preferred path: create (or reuse) the staff login directly via the admin
  // API and hand the credentials back to the owner to share themselves.
  // This deliberately never sends an email -- Supabase's outbound auth
  // email quota (a couple of sends per hour on the default project config)
  // makes email-based invites unreliable for onboarding staff quickly.
  if (admin) {
    const password = parsed.data.password ?? generatePassword();
    const metadata = { role: parsed.data.role };

    let userId: string | null = null;
    let created = true;
    const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
      email: parsed.data.email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    });

    if (createdUser?.user) {
      userId = createdUser.user.id;
    } else if (createError && /already.*registered|already exists/i.test(createError.message)) {
      // This email already has a Tablely login (e.g. staff elsewhere, or a
      // half-finished earlier invite). Reuse that account and just reset
      // its password so the owner can hand out fresh credentials.
      created = false;
      const { data: existingId, error: lookupError } = await s.rpc('get_user_id_by_email', { p_email: parsed.data.email });
      if (lookupError) return NextResponse.json({ error: lookupError.message }, { status: 500 });
      if (!existingId) return NextResponse.json({ error: createError.message }, { status: 500 });
      const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(String(existingId), {
        password,
        email_confirm: true,
      });
      if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
      userId = updated.user?.id ?? String(existingId);
    } else if (createError) {
      return NextResponse.json({ error: createError.message }, { status: 500 });
    }

    if (userId) {
      const { error: insertError } = await admin.from('staff').upsert(
        {
          user_id: userId,
          organization_id: organizationId,
          branch_id: branch.id,
          role: parsed.data.role,
          can_kitchen: parsed.data.canKitchen ?? (parsed.data.role !== 'WAITER'),
          can_waiter: parsed.data.canWaiter ?? (parsed.data.role !== 'KITCHEN'),
          active: true,
        },
        { onConflict: 'user_id,organization_id,branch_id' },
      );
      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
      return NextResponse.json({
        ok: true,
        sentByEmail: false,
        credentials: true,
        created,
        email: parsed.data.email,
        password,
        message: created
          ? 'Staff login created. Share this email and password with the staff member yourself.'
          : 'This email already had a Tablely login, so its password was reset. Share the new password with the staff member yourself.',
      });
    }
    // If the admin API itself is unreachable, continue to the manual-link fallback.
  }

  // No service-role key or admin email failure: create a one-time, 7-day invitation token via
  // the authenticated security-definer RPC and return the link to the owner.
  const { data: invitation, error: invitationError } = await s.rpc('create_staff_invitation', {
    p_branch_id: branch.id,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
    p_can_kitchen: parsed.data.canKitchen ?? (parsed.data.role !== 'WAITER'),
    p_can_waiter: parsed.data.canWaiter ?? (parsed.data.role !== 'KITCHEN'),
  });

  if (invitationError) {
    return NextResponse.json(
      { error: `Could not create the staff invitation: ${invitationError.message}` },
      { status: 500 },
    );
  }

  const row = Array.isArray(invitation) ? invitation[0] : invitation;
  const token = row && typeof row === 'object' && 'token' in row ? String((row as { token: unknown }).token || '') : '';
  if (!token) {
    return NextResponse.json(
      { error: 'The invitation was created but no invitation token was returned. Apply the latest staff invitation migration and retry.' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    sentByEmail: false,
    fallback: true,
    inviteLink: inviteLink(token),
    message: 'Server email invitations are not configured. Share this secure invitation link with the staff member.',
  });
}
