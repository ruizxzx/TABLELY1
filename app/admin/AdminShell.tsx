'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  ArrowUpRight,
  BadgePercent,
  Blocks,
  Bot,
  Building2,
  CreditCard,
  FileText,
  Handshake,
  LayoutDashboard,
  LifeBuoy,
  Menu,
  MessageSquareText,
  Palette,
  Settings2,
  Users,
  X,
} from 'lucide-react';
import styles from './AdminShell.module.css';

type NavItem = { label: string; href: string; icon: typeof LayoutDashboard };
type NavGroup = { label: string; items: NavItem[] };

const groups: NavGroup[] = [
  {
    label: 'Workspace',
    items: [{ label: 'Overview', href: '/admin', icon: LayoutDashboard }],
  },
  {
    label: 'Accounts',
    items: [
      { label: 'Restaurants', href: '/admin/restaurants', icon: Building2 },
      { label: 'Subscriptions', href: '/admin/subscriptions', icon: CreditCard },
      { label: 'Billing', href: '/admin/billing', icon: BadgePercent },
      { label: 'Plans', href: '/admin/plans', icon: Blocks },
      { label: 'Partners', href: '/admin/partners', icon: Handshake },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'AI management', href: '/admin/ai-management', icon: Bot },
      { label: 'Customer engagement', href: '/admin/customer-engagement', icon: MessageSquareText },
      { label: 'Support', href: '/admin/support', icon: LifeBuoy },
      { label: 'Operations', href: '/admin/operations', icon: Activity },
      { label: 'System control', href: '/admin/control', icon: Settings2 },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { label: 'Content', href: '/admin/content', icon: FileText },
      { label: 'Branding', href: '/admin/branding', icon: Palette },
      { label: 'Landing page', href: '/admin/landing', icon: LayoutDashboard },
      { label: 'Contacts', href: '/admin/contacts', icon: Users },
    ],
  },
];

function currentTitle(pathname: string) {
  const match = groups.flatMap((group) => group.items).find((item) =>
    item.href === '/admin' ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));
  return match?.label ?? 'Admin';
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const standalone = pathname === '/admin/login';

  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  if (standalone) return <>{children}</>;

  return (
    <div className={`${styles.workspace} admin-workspace`}>
      {menuOpen ? <button className={styles.scrim} type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
      <aside className={`${styles.sidebar} ${menuOpen ? styles.sidebarOpen : ''}`} aria-label="Admin navigation">
        <Link className={styles.brand} href="/admin" aria-label="TABLELY admin overview">
          <span className={styles.brandMark}>T</span>
          <span><strong>TABLELY</strong><small>PLATFORM ADMIN</small></span>
        </Link>
        <nav className={styles.navigation}>
          {groups.map((group) => (
            <div className={styles.navGroup} key={group.label}>
              <span className={styles.groupLabel}>{group.label}</span>
              {group.items.map(({ label, href, icon: Icon }) => {
                const active = href === '/admin' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link className={`${styles.navItem} ${active ? styles.active : ''}`} href={href} key={href} aria-current={active ? 'page' : undefined}>
                    <Icon size={17} strokeWidth={1.8} />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <a className={styles.siteLink} href="/" target="_blank" rel="noreferrer">
          <span>View TABLELY website</span><ArrowUpRight size={15} />
        </a>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.topbarStart}>
            <button className={styles.menuButton} type="button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
              {menuOpen ? <X size={19} /> : <Menu size={19} />}
            </button>
            <div className={styles.pageContext}>
              <span>Platform administration</span>
              <strong>{currentTitle(pathname)}</strong>
            </div>
          </div>
          <div className={styles.topbarEnd}>
            <span className={styles.status}><i /> Secure workspace</span>
            <Link className={styles.homeLink} href="/admin">Admin home</Link>
          </div>
        </header>
        <div className={styles.pageContent}>{children}</div>
      </div>
    </div>
  );
}
