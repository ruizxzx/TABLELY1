import Link from 'next/link';

export default function ButtonLink({ href, children, primary = false, dark = false, small = false }: { href: string; children: React.ReactNode; primary?: boolean; dark?: boolean; small?: boolean }) {
  return <Link className={`btn ${primary ? 'btn-primary' : ''} ${dark ? 'btn-dark' : ''} ${small ? 'btn-sm' : ''}`} href={href}>{children}</Link>;
}
