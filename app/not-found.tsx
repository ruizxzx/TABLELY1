import Link from 'next/link';

export default function NotFound() {
  return <main style={{minHeight:'100vh',display:'grid',placeItems:'center',padding:32}}>
    <div className="card panel" style={{maxWidth:560,textAlign:'center'}}>
      <div className="eyebrow">404</div>
      <h1 style={{marginTop:8}}>Page not found</h1>
      <p className="muted">The page or storefront you requested does not exist or is no longer available.</p>
      <Link className="btn btn-primary" href="/">Return to TABLELY</Link>
    </div>
  </main>;
}
