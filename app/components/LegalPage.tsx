import PublicNav from './PublicNav';
import PublicFooter from './PublicFooter';

export default function LegalPage({ content }: { content: any }) {
  const c = content?.content || {};
  return (
    <>
      <PublicNav />
      <main className="legal-page">
        <div className="container legal-inner">
          <span className="pill">TABLELY</span>
          <h1>{content?.title}</h1>
          <p className="muted">Last updated: {c.lastUpdated || 'Not specified'}</p>
          {(c.sections || []).map((s: any) => (
            <section className="legal-section" key={s.heading}>
              <h2>{s.heading}</h2>
              <p>{s.body}</p>
            </section>
          ))}
          {c.contact && (
            <div className="card panel legal-contact">
              <b>Contact</b>
              <p><a className="form-link" href={`mailto:${c.contact}`}>{c.contact}</a></p>
            </div>
          )}
        </div>
      </main>
      <PublicFooter />
    </>
  );
}
