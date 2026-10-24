import type { Metadata } from 'next';
import BentoPreviewClient from './preview-client';

export const metadata: Metadata = {
  title: 'TABLELY Preview',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-static';

export default function BentoPreviewPage() {
  return <BentoPreviewClient />;
}
