import Link from 'next/link';
import { Brand } from '@/components/Brand';

export function PublicFooter() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <Brand />
        <span>Restaurant ordering, simplified.</span>
        <div className="footer-links">
          <Link href="/contact">Contact</Link>
          <Link href="/vision">My Vision</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/admin-access" className="footer-admin-link" aria-label="Platform admin">·</Link>
        </div>
      </div>
    </footer>
  );
}
