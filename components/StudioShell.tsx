'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ChefHat,
  ClipboardList,
  LayoutDashboard,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  QrCode,
  Table2,
  UtensilsCrossed,
  X,
  BellRing,
  CreditCard,
  BarChart3,
  Star,
  Users,
  UserRoundSearch,
  ReceiptText,
  Settings,
  Building2,
  BookOpen,
  MessageCircle,
  MoreHorizontal,
  Bike,
  ShoppingBag,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase';
import { Brand } from './Brand';
import { RealtimeNotificationCenter } from './RealtimeNotificationCenter';
import { CustomerChatInbox } from './customer/CustomerChatInbox';
import { RestaurantAiChatbot } from './ai/RestaurantAiChatbot';

const items = [
  { href: '/dashboard', label: 'Overview', Icon: LayoutDashboard, roles: ['OWNER', 'MANAGER'] },
  { href: '/orders', label: 'Orders', Icon: ClipboardList, roles: ['OWNER', 'MANAGER', 'WAITER', 'KITCHEN'] },
  { href: '/tables', label: 'Tables', Icon: Table2, roles: ['OWNER', 'MANAGER', 'WAITER'] },
  { href: '/qr', label: 'QR Codes', Icon: QrCode, roles: ['OWNER', 'MANAGER'] },
  { href: '/menu', label: 'Menu', Icon: UtensilsCrossed, roles: ['OWNER', 'MANAGER'] },
  { href: '/inventory', label: 'Inventory', Icon: Package, roles: ['OWNER', 'MANAGER'] },
  { href: '/kitchen', label: 'Kitchen', Icon: ChefHat, roles: ['OWNER', 'MANAGER', 'KITCHEN'] },
  { href: '/delivery', label: 'Delivery', Icon: Bike, roles: ['OWNER', 'MANAGER', 'WAITER', 'KITCHEN'] },
  { href: '/pickup', label: 'Self Pickup', Icon: ShoppingBag, roles: ['OWNER', 'MANAGER', 'WAITER', 'KITCHEN'] },
  { href: '/service-requests', label: 'Service', Icon: BellRing, roles: ['OWNER', 'MANAGER', 'WAITER'] },
  { href: '/customer-messages', label: 'Customer messages', Icon: MessageCircle, roles: ['OWNER', 'MANAGER', 'WAITER'] },
  { href: '/payments', label: 'Payments', Icon: CreditCard, roles: ['OWNER', 'MANAGER'] },
  { href: '/payments/split-bills', label: 'Split bills', Icon: ReceiptText, roles: ['OWNER', 'MANAGER'] },
  { href: '/staff', label: 'Staff', Icon: Users, roles: ['OWNER', 'MANAGER'] },
  { href: '/customers', label: 'Customers', Icon: UserRoundSearch, roles: ['OWNER', 'MANAGER'] },
  { href: '/bills', label: 'Bills', Icon: ReceiptText, roles: ['OWNER', 'MANAGER', 'WAITER'] },
  { href: '/analytics', label: 'Analytics', Icon: BarChart3, roles: ['OWNER', 'MANAGER'] },
  { href: '/reviews', label: 'Reviews', Icon: Star, roles: ['OWNER', 'MANAGER'] },
  { href: '/customer-engagement', label: 'Customer engagement', Icon: MessageCircle, roles: ['OWNER', 'MANAGER'] },
  { href: '/support', label: 'Support Centre', Icon: MessageCircle, roles: ['OWNER', 'MANAGER'] },
  { href: '/branches', label: 'Branches', Icon: Building2, roles: ['OWNER'] },
  { href: '/dashboard/subscription', label: 'Subscription', Icon: CreditCard, roles: ['OWNER', 'MANAGER'] },
  { href: '/settings', label: 'Settings', Icon: Settings, roles: ['OWNER', 'MANAGER'] },
  { href: '/help', label: 'Help & Guides', Icon: BookOpen, roles: ['OWNER', 'MANAGER', 'WAITER', 'KITCHEN'] },
];

