import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, Mail, MapPin, Clock3 } from 'lucide-react';
import { ContactForm } from '@/components/public/ContactForm';
import { PublicFooter } from '@/components/public/PublicFooter';
import { defaultContact, normalizeContact } from '@/lib/public-content';
import { getPublishedContent } from '@/lib/public-content-server';

export const metadata: Metadata = { title: 'TABLELY Contact', description: 'Contact TABLELY about your restaurant setup.' };

export default async function ContactPage() {
  const content = normalizeContact(await getPublishedContent('contact', defaultContact));
  return (
    <div className="public-page">
      <header className="public-topbar">
        <div className="container public-topbar-inner"><Link href="/" className="back-link"><ArrowLeft size={15} /> Back to TABLELY</Link><span className="public-topbar-label">TABLELY ENTERPRISE</span></div>
      </header>
      <main className="public-contact-main">
        <section className="public-contact-hero container">
          <div className="public-contact-copy">
            <span className="eyebrow">{content.eyebrow}</span>
            <h1>{content.title}</h1>
            <p>{content.description}</p>
            <div className="public-contact-meta">
              <a href={`mailto:${content.email}`}><Mail size={17} /><span><b>Email</b>{content.email}</span></a>
              <div><MapPin size={17} /><span><b>Based in</b>{content.location}</span></div>
              <div><Clock3 size={17} /><span><b>Response time</b>{content.response_time}</span></div>
            </div>
          </div>
          <ContactForm content={content} />
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
