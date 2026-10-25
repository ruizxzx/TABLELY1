import StorefrontClient from '@/components/customer/StorefrontClient';
import '@/app/r/storefront.css';

export default async function StorefrontOrderPage({
  params,
}: {
  params: Promise<{ restaurant: string }>;
}) {
  const { restaurant } = await params;
  return <StorefrontClient restaurantSlug={restaurant} />;
}
