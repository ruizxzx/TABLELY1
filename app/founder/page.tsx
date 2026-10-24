import Link from 'next/link';
import type { Metadata } from 'next';
import PublicNav from '../components/PublicNav';
import PublicFooter from '../components/PublicFooter';
import { getPublishedContent } from '../lib/public-content';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const content = await getPublishedContent('founder');
  return { title: content?.seo_title || 'From the Founder', description: content?.seo_description || 'A note from the founder of TABLELY.' };
}

export default async function FounderPage() {
  const content = await getPublishedContent('founder');
  const x = content?.content || {};
  const paragraphs = Array.isArray(x.body) ? x.body : x.body ? [x.body] : [];
  const sections = Array.isArray(x.sections) ? x.sections : [];
  const links = Array.isArray(x.links) ? x.links : [];
  return <><PublicNav/><main className="founder-page"><div className="container founder-layout"><article className="founder-copy"><span className="pill">{x.eyebrow || 'FROM THE FOUNDER'}</span><h1>{x.title || 'A note from the founder.'}</h1>{x.intro && <p className="lead">{x.intro}</p>}{x.quote && <blockquote>{x.quote}</blockquote>}{paragraphs.map((paragraph:any,index:number)=><p key={index}>{String(paragraph)}</p>)}{sections.map((section:any,index:number)=><section className="founder-section" key={index}><h2>{section.heading || section.title}</h2>{Array.isArray(section.body) ? section.body.map((paragraph:any,i:number)=><p key={i}>{String(paragraph)}</p>) : section.body && <p>{String(section.body)}</p>}</section>)}{links.length>0&&<div className="founder-links">{links.map((link:any,index:number)=><Link className="btn" href={String(link.href || '#')} key={index}>{link.label || link.href} ↗</Link>)}</div>}{x.signature && <p className="founder-signature">{x.signature}</p>}</article><aside className="founder-aside">{x.photoUrl ? <img src={String(x.photoUrl)} alt={String(x.photoAlt || 'Founder')} /> : <div className="founder-photo-placeholder">{String(x.photoPlaceholder || 'Your photo')}</div>}{x.photoCaption && <p>{x.photoCaption}</p>}</aside></div></main><PublicFooter/></>;
}