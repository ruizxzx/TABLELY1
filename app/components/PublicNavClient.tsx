'use client';

import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import Logo from './Logo';
import ButtonLink from './ButtonLink';

export default function PublicNavClient({ nav }: { nav: Array<{ label: string; href: string }> }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return <>
    <div className="container nav">
      <Link href="/" onClick={close}><Logo /></Link>
      <nav className="nav-links" aria-label="Primary navigation">{nav.map(item => <Link key={item.label} href={item.href}>{item.label}</Link>)}</nav>
      <div className="nav-actions"><ButtonLink href="/login" small>Log in</ButtonLink><ButtonLink href="/signup" primary small>Get started</ButtonLink></div>
      <button className="public-nav-toggle" aria-label={open ? 'Close navigation' : 'Open navigation'} aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? <X size={21} /> : <Menu size={21} />}</button>
    </div>
    {open && <div className="public-mobile-menu"><nav aria-label="Mobile navigation">{nav.map(item => <Link key={item.label} href={item.href} onClick={close}>{item.label}</Link>)}</nav><div className="public-mobile-actions"><ButtonLink href="/login" small>Log in</ButtonLink><ButtonLink href="/signup" primary small>Get started</ButtonLink></div></div>}
  </>;
}