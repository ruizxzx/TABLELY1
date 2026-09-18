import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { PublicFooter } from '@/components/public/PublicFooter';
import { defaultPrivacy, getPublishedContent, normalizeLegal } from '@/lib/public-content';

export const metadata: Metadata = { title: 'TABLELY Privacy Policy' };

export default async function PrivacyPage() {
  const content = normalizeLegal(await getPublishedContent('privacy', defaultPrivacy), defaultPrivacy);
  return <div className="public-page"><main className="legal-page"><div className="legal-panel"><Link href="/" className="back-link"><ArrowLeft size={15} /> Back to TABLELY</Link><div className="eyebrow">TABLELY</div><h1>{content.title}</h1><p className="legal-updated">Published content · Managed by TABLELY</p><p>{content.intro}</p>{content.sections.map(section => <section key={section.heading}><h2>{section.heading}</h2>{section.body.split(/\n{2,}/).map((paragraph,index)=><p key={`${section.heading}-${index}`}>{paragraph}</p>)}</section>)}</div></main><PublicFooter /></div>;
}
