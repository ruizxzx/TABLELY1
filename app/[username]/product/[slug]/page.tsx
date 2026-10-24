import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { supabase } from '../../../lib/supabase';
import { publicMediaUrl } from '../../../lib/storage';
import AnalyticsBeacon from '../../../components/AnalyticsBeacon';
import { getAppBaseUrl } from '../../../lib/site';
import { getCheckoutPath, getPrimaryPublicPage, getProductPath, getStorePath, withPreservedQuery, type PublicSearchParams } from '../../../lib/public-paths';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ username: string; slug: string }> }): Promise<Metadata> {
  const { username: rawUsername, slug } = await params;
  const username = decodeURIComponent(rawUsername).replace(/^@/, '').toLowerCase();
  if (!supabase) return { title: 'Product unavailable — TABLELY' };
  const { data: store } = await supabase.from('stores').select('id,name,status,link_hub_config').eq('username', username).maybeSingle();
  if (!store || store.status !== 'active') return { title: 'Product unavailable — TABLELY' };
  const { data: product } = await supabase.from('public_products').select('title,short_description,description,status,visibility,category_id').eq('store_id', store.id).eq('slug', slug).maybeSingle();
  if (!product || product.status !== 'live' || product.visibility !== 'public' || !product.category_id) return { title: 'Product unavailable — TABLELY' };
  const canonical = `${getAppBaseUrl()}${getProductPath(username, slug)}`;
  return { title: `${product.title} — ${store.name}`, description: product.short_description || product.description || `Digital product from ${store.name}.`, alternates: { canonical }, openGraph: { title: `${product.title} — ${store.name}`, description: product.short_description || product.description || `Digital product from ${store.name}.`, url: canonical, type: 'website' }, twitter: { card: 'summary_large_image', title: `${product.title} — ${store.name}`, description: product.short_description || product.description || `Digital product from ${store.name}.` } };
}

