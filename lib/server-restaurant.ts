import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getCurrentRestaurantContext, type CurrentRestaurantContext } from '@/lib/restaurant-context';
import { getSupabaseAdminClient } from '@/lib/supabase-admin';
import { getSupabaseServerClient } from '@/lib/supabase-server';

export type ServerRestaurantAccess = {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  context: CurrentRestaurantContext;
  branchId: string;
};

export async function resolveServerRestaurantAccess(options: {
  branchId?: string | null;
  permission?: string;
  ownerOnly?: boolean;
} = {}): Promise<{ access: ServerRestaurantAccess; error?: never } | { access?: never; error: NextResponse }> {
  const supabase = await getSupabaseServerClient();
  const admin = getSupabaseAdminClient();
  if (!supabase || !admin) return { error: NextResponse.json({ error: 'Server database configuration is incomplete.' }, { status: 503 }) };
  const resolved = await getCurrentRestaurantContext(supabase);
  if (resolved.error || !resolved.data) {
    const unauthenticated = resolved.error?.message === 'Not authenticated';
    return { error: NextResponse.json({ error: unauthenticated ? 'Not authenticated.' : 'Restaurant workspace could not be resolved.' }, { status: unauthenticated ? 401 : 403 }) };
  }
  const context = resolved.data;
  if (options.ownerOnly && context.staff.role !== 'OWNER') {
    return { error: NextResponse.json({ error: 'Owner access is required.' }, { status: 403 }) };
  }
  const requestedBranch = options.branchId?.trim();
  const branch = requestedBranch ? context.branches.find((item) => item.id === requestedBranch) : context.branch;
  if (!branch) return { error: NextResponse.json({ error: 'Branch access denied.' }, { status: 403 }) };
  if (options.permission && context.staff.role !== 'OWNER') {
    const { data: allowed, error } = await supabase.rpc('current_user_has_permission_for_branch', {
      p_branch_id: branch.id,
      p_permission: options.permission,
    });
    if (error || allowed !== true) return { error: NextResponse.json({ error: `${options.permission.replaceAll('_', ' ').toLowerCase()} permission is required.` }, { status: 403 }) };
  }
  return { access: { supabase, admin, context, branchId: branch.id } };
}
