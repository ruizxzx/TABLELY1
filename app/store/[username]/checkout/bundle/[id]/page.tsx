export { generateMetadata } from '../../../../../[username]/checkout/bundle/[id]/page';
import { renderBundleCheckoutPage } from '../../../../../[username]/checkout/bundle/[id]/page';

export const dynamic = 'force-dynamic';

export default function StoreBundleCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string; id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return renderBundleCheckoutPage({ params, searchParams }, true);
}