// Fine-grained permission required to see a nav item, checked only for
// non-owner staff. Owners always see everything their role list allows.
// Items not listed here have no fine-grained gate (role/entitlement only).
const PERMISSION_FOR_HREF: Record<string, string> = {
  '/inventory': 'INVENTORY_VIEW',
  '/staff': 'STAFF_MANAGEMENT',
  '/customers': 'EDIT_ORDERS',
  '/payments': 'PAYMENTS',
  '/payments/split-bills': 'PAYMENTS',
  '/analytics': 'ANALYTICS',
  '/menu': 'MENU_MANAGEMENT',
  '/bills': 'BILLING',
  '/kitchen': 'KITCHEN_ACCESS',
  '/delivery': 'VIEW_DELIVERY',
  '/pickup': 'MANAGE_PICKUP',
  '/dashboard/subscription': 'SUBSCRIPTION_MANAGEMENT',
  '/settings': 'SETTINGS',
};

const PERMISSION_FOR_PATH_PREFIX: Array<{ prefix: string; permission: string }> = [
  { prefix: '/settings/charges', permission: 'CHARGES' },
  { prefix: '/settings/payments', permission: 'PAYMENTS' },
  { prefix: '/settings/online-ordering', permission: 'MANAGE_ONLINE_ORDERING' },
  { prefix: '/delivery', permission: 'VIEW_DELIVERY' },
  { prefix: '/dashboard/subscription', permission: 'SUBSCRIPTION_MANAGEMENT' },
];

const OWNER_ONLY_PATH_PREFIXES = ['/settings/domain', '/staff/permissions', '/settings/notifications'];

