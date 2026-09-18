import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { PublicFooter } from '@/components/public/PublicFooter';
import { defaultVision, getPublishedContent, normalizeVision } from '@/lib/public-content';

export const metadata: Metadata = { title: 'TABLELY — My Vision', description: 'The vision behind TABLELY.' };

export default async function VisionPage() {
  const content = normalizeVision(await getPublishedContent('vision', defaultVision));
  return (
    <div className="public-page">
      <header className="public-topbar"><div className="container public-topbar-inner"><Link href="/" className="back-link"><ArrowLeft size={15} /> Back to TABLELY</Link><span className="public-topbar-label">MY VISION</span></div></header>
      <main className="vision-main">
        <section className="vision-hero container">
          <div className="vision-hero-copy"><span className="eyebrow">{content.eyebrow}</span><h1>{content.title}</h1><p>{content.intro}</p></div>
          <div className="vision-founder-card">
            {content.founder.image_url ? <img src={content.founder.image_url} alt={content.founder.name} /> : <div className="vision-founder-placeholder"><span>{content.founder.name.split(' ').map(part => part[0]).join('').slice(0,2)}</span></div>}
            <div><span className="eyebrow">FOUNDER</span><h2>{content.founder.name}</h2><p className="vision-founder-title">{content.founder.title}</p><p>{content.founder.bio}</p><blockquote>“{content.founder.quote}”</blockquote></div>
          </div>
        </section>

        <section className="vision-section container"><div className="vision-section-copy"><span className="eyebrow">01</span><h2>{content.vision_heading}</h2><p>{content.vision_body}</p></div><div className="vision-signal"><div className="vision-signal-orbit"><span>TABLELY</span></div></div></section>

        <section className="vision-section vision-section-soft container"><div className="vision-section-copy"><span className="eyebrow">02</span><h2>{content.problem_heading}</h2><div className="vision-list">{content.problem_items.map(item => <div key={item}><Check size={16}/><span>{item}</span></div>)}</div></div><div className="vision-idea-card"><span className="eyebrow">THE IDEA</span><h3>{content.idea_heading}</h3><p>{content.idea_body}</p><div className="vision-flow"><strong>Customer</strong>{content.customer_flow.map((item,index)=><span key={`${item}-${index}`}><ArrowRight size={14}/>{item}</span>)}</div><div className="vision-flow"><strong>Restaurant</strong>{content.restaurant_flow.map((item,index)=><span key={`${item}-${index}`}><ArrowRight size={14}/>{item}</span>)}</div></div></section>

        <section className="vision-section container"><div className="vision-section-copy"><span className="eyebrow">03</span><h2>{content.build_heading}</h2><p>{content.build_body}</p></div><div className="vision-principles">{content.principles.map(principle => <article className="surface-card" key={principle.title}><span className="eyebrow">{principle.title}</span><p>{principle.copy}</p></article>)}</div></section>
      </main>
      <PublicFooter />
    </div>
  );
}
