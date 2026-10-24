import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getAppBaseUrl } from '../../../lib/site';
import { supabase } from '../../../lib/supabase';
import { getBundleCheckoutPath, getBundlePath, type PublicSearchParams, withPreservedQuery } from '../../../lib/public-paths';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ username: string; slug: string }> }): Promise<Metadata> {
  const { username: rawUsername, slug } = await params;
  const username = decodeURIComponent(rawUsername).replace(/^@/, '').toLowerCase();
  if (!supabase) return { title: 'Bundle unavailable — TABLELY', robots: { index: false, follow: false } };
  const { data: store } = await supabase.from('stores').select('id,name,status').eq('username', username).eq('status', 'active').maybeSingle();
  if (!store) return { title: 'Bundle unavailable — TABLELY', robots: { index: false, follow: false } };
  const { data: bundle } = await supabase.from('bundles').select('title,description,status').eq('store_id', store.id).eq('slug', slug).eq('status', 'live').maybeSingle();
  if (!bundle) return { title: 'Bundle unavailable — TABLELY', robots: { index: false, follow: false } };
  const canonical = `${getAppBaseUrl()}${getBundlePath(username, slug)}`;
  const description = bundle.description || `A digital bundle from ${store.name}.`;
  return { title: `${bundle.title} — ${store.name}`, description, alternates: { canonical }, openGraph: { title: `${bundle.title} — ${store.name}`, description, url: canonical, type: 'website' } };
}

type BundlePageArgs = {
  params: Promise<{ username: string; slug: string }>;
  searchParams?: Promise<PublicSearchParams>;
};

export async function renderBundlePage(
  { params, searchParams }: BundlePageArgs,
  explicitStorePath = false,
) {
  const { username: rawUsername, slug } = await params;
  const username = decodeURIComponent(rawUsername).replace(/^@/, '').toLowerCase();
  const query = searchParams ? await searchParams : undefined;

  if (!explicitStorePath || rawUsername.startsWith('@')) {
    redirect(withPreservedQuery(getBundlePath(username, slug), query));
  }

  if (!supabase) notFound();

  const { data: store } = await supabase
    .from('stores')
    .select('id,name,username')
    .eq('username', username)
    .eq('status', 'active')
    .maybeSingle();
  if (!store) notFound();

  const { data: bundle } = await supabase
    .from('bundles')
    .select('id,title,slug,description,price,currency,status')
    .eq('store_id', store.id)
    .eq('slug', slug)
    .eq('status', 'live')
    .maybeSingle();
  if (!bundle) notFound();

  const { data: itemRows } = await supabase
    .from('bundle_items')
    .select('product_id')
    .eq('bundle_id', bundle.id);
  const ids = (itemRows || []).map((x: any) => x.product_id).filter(Boolean);
  const { data: products } = ids.length
    ? await supabase.from('public_products').select('id,title,short_description,price').in('id', ids)
    : { data: [] };
  const byId = new Map((products || []).map((x: any) => [x.id, x]));
  const items = (itemRows || []).map((x: any) => ({ ...x, products: byId.get(x.product_id) || null }));

  return (
    <main className="detail">
      <div className="container-narrow">
        <div className="eyebrow">BUNDLE</div>
        <h1 style={{ fontFamily: 'Space Grotesk', fontSize: 48 }}>{bundle.title}</h1>
        <p className="detail-subtitle muted">{bundle.description || 'A collection of digital products.'}</p>
        <div className="card product-info-card">
          <b>Includes</b>
          {(items || []).map((x: any) => {
            const product = Array.isArray(x.products) ? x.products[0] : x.products;
            return (
              <div key={x.product_id} className="mini-list-row">
                <span>{product?.title || 'Product'}</span>
                <span>₹{Number(product?.price || 0).toLocaleString('en-IN')}</span>
              </div>
            );
          })}
        </div>
        <div className="price-stack"><span className="price-big">₹{Number(bundle.price).toLocaleString('en-IN')}</span></div>
        <Link className="btn btn-primary btn-large" href={withPreservedQuery(getBundleCheckoutPath(store.username, bundle.id), query)}>
          Buy bundle →
        </Link>
      </div>
    </main>
  );
}

export default function BundlePage({ params, searchParams }: BundlePageArgs) {
  return renderBundlePage({ params, searchParams });
}