export function StudioShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [restaurantName, setRestaurantName] = useState('Loading…');
  const [branchName, setBranchName] = useState('');
  const [branches, setBranches] = useState<{id:string;name:string}[]>([]);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [branchId, setBranchId] = useState('');
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [userName, setUserName] = useState('Owner');
  const [role, setRole] = useState<string>('OWNER');
  const [canKitchen, setCanKitchen] = useState(true);
  const [canWaiter, setCanWaiter] = useState(true);
  const [loggingOut, setLoggingOut] = useState(false);
  const [entitlements, setEntitlements] = useState<Record<string, boolean>>({
    ONLINE_PAYMENTS: true, SERVICE_REQUESTS: true, PAYMENT_TRACKING: true, ANALYTICS: true,
  });
  // Manager-only fine-grained permission map, fetched from the staff's own
  // staff_permissions rows. Owners bypass this entirely (see hasNavPermission).
  // This mirrors, but does not replace, the server/RPC-level enforcement in
  // current_user_has_permission_for_branch(): hiding a nav item here is a UX
  // convenience, not the authorization boundary.
  const [permissions, setPermissions] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    let active = true;
    async function loadContext() {
      const supabase = getSupabaseBrowserClient();
      if (!supabase) {
        if (active) { setRestaurantName('Supabase not configured'); setBranchName('Setup required'); }
        return;
      }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/login'); return; }
      const { data: staffRows } = await supabase.from('staff').select('id, role, organization_id, branch_id, can_kitchen, can_waiter').eq('user_id', user.id).eq('active', true).order('created_at', { ascending: true });
      if (!staffRows || staffRows.length === 0) { router.replace('/onboarding'); return; }
      // Never let a non-owner row mask an OWNER row when a user has multiple staff rows.
      const staff = staffRows.find((s) => s.role === 'OWNER') ?? staffRows[0];
      const [{ data: org }, { data: branchRows }, { data: memberships }] = await Promise.all([
        supabase.from('organizations').select('id, name, slug').eq('id', staff.organization_id).maybeSingle(),
        supabase.from('branches').select('id, name, address').eq('organization_id', staff.organization_id).eq('is_active', true).order('created_at'),
        supabase.from('staff').select('branch_id, role').eq('user_id', user.id).eq('organization_id', staff.organization_id).eq('active', true),
      ]);
      if (!active) return;
      setRestaurantName(org?.name ?? 'Restaurant');
      const saved = window.localStorage.getItem('tablely_active_branch');
      const allBranches = (branchRows ?? []) as {id:string;name:string}[];
      const available = staff.role === 'OWNER' ? allBranches : allBranches.filter((b) => (memberships ?? []).some((m) => m.branch_id === b.id));
      const activeBranch = available.find((b) => b.id === saved) ?? available.find((b) => b.id === staff.branch_id) ?? available[0];
      if (activeBranch && saved !== activeBranch.id) window.localStorage.setItem('tablely_active_branch', activeBranch.id);
      setBranches(available);
      setBranchId(activeBranch?.id ?? '');
      setBranchName(activeBranch?.name ?? 'Main Branch');
      if (activeBranch?.id) {
        void supabase.rpc('get_effective_branch_brand', { p_branch_id: activeBranch.id }).then(({ data: brandRow }) => {
          if (!active) return;
          const row = Array.isArray(brandRow) ? brandRow[0] : brandRow;
          setLogoUrl(row?.logo_url ?? null);
        });
      }
      setUserName(String(user.user_metadata?.full_name ?? user.email ?? 'Owner'));
      setRole(String(staff.role ?? 'OWNER'));
      setCanKitchen(Boolean((staff as { can_kitchen?: unknown }).can_kitchen));
      setCanWaiter(Boolean((staff as { can_waiter?: unknown }).can_waiter));
      const { data: entitlementData } = await supabase.rpc('get_current_entitlements');
      const features = entitlementData && typeof entitlementData === 'object'
        ? ((entitlementData as { features?: Record<string, boolean> }).features ?? {})
        : {};
      if (Object.keys(features).length) setEntitlements(features);

      // Fine-grained nav gating only applies to non-owner staff (Owners
      // bypass all fine-grained permissions by design, same as server-side).
      let permMap: Record<string, boolean> | null = null;
      if (staff.role !== 'OWNER') {
        const { data: permRows } = await supabase
          .from('staff_permissions')
          .select('permission, allowed')
          .eq('staff_id', staff.id);
        permMap = {};
        for (const row of (permRows ?? []) as { permission: string; allowed: boolean }[]) {
          permMap[row.permission] = row.allowed;
        }
      }
      if (active) setPermissions(permMap);

      const roleHome = staff.role === 'KITCHEN' && staff.can_kitchen && !staff.can_waiter ? '/kitchen' : staff.role === 'WAITER' && staff.can_waiter && !staff.can_kitchen ? '/service-requests' : '/dashboard';
      const allowedPaths: Record<string, string[]> = {
        OWNER: items.map((item) => item.href),
        MANAGER: items.filter((item) => item.roles.includes('MANAGER')).map((item) => item.href),
        WAITER: items.filter((item) => item.roles.includes('WAITER')).map((item) => item.href),
        KITCHEN: items.filter((item) => item.roles.includes('KITCHEN')).map((item) => item.href),
      };
      let allowed = allowedPaths[String(staff.role)] ?? [];
      if (staff.role !== 'OWNER' && staff.role !== 'MANAGER') {
        allowed = items.filter((item) => {
          if (item.href === '/kitchen') return Boolean(staff.can_kitchen);
          if (item.href === '/service-requests') return Boolean(staff.can_waiter);
          if (item.href === '/tables' || item.href === '/bills') return Boolean(staff.can_waiter);
          if (item.href === '/orders') return Boolean(staff.can_kitchen || staff.can_waiter);
          return false;
        }).map((item) => item.href);
      }
      if (staff.role === 'OWNER' || staff.role === 'MANAGER') allowed = [...allowed, '/settings'];
      if (features.SERVICE_REQUESTS === false) allowed = allowed.filter((href) => href !== '/service-requests');
      if (features.ONLINE_PAYMENTS === false) allowed = allowed.filter((href) => href !== '/payments');
      if (features.ANALYTICS === false) allowed = allowed.filter((href) => href !== '/analytics');
      if (features.INVENTORY === false) allowed = allowed.filter((href) => href !== '/inventory');
      if (staff.role !== 'OWNER' && staff.role !== 'MANAGER') allowed = allowed.filter((href) => href !== '/dashboard/subscription');
      // Fine-grained permission gate (Managers only; Owners always bypass).
      if (staff.role !== 'OWNER' && permMap) {
        allowed = allowed.filter((href) => {
          const required = PERMISSION_FOR_HREF[href];
          return !required || permMap![required] === true;
        });
      }
      const current = window.location.pathname;
      let isAllowed = allowed.some((href) => current === href || current.startsWith(`${href}/`));

      if (isAllowed && staff.role !== 'OWNER') {
        if (OWNER_ONLY_PATH_PREFIXES.some((prefix) => current === prefix || current.startsWith(`${prefix}/`))) {
          isAllowed = false;
        }
        const requiredPermission = PERMISSION_FOR_PATH_PREFIX.find((entry) => current === entry.prefix || current.startsWith(`${entry.prefix}/`));
        if (requiredPermission && (!permMap || permMap[requiredPermission.permission] !== true)) {
          isAllowed = false;
        }
        if ((current === '/settings/payments' || current.startsWith('/settings/payments/')) && features.ONLINE_PAYMENTS === false) {
          isAllowed = false;
        }
      }
      if (!isAllowed && current !== '/login') {
        router.replace(roleHome);
        return;
      }
    }
    void loadContext();
    return () => { active = false; };
  }, [router]);


  async function switchBranch(nextId: string) {
    const next = branches.find((b) => b.id === nextId);
    if (!next || nextId === branchId) return;
    setSwitchingBranch(true);
    window.localStorage.setItem('tablely_active_branch', nextId);
    setBranchId(nextId); setBranchName(next.name);
    setSwitchingBranch(false);
    router.refresh();
    window.location.reload();
  }

  async function logout() {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    setLoggingOut(true);
    await supabase.auth.signOut();
    router.replace('/');
    router.refresh();
  }

  const visibleNavItems = items
    .filter((item) => item.roles.includes(role))
    .filter((item) => item.href !== '/service-requests' || entitlements.SERVICE_REQUESTS)
    .filter((item) => item.href !== '/payments' || entitlements.PAYMENT_TRACKING)
    .filter((item) => item.href !== '/analytics' || entitlements.ANALYTICS)
    .filter((item) => item.href !== '/inventory' || entitlements.INVENTORY !== false)
    .filter((item) => {
      if (role !== 'MANAGER' || !permissions) return true;
      const required = PERMISSION_FOR_HREF[item.href];
      return !required || permissions[required] === true;
    });
  const preferredMobileHrefs = ['/orders', '/tables', '/kitchen', '/service-requests'];
  const mobileNavItems = [
    ...preferredMobileHrefs.flatMap((href) => visibleNavItems.filter((item) => item.href === href)),
    ...visibleNavItems,
  ].filter((item, index, all) => all.findIndex((candidate) => candidate.href === item.href) === index).slice(0, 4);

  // Re-resolve the branch logo whenever the branding studio saves a change
  // (org default or this branch's override), so the sidebar/topbar reflect
  // it immediately without a full reload.
  useEffect(() => {
    if (!branchId) return;
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const reload = () => {
      void supabase.rpc('get_effective_branch_brand', { p_branch_id: branchId }).then(({ data: brandRow }) => {
        const row = Array.isArray(brandRow) ? brandRow[0] : brandRow;
        setLogoUrl(row?.logo_url ?? null);
      });
    };
    window.addEventListener('tablely-restaurant-brand-change', reload);
    return () => window.removeEventListener('tablely-restaurant-brand-change', reload);
  }, [branchId]);

  useEffect(() => {
    const saved = window.localStorage.getItem('tablely_sidebar_collapsed');
    if (saved === '1') setCollapsed(true);
  }, []);
  useEffect(() => { window.localStorage.setItem('tablely_sidebar_collapsed', collapsed ? '1' : '0'); }, [collapsed]);

  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia('(min-width: 1101px)');
    const closeIfDesktop = () => { if (mq.matches) setOpen(false); };
    const closeOnEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    mq.addEventListener('change', closeIfDesktop);
    window.addEventListener('resize', closeIfDesktop);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      mq.removeEventListener('change', closeIfDesktop);
      window.removeEventListener('resize', closeIfDesktop);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <div className={`shell ${collapsed ? 'shell-collapsed' : ''}`}>
      <aside className={`sidebar ${open ? 'sidebar-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`}>
        <div className="sidebar-head">
          <Brand light />
          <button type="button" className="icon-button mobile-only sidebar-mobile-collapse" aria-label="Collapse navigation" title="Collapse navigation" onClick={() => { setCollapsed(true); setOpen(false); }}>
            <PanelLeftClose size={18} />
          </button>
          <button className="icon-button mobile-only sidebar-mobile-close" aria-label="Close navigation" title="Close navigation" onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
        </div>
        <div className="restaurant-switcher">
          <div className="avatar avatar-logo">
            {logoUrl ? <img src={logoUrl} alt="" className="avatar-logo-img" /> : restaurantName.slice(0,2).toUpperCase()}
          </div>
          <div className="restaurant-switcher-copy">
            <strong>{restaurantName}</strong>
            {branches.length > 1 ? <select className="branch-switcher" value={branchId} disabled={switchingBranch} onChange={(e) => void switchBranch(e.target.value)} aria-label="Active branch">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select> : <span>{branchName}</span>}
          </div>
        </div>
        <nav className="side-nav" aria-label="Restaurant navigation">
          {visibleNavItems.map(({ href, label, Icon }) => {
            const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`));
            return (
              <Link key={href} href={href} className={active ? 'active' : ''} title={collapsed ? label : undefined} aria-label={collapsed ? label : undefined} onClick={() => setOpen(false)}>
                <Icon size={17} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <Link href="/" className="back-link">← View public site</Link>
        <button type="button" className="sidebar-logout" onClick={logout} disabled={loggingOut}>{loggingOut ? 'Signing out…' : 'Sign out'}</button>
      </aside>

      {open && <button className="scrim" aria-label="Close navigation" onClick={() => setOpen(false)} />}

      <section className="main-shell">
        <header className="topbar">
          <button className="icon-button desktop-only sidebar-topbar-toggle" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          <button className="icon-button mobile-only" aria-label={collapsed ? 'Expand navigation' : 'Open navigation'} title={collapsed ? 'Expand navigation' : 'Open navigation'} onClick={() => {
            if (collapsed) {
              setCollapsed(false);
              setOpen(true);
            } else {
              setOpen(true);
            }
          }}>
            {collapsed ? <PanelLeftOpen size={18} /> : <Menu size={19} />}
          </button>
          <div className="topbar-context">
            <span className="status-dot" />
            <span>Live</span>
            <span className="topbar-divider" />
            <span>{restaurantName} · {branchName}</span>
          </div>
          <Link href="/help" className="topbar-help-link" aria-label="Open Help & Guides" title="Help & Guides"><BookOpen size={17} /></Link>
          {['OWNER', 'MANAGER', 'WAITER'].includes(role) ? <CustomerChatInbox /> : null}
          {['OWNER', 'MANAGER', 'WAITER'].includes(role) ? <RestaurantAiChatbot /> : null}
          <RealtimeNotificationCenter />
          <div className="topbar-user">
            <div className="avatar avatar-small">{userName.slice(0, 2).toUpperCase()}</div>
            <div className="topbar-user-copy">
              <strong>{role}</strong>
              <span>{userName}</span>
            </div>
          </div>
        </header>
        <main className="content">{children}</main>
      </section>
      <nav className="studio-mobile-nav" aria-label="Primary navigation">
        {mobileNavItems.map(({ href, label, Icon }) => {
          const active = pathname === href || (href !== '/dashboard' && pathname.startsWith(`${href}/`));
          return (
            <Link key={href} href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
              <Icon size={19} strokeWidth={active ? 2.3 : 1.9} />
              <span>{label}</span>
            </Link>
          );
        })}
        <button type="button" aria-label="More navigation options" aria-expanded={open} onClick={() => { setCollapsed(false); setOpen(true); }}>
          <MoreHorizontal size={20} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
