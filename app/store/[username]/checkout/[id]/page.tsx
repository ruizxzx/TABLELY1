export { generateMetadata } from '../../../../[username]/checkout/[id]/page';
import { renderCheckoutPage } from '../../../../[username]/checkout/[id]/page';

export const dynamic = 'force-dynamic';

export default function StoreCheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string; id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return renderCheckoutPage({ params, searchParams }, true);
}
