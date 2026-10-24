import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Logo from '../components/Logo';
import AnalyticsBeacon from '../components/AnalyticsBeacon';
import EmailCapture from '../components/EmailCapture';
import { supabase } from '../lib/supabase';
import { publicMediaUrl } from '../lib/storage';
import { getAppBaseUrl } from '../lib/site';
import { getLinkHubPath, getPrimaryPublicPage, getProductPath, getStorePath, getBundlePath, withPreservedQuery, type PublicSearchParams } from '../lib/public-paths';
import { PUBLIC_CONTENT_SAFETY_LIMITS } from '../lib/public-limits';
import { generateMetadata as generateLinkHubMetadata, renderLinkHubPage } from '../lib/link-hub';

export const dynamic = 'force-dynamic';

export async function generateStoreMetadata({ params }: { params: Promise<{ username: string }> }, explicitStorePath = false): Promise<Metadata> {
  const rawUsername = decodeURIComponent((await params).username);
  const username = rawUsername.replace(/^@/, '').toLowerCase();
  if (!supabase) return { title: 'Store unavailable — TABLELY' };
  const { data } = await supabase.from('stores').select('name,bio,status,link_hub_config').eq('username', username).maybeSingle();
  if (!data || data.status !== 'active') return { title: 'Store not found — TABLELY' };
  const primaryPage = getPrimaryPublicPage(data.link_hub_config?.primaryPage);
  if (!explicitStorePath && primaryPage === 'linkhub') return generateLinkHubMetadata({ params });
  const canonicalPath = explicitStorePath ? getStorePath(username, 'linkhub') : getStorePath(username, primaryPage);
  const canonical = `${getAppBaseUrl()}${canonicalPath}`;
  const description = data.bio || `Digital products from ${data.name}.`;
  return { title: `${data.name} — TABLELY`, description, alternates: { canonical }, openGraph: { title: `${data.name} — TABLELY`, description, url: canonical, type: 'website' } };
}

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  return generateStoreMetadata({ params });
}

