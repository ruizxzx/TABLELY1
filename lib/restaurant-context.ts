import type { SupabaseClient } from '@supabase/supabase-js';

export type StaffRole = 'OWNER' | 'MANAGER' | 'WAITER' | 'KITCHEN';

export type CurrentRestaurantContext = {
  userId: string;
  organization: { id: string; name: string; slug: string; status?: string };
  branch: { id: string; name: string; address: string | null; phone?: string | null };
  branches: { id: string; name: string; address: string | null; phone?: string | null; is_active?: boolean }[];
  staff: { id: string; role: StaffRole; can_kitchen: boolean; can_waiter: boolean };
};

export async function getCurrentRestaurantContext(
  supabase: SupabaseClient,
): Promise<{ data: CurrentRestaurantContext | null; error: Error | null }> {
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) return { data: null, error: authError };
  const user = authData.user;
  if (!user) return { data: null, error: new Error('Not authenticated') };

  const { data: staffRows, error: staffError } = await supabase
    .from('staff')
    .select('id, role, organization_id, branch_id, can_kitchen, can_waiter')
    .eq('user_id', user.id)
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (staffError) return { data: null, error: staffError };
  if (!staffRows || staffRows.length === 0) return { data: null, error: new Error('Restaurant workspace not found') };
  // If this user has more than one active staff row (e.g. across branches),
  // never let a non-owner row mask an OWNER row — always prefer OWNER.
  const staff = staffRows.find((s) => s.role === 'OWNER') ?? staffRows[0];

  const [{ data: organization, error: organizationError }, { data: branchRows, error: branchesError }, { data: memberships, error: membershipError }] = await Promise.all([
    supabase.from('organizations').select('id, name, slug, status').eq('id', staff.organization_id).maybeSingle(),
    supabase.from('branches').select('id, name, address, phone, is_active').eq('organization_id', staff.organization_id).eq('is_active', true).order('created_at'),
    supabase.from('staff').select('branch_id, role').eq('user_id', user.id).eq('organization_id', staff.organization_id).eq('active', true),
  ]);
  const allBranches = (branchRows ?? []) as CurrentRestaurantContext['branches'];
  const availableBranches = staff.role === 'OWNER' ? allBranches : allBranches.filter((b) => (memberships ?? []).some((m) => m.branch_id === b.id));
  const savedBranchId = typeof window !== 'undefined' ? window.localStorage.getItem('tablely_active_branch') : null;
  const preferred = savedBranchId ? availableBranches.find((b) => b.id === savedBranchId) : null;
  const staffBranch = availableBranches.find((b) => b.id === staff.branch_id);
  const branch = preferred ?? staffBranch ?? availableBranches[0] ?? null;
  const branchError = branchesError ?? membershipError;

  if (organizationError) return { data: null, error: organizationError };
  if (branchError) return { data: null, error: branchError };
  if (!organization || !branch) return { data: null, error: new Error('Restaurant branch not found') };

  return {
    data: {
      userId: user.id,
      organization,
      branch,
      branches: availableBranches,
      staff: { id: staff.id, role: staff.role as StaffRole, can_kitchen: Boolean((staff as { can_kitchen?: unknown }).can_kitchen), can_waiter: Boolean((staff as { can_waiter?: unknown }).can_waiter) },
    },
    error: null,
  };
}
