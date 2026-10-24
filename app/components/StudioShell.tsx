'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Activity, BarChart3, CreditCard, LayoutDashboard, Link2, Menu, Megaphone, Package, PanelLeft, Settings, ShoppingBag, Store, Users, WalletCards, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Logo from './Logo';
import { supabase } from '../lib/supabase';
import { publicMediaUrl } from '../lib/storage';
import { getEffectivePlan, PLAN_CONFIG } from '../lib/entitlements';
import { getLinkHubPath, getPrimaryPublicPage, getStorePath } from '../lib/public-paths';

const navigationGroups: [string, [string, string, LucideIcon][]][] = [
  ['Create', [['Link hub', '/studio/link-hub', PanelLeft], ['Store', '/studio/store', Store], ['Products', '/studio/products', Package]]],
  ['Sell', [['Orders', '/studio/orders', ShoppingBag], ['Customers', '/studio/customers', Users], ['Payments', '/studio/payments', CreditCard]]],
  ['Grow', [['Analytics', '/studio/analytics', BarChart3], ['Marketing', '/studio/marketing', Megaphone]]],
  ['Account', [['Subscriptions', '/studio/billing', WalletCards], ['Settings', '/studio/settings', Settings]]],
];

export default function StudioShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [userEmail, setUserEmail] = useState('Account');
  const [username, setUsername] = useState('');
  const [primaryPage, setPrimaryPage] = useState<'store' | 'linkhub'>('store');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [plan, setPlan] = useState('free');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;
        setUserEmail(session.user.email ?? 'Creator');
        const response = await fetch('/api/studio/context', {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: 'no-store',
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.ok) return;
        if (body.data?.username) setUsername(body.data.username);
        setPrimaryPage(getPrimaryPublicPage(body.data?.primaryPage));
        if (body.data?.avatarUrl) setAvatarUrl(publicMediaUrl(body.data.avatarUrl));
        setPlan(getEffectivePlan(body.data?.creatorPlan || null));
      } catch {
        // The shell keeps safe defaults if the context endpoint is temporarily unavailable.
      }
    })();
  }, []);

  useEffect(() => { setMobileMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileMenuOpen(false); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [mobileMenuOpen]);

  const storeHref = username ? getStorePath(username, primaryPage) : '/studio/store';
  const linkHubHref = username ? getLinkHubPath(username, primaryPage) : '/studio/link-hub';

  async function handleSignOut() {
    if (!supabase) {
      router.push('/login');
      return;
    }
    try {
      await supabase.auth.signOut();
    } finally {
      router.push('/login');
    }
  }

  return <div className="studio-shell">
    {mobileMenuOpen && <button className="menu-backdrop" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)} />}
    <aside className={`sidebar ${mobileMenuOpen ? 'mobile-open' : ''}`}>
      <Logo light />
      {navigationGroups.map(([group, groupLinks]) => <div key={group} className="side-nav-group"><div className="side-section">{group}</div>{groupLinks.map(([label, href, Icon]) => <Link key={href} href={href} onClick={() => setMobileMenuOpen(false)} className={`side-link ${pathname === href || pathname.startsWith(href) ? 'active' : ''}`}><span className="side-icon"><Icon size={16} strokeWidth={1.8} /></span><span>{label}</span></Link>)}</div>)}
      <div className="side-section">Workspace</div>
      <Link className={`side-link ${pathname === '/studio' ? 'active' : ''}`} href="/studio" onClick={() => setMobileMenuOpen(false)}><span className="side-icon"><LayoutDashboard size={16} strokeWidth={1.8} /></span><span>Overview</span></Link>
      <Link className="side-link" href="/account" onClick={() => setMobileMenuOpen(false)}><span className="side-icon"><Activity size={16} strokeWidth={1.8} /></span><span>My purchases</span></Link><Link className="side-link" href={storeHref} onClick={() => setMobileMenuOpen(false)}><span className="side-icon"><Link2 size={16} strokeWidth={1.8} /></span><span>View store</span></Link>
      {username && <Link className="side-link" href={linkHubHref} target="_blank" onClick={() => setMobileMenuOpen(false)}><span className="side-icon"><Link2 size={16} strokeWidth={1.8} /></span><span>View Link Hub ↗</span></Link>}
      <Link className="side-link" href="/" onClick={() => setMobileMenuOpen(false)}><span style={{width:18,textAlign:'center'}}>←</span><span>Exit studio</span></Link>
    </aside>
    <main className="studio-main">
      <header className="topbar"><button className="mobile-menu-button" aria-label={mobileMenuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(value => !value)}>{mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}</button><div className="muted topbar-title" style={{fontSize:13}}>Your creator workspace</div><div className="topbar-actions"><Link className="btn btn-sm topbar-store-link" href={storeHref}>View store</Link><button className="btn btn-sm" type="button" onClick={() => void handleSignOut()}>Sign out</button><div className="user-chip"><div className={`user-dot ${avatarUrl ? 'user-avatar' : ''}`} style={avatarUrl ? { backgroundImage: `url(${avatarUrl})` } : undefined}/><div style={{display:'flex',alignItems:'center',gap:8}}><span className="pill" style={{fontSize:10,padding:'5px 8px'}}>{PLAN_CONFIG[plan as keyof typeof PLAN_CONFIG]?.label||'Free'} plan</span><span className="user-name" style={{fontSize:12,fontWeight:700}}>{username || userEmail.split('@')[0]}</span></div></div></div></header>
      {children}
    </main>
  </div>;
}