export async function renderProductPage({ params, searchParams }: { params: Promise<{ username: string; slug: string }>; searchParams?: Promise<PublicSearchParams> }, explicitStorePath = false) {
  const { username: rawUsername, slug } = await params;
  const username = decodeURIComponent(rawUsername).replace(/^@/, '').toLowerCase();
  if (!supabase) notFound();
  const { data: store } = await supabase.from('stores').select('id,username,name,bio,status,theme_config,link_hub_config').eq('username', username).maybeSingle();
  if (!store || store.status !== 'active') notFound();
  const primaryPage = getPrimaryPublicPage(store.link_hub_config?.primaryPage);
  if (rawUsername.startsWith('@') || !explicitStorePath) redirect(withPreservedQuery(getProductPath(username, slug), searchParams ? await searchParams : undefined));
  const { data: product, error } = await supabase.from('public_products').select('*').eq('store_id', store.id).eq('slug', slug).maybeSingle();
  if (error || !product || !product.category_id) notFound();
  const category = { id: product.category_id, name: product.category_name, status: 'live', is_visible: true };
  if (!product.delivery_configured) notFound();
  const coverUrl = publicMediaUrl(product.cover_image_path);
  const theme = { accent: '#674fcb', background: '#f7f6fb', text: '#17151f', buttonRadius: 14, ...(store.theme_config || {}) };
  const { data: upsellRows } = await supabase.from('upsells').select('id,headline,discount_percent,upsell_product_id').eq('product_id', product.id).eq('status','active').limit(3);
  const { data: reviews } = await supabase.from('product_reviews').select('id,rating,review,customer_email,created_at,creator_response').eq('product_id', product.id).eq('status', 'approved').order('created_at', { ascending: false }).limit(20);
  const upsellIds=(upsellRows||[]).map((u:any)=>u.upsell_product_id).filter(Boolean);
  const { data: upsellProducts } = upsellIds.length ? await supabase.from('public_products').select('id,title,slug,price,short_description').in('id',upsellIds) : { data: [] };
  const upsellMap=new Map((upsellProducts||[]).map((p:any)=>[p.id,p]));
  const upsells=(upsellRows||[]).map((u:any)=>({...u,products:upsellMap.get(u.upsell_product_id)||null}));
  const discounted = product.compare_at_price && product.compare_at_price > product.price;

  return <div className="public-wrap" style={{background:theme.background,color:theme.text}}> <AnalyticsBeacon storeId={store.id} productId={product.id} eventType="product_view" /> <div className="public-nav"><div className="container nav"><Link className="logo" href={getStorePath(store.username, primaryPage)}><span className="logo-mark"/><span>TABLELY</span></Link><Link className="btn btn-sm" href={getStorePath(store.username, primaryPage)}>← Store</Link></div></div>
    <main className="detail-grid">
      <div className="detail-media">{coverUrl ? <img src={coverUrl} alt="" className="detail-cover" style={{objectFit:'cover'}}/> : <div className="detail-cover"/>}</div>
      <div className="detail-panel"><div className="pill">{product.category_name || 'Digital product'}</div><h1>{product.title}</h1><p className="detail-subtitle">{product.short_description || product.description || 'A focused digital product designed to be useful immediately.'}</p><div className="price-stack"><span className="price-big">₹{Number(product.price).toLocaleString('en-IN')}</span>{discounted && <><span className="compare-price big">₹{Number(product.compare_at_price).toLocaleString('en-IN')}</span><span className="discount-chip">SAVE {Math.round((1-product.price/product.compare_at_price)*100)}%</span></>}</div><ul className="list"><li>✓ {product.digital_delivery_type === 'link' ? 'Access link delivered after verified payment' : 'Instant digital delivery after payment'}</li><li>✓ Secure time-limited access</li><li>✓ Purchase receipt sent by email</li><li>✓ Sold by {store.name}</li></ul><div className="card product-info-card"><div><b>What's included</b><p className="muted">{product.product_type || 'Digital product'} · {product.digital_delivery_type === 'link' ? 'External access link' : 'Downloadable file'}</p></div>{product.license && <div><b>License</b><p className="muted">{product.license}</p></div>}{product.refund_policy && <div><b>Refund policy</b><p className="muted">{product.refund_policy}</p></div>}</div>{product.has_preview && <div className="row-actions" style={{marginTop:12}}><a className="btn" target="_blank" rel="noreferrer" href={`/api/products/${encodeURIComponent(product.id)}/preview`}>Preview</a><a className="btn" href={`/api/products/${encodeURIComponent(product.id)}/preview?download=1`}>Download preview</a></div>}<Link className="btn btn-primary btn-large" style={{background:theme.accent,borderRadius:theme.buttonRadius}} href={getCheckoutPath(store.username, product.id, primaryPage)}>Buy for ₹{Number(product.price).toLocaleString('en-IN')} →</Link><p className="muted secure-note">Secure checkout. Delivery is unlocked only after verified payment.</p></div>
    </main>
    {upsells && upsells.length > 0 && <section className="container-narrow"><div className="eyebrow">YOU MAY ALSO LIKE</div><h2 style={{fontFamily:'Space Grotesk',fontSize:30}}>Complete your setup</h2><div className="store-grid">{upsells.map((u:any)=>{const p=Array.isArray(u.products)?u.products[0]:u.products;return p?<Link key={u.id} href={getProductPath(store.username, p.slug, primaryPage)} className="store-product"><div className="cover"/><div className="content"><div className="muted">Recommended</div><h3>{p.title}</h3><p>{u.headline||p.short_description||'Another useful product from this creator.'}</p><div className="price-row"><span className="price">₹{Number(p.price).toLocaleString('en-IN')}</span></div></div></Link>:null})}</div></section>}
    {reviews?.length ? <section className="container-narrow" style={{ marginTop: 28 }}><div className="eyebrow">CUSTOMER REVIEWS</div><h2>What buyers say</h2><div className="dashboard-grid">{reviews.map((review: any) => <article className="card panel" key={review.id}><div style={{ color: '#d7653f', letterSpacing: 2 }}>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</div><p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{review.review}</p><small className="muted">Verified buyer · {new Date(review.created_at).toLocaleDateString('en-IN')}</small>{review.creator_response && <div className="info-note" style={{ marginTop: 12 }}><b>Creator response</b><p>{review.creator_response}</p></div>}</article>)}</div></section> : null}
    <section className="detail-description container-narrow"><div className="eyebrow">ABOUT THIS PRODUCT</div><h2>What you’ll get</h2><div className="rich-copy">{product.description ? product.description.split('\n').map((line:string, i:number)=><p key={i}>{line || '\u00a0'}</p>) : <p className="muted">The creator hasn't added a detailed description yet.</p>}</div></section>
  </div>;
}

export default function ProductPage({ params, searchParams }: { params: Promise<{ username: string; slug: string }>; searchParams?: Promise<PublicSearchParams> }) {
  return renderProductPage({ params, searchParams });
}
