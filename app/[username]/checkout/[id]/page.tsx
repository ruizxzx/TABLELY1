import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { supabase } from '../../../lib/supabase';
import CheckoutForm from './CheckoutForm';
import { isPublishedNow } from '../../../lib/publication';
import { getCheckoutPath, getProductPath, type PublicSearchParams, withPreservedQuery } from '../../../lib/public-paths';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Secure checkout — TABLELY', robots: { index: false, follow: false } };
}

function formatMoney(value: number, currency: string) {
  if (currency.toUpperCase() === 'INR') return `₹${Number(value).toLocaleString('en-IN')}`;
  return `${currency.toUpperCase()} ${Number(value).toLocaleString('en-IN')}`;
}

type CheckoutPageArgs = {
  params: Promise<{ username: string; id: string }>;
  searchParams?: Promise<PublicSearchParams>;
};

export async function renderCheckoutPage(
  { params, searchParams }: CheckoutPageArgs,
  explicitStorePath = false,
) {
  const { username: rawUsername, id } = await params;
  const username = decodeURIComponent(rawUsername).replace(/^@/, '').toLowerCase();
  const query = searchParams ? await searchParams : undefined;

  if (!explicitStorePath || rawUsername.startsWith('@')) {
    redirect(withPreservedQuery(getCheckoutPath(username, id), query));
  }

  if (!supabase) notFound();

  const { data: store, error: storeError } = await supabase
    .from('stores')
    .select('id, username, name, bio, status')
    .eq('username', username)
    .eq('status', 'active')
    .maybeSingle();
  if (storeError || !store) notFound();

  const { data: product, error: productError } = await supabase
    .from('public_products')
    .select('id, title, slug, description, price, currency, category_id, status, visibility, scheduled_publish_at, digital_delivery_type, delivery_configured')
    .eq('id', id)
    .eq('store_id', store.id)
    .maybeSingle();
  if (productError || !product || !product.delivery_configured || !isPublishedNow(product.scheduled_publish_at)) notFound();
  if (!product.category_id) notFound();

  const formattedPrice = formatMoney(product.price, product.currency);
  return (
    <div className="public-wrap">
      <div className="public-nav">
        <div className="container nav">
          <Link className="logo" href={withPreservedQuery(getProductPath(store.username, product.slug), query)}>
            <span className="logo-mark" /><span>TABLELY</span>
          </Link>
          <span className="muted" style={{ fontSize: 12 }}>Secure checkout</span>
        </div>
      </div>

      <main className="checkout">
        <div className="card checkout-card">
          <span className="pill">Your purchase</span>
          <h1 style={{ fontFamily: 'Space Grotesk', fontSize: 30 }}>{product.title}</h1>
          <p className="muted">{product.description || 'Digital product from this creator.'}</p>
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 18, marginTop: 20 }}>
            <span>Total</span><strong style={{ fontFamily: 'Space Grotesk', fontSize: 22 }}>{formattedPrice}</strong>
          </div>
          <Link href={withPreservedQuery(getProductPath(store.username, product.slug), query)} className="muted" style={{ fontSize: 12, display: 'inline-block', marginTop: 20 }}>
            ← Back to product
          </Link>
        </div>

        <div className="card checkout-card">
          <h2 style={{ fontFamily: 'Space Grotesk' }}>Customer details</h2>
          <CheckoutForm productId={product.id} productTitle={product.title} amount={product.price} currency={product.currency} storeId={store.id} />
        </div>
      </main>
    </div>
  );
}

export default function CheckoutPage({ params, searchParams }: CheckoutPageArgs) {
  return renderCheckoutPage({ params, searchParams });
}
