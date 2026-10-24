import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { supabase } from '../../../../lib/supabase';
import BundleCheckoutForm from './BundleCheckoutForm';
import { getBundleCheckoutPath, getStorePath, type PublicSearchParams, withPreservedQuery } from '../../../../lib/public-paths';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Secure bundle checkout — TABLELY', robots: { index: false, follow: false } };
}

type BundleCheckoutPageArgs = {
  params: Promise<{ username: string; id: string }>;
  searchParams?: Promise<PublicSearchParams>;
};

export async function renderBundleCheckoutPage(
  { params, searchParams }: BundleCheckoutPageArgs,
  explicitStorePath = false,
) {
  const { username: rawUsername, id } = await params;
  const username = decodeURIComponent(rawUsername).replace(/^@/, '').toLowerCase();
  const query = searchParams ? await searchParams : undefined;

  if (!explicitStorePath || rawUsername.startsWith('@')) {
    redirect(withPreservedQuery(getBundleCheckoutPath(username, id), query));
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
    .select('id,title,description,price,currency,status')
    .eq('id', id)
    .eq('store_id', store.id)
    .eq('status', 'live')
    .maybeSingle();
  if (!bundle) notFound();

  return (
    <main className="checkout-page">
      <div className="card checkout-card">
        <Link href={withPreservedQuery(getStorePath(store.username), query)}>← Back to store</Link>
        <div className="checkout-grid">
          <div>
            <div className="eyebrow">BUNDLE</div>
            <h1>{bundle.title}</h1>
            <p className="muted">{bundle.description || 'A curated collection from this creator.'}</p>
          </div>
          <div>
            <h2>{bundle.currency.toUpperCase() === 'INR' ? `₹${Number(bundle.price).toLocaleString('en-IN')}` : `${bundle.currency} ${Number(bundle.price).toLocaleString('en-IN')}`}</h2>
            <BundleCheckoutForm bundleId={bundle.id} bundleTitle={bundle.title} amount={Number(bundle.price)} currency={bundle.currency} storeId={store.id} />
          </div>
        </div>
      </div>
    </main>
  );
}

export default function BundleCheckoutPage({ params, searchParams }: BundleCheckoutPageArgs) {
  return renderBundleCheckoutPage({ params, searchParams });
}
