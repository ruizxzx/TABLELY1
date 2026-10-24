export { generateMetadata } from '../../../../[username]/product/[slug]/page';
import { renderProductPage } from '../../../../[username]/product/[slug]/page';
import type { PublicSearchParams } from '../../../../lib/public-paths';

export const dynamic = 'force-dynamic';

export default function ExplicitStoreProductPage({ params, searchParams }: { params: Promise<{ username: string; slug: string }>; searchParams?: Promise<PublicSearchParams> }) {
  return renderProductPage({ params, searchParams }, true);
}