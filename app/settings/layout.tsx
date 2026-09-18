import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getSupabaseServerClient } from '@/lib/supabase-server';
import { getCurrentRestaurantContext } from '@/lib/restaurant-context';

// Server-side authorization gate for the entire /settings route family.
//
// Every settings-affecting *mutation* (branding, domain, charges, payments)
// already enforces its own authorization at the RPC/RLS layer regardless of
// this check, so this layout is not the sole authorization boundary for any
// destructive action. What it closes is a narrower gap: before this file
// existed, a Manager whose SETTINGS permission was OFF could still load
// `/settings` and its sub-pages directly (e.g. by typing the URL), because
// the only place that path was gated was a client-side redirect in
// StudioShell that runs after the page has already started rendering.
//
// Owners always pass (SETTINGS is a Manager-only fine-grained permission).
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return <>{children}</>;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: context, error } = await getCurrentRestaurantContext(supabase);
  if (error || !context) redirect('/login');

  if (context.staff.role === 'OWNER') return <>{children}</>;
  if (context.staff.role !== 'MANAGER') redirect('/dashboard');

  const { data: allowed } = await supabase.rpc('current_user_has_permission_for_branch', {
    p_branch_id: context.branch.id,
    p_permission: 'SETTINGS',
  });
  if (allowed !== true) redirect('/dashboard');

  return <>{children}</>;
}
