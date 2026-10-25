import StorefrontClient from '@/components/customer/StorefrontClient';
import '@/app/r/storefront.css';

export default async function StorefrontBranchOrderPage({
  params,
}: {
  params: Promise<{ restaurant: string; branch: string }>;
}) {
  const { restaurant, branch } = await params;
  return <StorefrontClient restaurantSlug={restaurant} initialBranchId={branch} />;
}
