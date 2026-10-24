import type { ReactNode } from 'react';

export default function BentoPublicShell({ children }: { children: ReactNode }) {
  return <div className="bento-public-shell">{children}</div>;
}