export async function renderStorePage({ params, searchParams }: { params: Promise<{ username: string }>; searchParams?: Promise<PublicSearchParams> }, explicitStorePath = false) {
  const rawUsername = decodeURIComponent((await params).username);
  const username = rawUsername.replace(/^@/, '').toLowerCase();
  if (!supabase) notFound();
  const { data: store, error } = await supabase.from('stores').select('*').eq('username', username).maybeSingle();
  if (error || !store || store.status !== 'active') notFound();
  const primaryPage = getPrimaryPublicPage(store.link_hub_config?.primaryPage);
  if (rawUsername.startsWith('@')) redirect(withPreservedQuery(`/${username}`, searchParams ? await searchParams : undefined));
  if (!explicitStorePath && primaryPage === 'linkhub') return renderLinkHubPage({ params: Promise.resolve({ username }), searchParams }, true);

  const [{ data: products }, { data: bundles }] = await Promise.all([
    supabase.from('public_products').select('id,title,slug,short_description,description,price,compare_at_price,currency,category_name,category_id,cover_image_path,status,sort_order').eq('store_id', store.id).order('sort_order', { ascending: true }).order('updated_at', { ascending: false }).limit(PUBLIC_CONTENT_SAFETY_LIMITS.storeProducts),
    supabase.from('bundles').select('id,title,slug,description,price,currency,status').eq('store_id', store.id).eq('status', 'live').order('created_at', { ascending: false }).limit(PUBLIC_CONTENT_SAFETY_LIMITS.storeBundles),
  ]);

  const visible = products || [];
  const cats = Array.from(new Map(visible.filter((product: any) => product.category_id).map((product: any) => [product.category_id, {
    id: product.category_id,
    name: product.category_name || 'Products',
    slug: `category-${product.category_id}`,
  }])).values());
  const byCategory = new Map<string, any[]>();
  visible.forEach((product: any) => { const list = byCategory.get(product.category_id) || []; list.push(product); byCategory.set(product.category_id, list); });
  const featured = store.featured_product_id ? visible.find((product: any) => product.id === store.featured_product_id) : visible[0];
  const theme = { background: '#f7f6fb', accent: '#674fcb', text: '#17151f', buttonRadius: 14, cardRadius: 22, buttonStyle: 'solid', cardStyle: 'soft', layout: 'centered', font: 'Inter', sections: ['hero', 'featured', 'products', 'email'], ...(store.theme_config || {}) };
  const avatar = publicMediaUrl(store.avatar_url?.startsWith?.('http') ? null : store.avatar_url);
  const show = (key: string) => theme.sections?.includes(key);

  return <div className="public-wrap" style={{ background: theme.background, color: theme.text, fontFamily: theme.font === 'Georgia' ? 'Georgia,serif' : 'Inter,sans-serif' }}>
    <AnalyticsBeacon storeId={store.id} eventType="visit" />
    <div className="public-nav"><div className="container nav"><Logo /><div className="nav-actions">{store.link_hub_config?.enabled !== false && <Link className="btn btn-sm" href={getLinkHubPath(store.username, primaryPage)}>← View Links</Link>}<Link className="btn btn-sm" href="/login">Creator login</Link></div></div></div>
    <main className={`store-page store-layout-${theme.layout}`}>
      {show('hero') && <div className="store-hero-card card"><div className="store-profile">{avatar ? <img src={avatar} alt="" className="store-avatar" style={{ objectFit: 'cover' }} /> : <div className="store-avatar" />}<div className="pill" style={{ background: `${theme.accent}18`, color: theme.accent }}>@{store.username}</div><h1>{store.name}</h1><p className="muted store-bio">{store.bio || 'Digital products from this creator.'}</p><div className="social-row">{store.social_links?.instagram && <a className="social-dot" href={store.social_links.instagram} target="_blank" rel="noreferrer">◎</a>}{store.social_links?.youtube && <a className="social-dot" href={store.social_links.youtube} target="_blank" rel="noreferrer">◉</a>}{store.social_links?.github && <a className="social-dot" href={store.social_links.github} target="_blank" rel="noreferrer">◌</a>}</div></div></div>}
      {cats.length > 0 && <nav className="category-nav" aria-label="Product categories">{cats.map((category: any) => <a key={category.id} href={`#category-${category.slug}`} className="btn btn-sm">{category.name}</a>)}</nav>}
      {show('featured') && featured && <section className="featured-store" style={{ borderRadius: theme.cardRadius, background: theme.text, color: '#fff' }}><div className="featured-media">{featured.cover_image_path ? <img src={publicMediaUrl(featured.cover_image_path) || ''} alt="" /> : <div className="cover" />}</div><div className="featured-copy"><div className="eyebrow">FEATURED</div><h2>{featured.title}</h2><p>{featured.short_description || featured.description || 'A digital product designed to be useful immediately.'}</p><div className="featured-meta"><div className="price">₹{Number(featured.price).toLocaleString('en-IN')}</div><Link className="btn btn-primary" style={{ background: theme.accent, borderRadius: theme.buttonRadius }} href={getProductPath(store.username, featured.slug, primaryPage)}>View product →</Link></div></div></section>}
      {bundles && bundles.length > 0 && <section style={{ margin: '32px 0' }}><div className="store-section-head"><div><div className="eyebrow">BUNDLES</div><h2>Collections</h2></div></div><div className="store-grid">{bundles.map((bundle: any) => <Link key={bundle.id} href={getBundlePath(store.username, bundle.slug, primaryPage)} className="store-product" style={{ borderRadius: theme.cardRadius }}><div className="cover" /><div className="content"><div className="muted store-category">Bundle</div><h3>{bundle.title}</h3><p>{bundle.description || 'A curated collection.'}</p><div className="price-row"><span className="price">₹{Number(bundle.price).toLocaleString('en-IN')}</span><span className="btn btn-sm btn-primary" style={{ background: theme.accent, borderRadius: theme.buttonRadius }}>View bundle</span></div></div></Link>)}</div></section>}
      {show('products') && <section><div className="store-section-head"><div><div className="eyebrow">SHOP</div><h2>Digital products</h2></div></div>{visible.length === 0 ? <div className="card panel empty-public">Your store is empty. Add your first digital product from TABLELY Studio.</div> : <div>{cats.map((category: any) => { const list = byCategory.get(category.id) || []; return <section key={category.id} id={`category-${category.slug}`} style={{ marginBottom: 36, scrollMarginTop: 90 }}><div className="store-section-head"><div><div className="eyebrow">CATEGORY</div><h2>{category.name}</h2>{category.description && <p className="muted">{category.description}</p>}</div></div>{list.length === 0 ? <div className="card panel empty-public">No published products in this category.</div> : <div className="store-grid">{list.map((product: any) => <Link key={product.id} href={getProductPath(store.username, product.slug, primaryPage)} className={`store-product card-style-${theme.cardStyle}`} style={{ borderRadius: theme.cardRadius }}>{publicMediaUrl(product.cover_image_path) ? <img src={publicMediaUrl(product.cover_image_path) || ''} alt="" className="cover" style={{ objectFit: 'cover' }} /> : <div className="cover" />}<div className="content"><div className="muted store-category">{category.name}</div><h3>{product.title}</h3><p>{product.short_description || product.description || 'A useful digital product from this creator.'}</p><div className="price-row"><span className="price">₹{Number(product.price).toLocaleString('en-IN')}</span><span className="btn btn-sm btn-primary" style={{ background: theme.accent, borderRadius: theme.buttonRadius }}>View product</span></div></div></Link>)}</div>}</section>; })}</div>}</section>}
      {show('email') && store.email_collection_enabled !== false && <EmailCapture storeId={store.id} />}
    </main>
  </div>;
}

export default function StorePage({ params, searchParams }: { params: Promise<{ username: string }>; searchParams?: Promise<PublicSearchParams> }) {
  return renderStorePage({ params, searchParams });
}
