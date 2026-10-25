import StorefrontCheckoutClient from '@/components/customer/StorefrontCheckoutClient';
import '@/app/r/storefront.css';

export default async function StorefrontCheckoutPage({
  params,
}: {
  params: Promise<{ restaurant: string }>;
}) {
  const { restaurant } = await params;
  return <StorefrontCheckoutClient restaurantSlug={restaurant} />;
}
